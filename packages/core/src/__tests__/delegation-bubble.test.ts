import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { DelegationCompleteEvent, ToolCall } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]): MockChatResponse => ({
  content: '',
  toolCalls: calls,
  finishReason: 'tool_calls',
});

const deployed = vi.fn(async ({ target }: { target: string }) => `deployed ${target}`);
const deploy = tool({
  name: 'deploy',
  description: 'Deploy a build',
  parameters: z.object({ target: z.string() }),
  requiresApproval: true,
  execute: deployed,
});

const confirm = tool({
  name: 'confirm',
  description: 'Asks the person to confirm',
  parameters: z.object({}),
  execute: async (_args, context) => {
    const answer = await context.interrupt?.({
      reason: 'confirm_release',
      message: 'Ship it?',
      responseSchema: z.object({ ship: z.boolean() }),
    });
    return answer?.ship ? 'confirmed' : 'not confirmed';
  },
});

function backends(scripts: Record<string, MockChatResponse[]>) {
  return Object.fromEntries(
    Object.entries(scripts).map(([name, responses]) => [
      name,
      new MockLLMBackend().setResponses(responses),
    ])
  );
}

describe('approvals of a delegate bubbling up', () => {
  it('pauses the caller with the nested checkpoint and resumes the delegate with the answer', async () => {
    deployed.mockClear();
    const llm = backends({
      inner: [turn(call('i1', 'deploy', { target: 'prod' })), { content: 'shipped' }],
      outer: [turn(call('o1', 'releaser', { task: 'ship prod' })), { content: 'all done' }],
    });
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: llm, retry: false },
    });
    const releaser = new Agent({
      name: 'releaser',
      model: 'inner/m',
      instructions: 'You release.',
      tools: [deploy],
    });
    const completed: DelegationCompleteEvent[] = [];
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'You delegate.',
      tools: [
        agentAsTool(cog, releaser, {
          name: 'releaser',
          description: 'Releases builds',
          approvalMode: 'bubble',
          onDelegationComplete: (event) => completed.push(event),
        }),
      ],
    });

    const paused = await cog.run(lead, { input: 'release', threadId: 't-bubble' });

    expect(paused.status).toBe('paused');
    expect(paused.pendingApprovals).toEqual([
      expect.objectContaining({
        toolCallId: 'o1/i1',
        toolName: 'deploy',
        arguments: { target: 'prod' },
      }),
    ]);
    expect(paused.interrupts).toEqual([
      expect.objectContaining({
        id: 'o1/i1',
        kind: 'approval',
        toolCallId: 'o1/i1',
        details: expect.objectContaining({ subagent: 'releaser' }),
      }),
    ]);
    expect(paused.checkpoint?.turn.children?.o1?.turn.toolCalls[0]?.id).toBe('i1');
    expect(deployed).not.toHaveBeenCalled();
    expect(completed.map((event) => event.status)).toEqual(['paused']);

    const resumed = await cog.resume(lead, 't-bubble', {
      responses: { 'o1/i1': { approved: true } },
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('all done');
    expect(deployed).toHaveBeenCalledWith({ target: 'prod' }, expect.anything());
    const toolMessage = resumed.messages.find((message) => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('shipped');
    expect(completed.map((event) => event.status)).toEqual(['paused', 'completed']);
    await cog.close();
  });

  it('carries approvals and questions across three levels', async () => {
    deployed.mockClear();
    const llm = backends({
      leaf: [
        turn(call('l1', 'confirm', {})),
        turn(call('l2', 'deploy', { target: 'eu' })),
        { content: 'leaf done' },
      ],
      mid: [turn(call('m1', 'leaf', { task: 'deploy eu' })), { content: 'mid done' }],
      top: [turn(call('t1', 'mid', { task: 'handle eu' })), { content: 'top done' }],
    });
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: llm, retry: false },
    });
    const leaf = new Agent({
      name: 'leaf',
      model: 'leaf/m',
      instructions: 'You deploy.',
      tools: [confirm, deploy],
    });
    const mid = new Agent({
      name: 'mid',
      model: 'mid/m',
      instructions: 'You coordinate.',
      tools: [
        agentAsTool(cog, leaf, { name: 'leaf', description: 'Deploys', approvalMode: 'bubble' }),
      ],
    });
    const top = new Agent({
      name: 'top',
      model: 'top/m',
      instructions: 'You lead.',
      tools: [
        agentAsTool(cog, mid, { name: 'mid', description: 'Coordinates', approvalMode: 'bubble' }),
      ],
    });

    const asked = await cog.run(top, { input: 'go', threadId: 't-three' });
    expect(asked.status).toBe('paused');
    expect(asked.interrupts).toEqual([
      expect.objectContaining({
        id: 't1/m1/l1#0',
        kind: 'input',
        message: 'Ship it?',
        details: expect.objectContaining({ subagent: 'mid/leaf' }),
      }),
    ]);

    const approving = await cog.resume(top, 't-three', {
      responses: { 't1/m1/l1#0': { ship: true } },
    });
    expect(approving.status).toBe('paused');
    expect(approving.pendingApprovals?.map((request) => request.toolCallId)).toEqual(['t1/m1/l2']);
    expect(approving.checkpoint?.turn.children?.t1?.turn.children?.m1).toBeDefined();

    const done = await cog.resume(top, 't-three', {
      decisions: { 't1/m1/l2': { approved: true } },
    });
    expect(done.status).toBe('completed');
    expect(done.output).toBe('top done');
    expect(deployed).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('keeps the turn waiting on the delegate while other calls of the turn are decided', async () => {
    deployed.mockClear();
    const llm = backends({
      inner: [turn(call('i1', 'deploy', { target: 'us' })), { content: 'inner done' }],
      outer: [
        turn(call('o1', 'releaser', { task: 'ship' }), call('o2', 'deploy', { target: 'staging' })),
        { content: 'outer done' },
      ],
    });
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: llm, retry: false },
    });
    const releaser = new Agent({
      name: 'releaser',
      model: 'inner/m',
      instructions: 'You release.',
      tools: [deploy],
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'You delegate.',
      tools: [
        deploy,
        agentAsTool(cog, releaser, {
          name: 'releaser',
          description: 'Releases',
          approvalMode: 'bubble',
        }),
      ],
    });
    const first = await cog.run(lead, { input: 'go', threadId: 't-partial' });
    expect(first.pendingApprovals?.map((request) => request.toolCallId)).toEqual(['o2']);

    const second = await cog.resume(lead, 't-partial', { decisions: { o2: { approved: true } } });
    expect(second.status).toBe('paused');
    expect(second.pendingApprovals?.map((request) => request.toolCallId)).toEqual(['o1/i1']);
    expect(second.checkpoint?.turn.decisions.o2).toEqual({ approved: true });
    expect(deployed).not.toHaveBeenCalled();

    const third = await cog.resume(lead, 't-partial', {
      decisions: { 'o1/i1': { approved: false, reason: 'not today' } },
    });
    expect(third.status).toBe('completed');
    expect(deployed).toHaveBeenCalledTimes(1);
    expect(deployed).toHaveBeenCalledWith({ target: 'staging' }, expect.anything());
    await cog.close();
  });

  it('declines the approvals of a delegate by default, as before', async () => {
    deployed.mockClear();
    const llm = backends({
      inner: [turn(call('i1', 'deploy', { target: 'prod' })), { content: 'could not deploy' }],
      outer: [turn(call('o1', 'releaser', { task: 'ship' })), { content: 'reported' }],
    });
    const cog = new Cogitator({ llm: { backends: llm, retry: false } });
    const releaser = new Agent({
      name: 'releaser',
      model: 'inner/m',
      instructions: 'You release.',
      tools: [deploy],
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'You delegate.',
      tools: [agentAsTool(cog, releaser, { name: 'releaser', description: 'Releases' })],
    });
    const result = await cog.run(lead, { input: 'go' });
    expect(result.status).toBe('completed');
    expect(deployed).not.toHaveBeenCalled();
    await cog.close();
  });

  it('hands the approvals of a bubbling delegate to the caller onApproval first', async () => {
    deployed.mockClear();
    const llm = backends({
      inner: [turn(call('i1', 'deploy', { target: 'prod' })), { content: 'shipped' }],
      outer: [turn(call('o1', 'releaser', { task: 'ship' })), { content: 'done' }],
    });
    const cog = new Cogitator({ llm: { backends: llm, retry: false } });
    const releaser = new Agent({
      name: 'releaser',
      model: 'inner/m',
      instructions: 'You release.',
      tools: [deploy],
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'You delegate.',
      tools: [
        agentAsTool(cog, releaser, {
          name: 'releaser',
          description: 'Releases',
          approvalMode: 'bubble',
        }),
      ],
    });
    const onApproval = vi.fn(() => ({ approved: true as const }));
    const result = await cog.run(lead, { input: 'go', onApproval });
    expect(result.status).toBe('completed');
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'deploy' }));
    expect(deployed).toHaveBeenCalledTimes(1);
    await cog.close();
  });
});
