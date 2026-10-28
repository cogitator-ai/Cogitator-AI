import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  DelegatedRunStart,
  DelegatedRunStream,
  RunResult,
  ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';
import { answer, callTools, deferred, scriptedBackend } from './helpers/scripted-backend';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const lookup = tool({
  name: 'lookup',
  description: 'Looks something up',
  parameters: z.object({ q: z.string() }),
  annotations: { readOnlyHint: true },
  execute: async ({ q }) => `found ${q}`,
});

const deploy = tool({
  name: 'deploy',
  description: 'Deploys',
  parameters: z.object({ target: z.string() }),
  requiresApproval: true,
  execute: async ({ target }) => `deployed ${target}`,
});

/** What a delegated run streamed, by the tool call that started it */
interface Heard {
  start: DelegatedRunStart;
  tokens: string[];
  toolCalls: string[];
  toolResults: string[];
  started: number;
  results: RunResult[];
  errors: Error[];
}

function listener(nested?: (start: DelegatedRunStart) => DelegatedRunStream['onDelegatedRun']) {
  const heard: Heard[] = [];
  const onDelegatedRun = (start: DelegatedRunStart): DelegatedRunStream => {
    const entry: Heard = {
      start,
      tokens: [],
      toolCalls: [],
      toolResults: [],
      started: 0,
      results: [],
      errors: [],
    };
    heard.push(entry);
    const own = nested?.(start);
    return {
      onToken: (token) => entry.tokens.push(token),
      onToolCall: (toolCall) => entry.toolCalls.push(toolCall.name),
      onToolResult: (result) => entry.toolResults.push(String(result.result)),
      onRunStart: () => {
        entry.started++;
      },
      onRunComplete: (result) => entry.results.push(result),
      onRunError: (error) => entry.errors.push(error),
      ...(own && { onDelegatedRun: own }),
    };
  };
  return { heard, onDelegatedRun };
}

const lead = (tools: ConstructorParameters<typeof Agent>[0]['tools'] = []) =>
  new Agent({ name: 'lead', model: 'outer/m', instructions: 'You delegate.', tools });

describe('streams of delegated runs', () => {
  it('streams a foreground subagent through what onDelegatedRun returns', async () => {
    const outer = scriptedBackend([
      callTools([
        call('o1', 'agent', { description: 'x', prompt: 'cats?', subagent_type: 'researcher' }),
      ]),
      answer('reported'),
    ]);
    const inner = scriptedBackend([
      callTools([call('i1', 'lookup', { q: 'cats' })]),
      answer('cats are cats'),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { outer: outer.backend, inner: inner.backend }, retry: false },
      subagents: {
        agents: {
          researcher: {
            description: 'Researches',
            prompt: 'You research.',
            tools: ['lookup'],
            model: 'inner/m',
          },
        },
      },
    });
    const { heard, onDelegatedRun } = listener();
    const result = await cog.run(lead([lookup]), { input: 'go', onDelegatedRun });

    expect(result.output).toBe('reported');
    expect(heard).toHaveLength(1);
    const [child] = heard;
    expect(child?.start).toMatchObject({
      parentToolCallId: 'o1',
      parentRunId: result.runId,
      agent: 'researcher',
      background: false,
      depth: 1,
    });
    expect(child?.start.taskId).toMatch(/^agent_/);
    expect(child?.start.threadId).toBe(`subagent_${child?.start.taskId}`);
    expect(child?.tokens.join('')).toBe('cats are cats');
    expect(child?.toolCalls).toEqual(['lookup']);
    expect(child?.toolResults).toEqual(['found cats']);
    expect(child?.started).toBe(1);
    expect(child?.results.map((run) => run.output)).toEqual(['cats are cats']);
    await cog.close();
  });

  it('streams a background subagent, past the call that started it', async () => {
    const outer = scriptedBackend([
      callTools([
        call('o1', 'agent', {
          description: 'x',
          prompt: 'dig',
          subagent_type: 'digger',
          run_in_background: true,
        }),
      ]),
      answer('waiting'),
      answer('found gold'),
    ]);
    const inner = scriptedBackend([answer('gold')]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { outer: outer.backend, inner: inner.backend }, retry: false },
      subagents: { agents: { digger: { description: 'digs', model: 'inner/m' } } },
    });
    const { heard, onDelegatedRun } = listener();
    const result = await cog.run(lead(), { input: 'go', onDelegatedRun });

    expect(result.output).toBe('found gold');
    expect(heard).toHaveLength(1);
    expect(heard[0]?.start).toMatchObject({
      parentToolCallId: 'o1',
      agent: 'digger',
      background: true,
      depth: 1,
    });
    await vi.waitFor(() => expect(heard[0]?.results).toHaveLength(1));
    expect(heard[0]?.tokens.join('')).toBe('gold');
    await cog.close();
  });

  it('streams a delegate that bubbles its pause, and again when the caller resumes', async () => {
    const outer = scriptedBackend([
      callTools([call('o1', 'releaser', { task: 'ship' })]),
      answer('all done'),
    ]);
    const inner = scriptedBackend([
      callTools([call('i1', 'deploy', { target: 'prod' })]),
      answer('shipped'),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { outer: outer.backend, inner: inner.backend }, retry: false },
    });
    const releaser = new Agent({
      name: 'releaser',
      model: 'inner/m',
      instructions: 'You release.',
      tools: [deploy],
    });
    const agent = lead([
      agentAsTool(cog, releaser, {
        name: 'releaser',
        description: 'Releases',
        approvalMode: 'bubble',
      }),
    ]);
    const first = listener();
    const paused = await cog.run(agent, {
      input: 'release',
      threadId: 't-bubble',
      onDelegatedRun: first.onDelegatedRun,
    });
    expect(paused.status).toBe('paused');
    expect(first.heard).toHaveLength(1);
    expect(first.heard[0]?.start).toMatchObject({ parentToolCallId: 'o1', agent: 'releaser' });
    expect(first.heard[0]?.results.map((run) => run.status)).toEqual(['paused']);
    const childThread = first.heard[0]?.results[0]?.threadId;

    const second = listener();
    const resumed = await cog.resume(agent, 't-bubble', {
      responses: { 'o1/i1': { approved: true } },
      onDelegatedRun: second.onDelegatedRun,
    });
    expect(resumed.output).toBe('all done');
    expect(second.heard).toHaveLength(1);
    expect(second.heard[0]?.start).toMatchObject({
      parentToolCallId: 'o1',
      parentRunId: resumed.runId,
      threadId: childThread,
    });
    expect(second.heard[0]?.started).toBe(0);
    expect(second.heard[0]?.toolResults).toEqual(['deployed prod']);
    expect(second.heard[0]?.results.map((run) => run.output)).toEqual(['shipped']);
    await cog.close();
  });

  it('tags runs delegated a layer down by their own parent call', async () => {
    function threeLevels() {
      const top = scriptedBackend([callTools([call('t1', 'mid', { task: 'a' })]), answer('top')]);
      const mid = scriptedBackend([callTools([call('m1', 'leaf', { task: 'b' })]), answer('mid')]);
      const leaf = scriptedBackend([answer('leaf')]);
      const cog = new Cogitator({
        llm: {
          backends: { top: top.backend, mid: mid.backend, leaf: leaf.backend },
          retry: false,
        },
      });
      const leafAgent = new Agent({ name: 'leaf', model: 'leaf/m', instructions: 'Leaf.' });
      const midAgent = new Agent({
        name: 'mid',
        model: 'mid/m',
        instructions: 'Mid.',
        tools: [agentAsTool(cog, leafAgent, { name: 'leaf', description: 'Leaf' })],
      });
      const topAgent = new Agent({
        name: 'top',
        model: 'top/m',
        instructions: 'Top.',
        tools: [agentAsTool(cog, midAgent, { name: 'mid', description: 'Mid' })],
      });
      return { cog, topAgent };
    }

    const flatRun = threeLevels();
    const flat = listener();
    await flatRun.cog.run(flatRun.topAgent, { input: 'go', onDelegatedRun: flat.onDelegatedRun });
    expect(flat.heard.map((entry) => [entry.start.agent, entry.start.parentToolCallId])).toEqual([
      ['mid', 't1'],
      ['leaf', 'm1'],
    ]);
    expect(flat.heard.map((entry) => entry.start.depth)).toEqual([1, 2]);
    expect(flat.heard[1]?.start.parentRunId).toBe(flat.heard[0]?.results[0]?.runId);
    expect(flat.heard[1]?.results.map((run) => run.output)).toEqual(['leaf']);
    await flatRun.cog.close();

    const nestedRun = threeLevels();
    const nestedHeard = listener();
    const nested = listener(() => nestedHeard.onDelegatedRun);
    await nestedRun.cog.run(nestedRun.topAgent, {
      input: 'go',
      onDelegatedRun: nested.onDelegatedRun,
    });
    expect(nested.heard.map((entry) => entry.start.agent)).toEqual(['mid']);
    expect(nestedHeard.heard.map((entry) => entry.start.agent)).toEqual(['leaf']);
    await nestedRun.cog.close();
  });

  it('runs on when onDelegatedRun throws or returns nothing', async () => {
    const outer = scriptedBackend([
      callTools([call('o1', 'helper', { task: 'x' })]),
      answer('done'),
    ]);
    const inner = scriptedBackend([answer('helped')]);
    const cog = new Cogitator({
      llm: { backends: { outer: outer.backend, inner: inner.backend }, retry: false },
    });
    const helper = new Agent({ name: 'helper', model: 'inner/m', instructions: 'Help.' });
    const agent = lead([agentAsTool(cog, helper, { name: 'helper', description: 'Helps' })]);
    const thrown = await cog.run(agent, {
      input: 'go',
      onDelegatedRun: () => {
        throw new Error('listener broke');
      },
    });
    expect(thrown.output).toBe('done');
    const quiet = await cog.run(agent, { input: 'go', onDelegatedRun: () => undefined });
    expect(quiet.output).toBe('done');
    await cog.close();
  });

  it('reports a delegated run that fails', async () => {
    const outer = scriptedBackend([
      callTools([call('o1', 'helper', { task: 'x' })]),
      answer('done'),
    ]);
    const failing = deferred<never>();
    failing.reject(new Error('model down'));
    failing.promise.catch(() => undefined);
    const inner = scriptedBackend([() => failing.promise]);
    const cog = new Cogitator({
      llm: { backends: { outer: outer.backend, inner: inner.backend }, retry: false },
    });
    const helper = new Agent({ name: 'helper', model: 'inner/m', instructions: 'Help.' });
    const agent = lead([agentAsTool(cog, helper, { name: 'helper', description: 'Helps' })]);
    const { heard, onDelegatedRun } = listener();
    await cog.run(agent, { input: 'go', onDelegatedRun });
    expect(heard[0]?.errors).toHaveLength(1);
    expect(heard[0]?.results).toEqual([]);
    await cog.close();
  });
});
