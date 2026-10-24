import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import {
  ErrorCode,
  type BudgetWarning,
  type CogitatorConfig,
  type ToolCall,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';
import { SESSION_BUDGET_KEY } from '../cogitator/run-budget';

const lookups = vi.fn(async ({ id }: { id: string }) => `found ${id}`);
const lookup = tool({
  name: 'lookup',
  description: 'Look something up',
  parameters: z.object({ id: z.string() }),
  execute: lookups,
});

const call = (id: string): ToolCall => ({ id, name: 'lookup', arguments: { id } });

const spend = (cost: number, tokens = 10) => ({
  inputTokens: tokens,
  outputTokens: 0,
  totalTokens: tokens,
  cost,
});

const toolTurn = (cost: number, ...ids: string[]): MockChatResponse => ({
  content: 'looking',
  toolCalls: ids.map(call),
  finishReason: 'tool_calls',
  usage: spend(cost),
});

const answer = (cost: number, content = 'done'): MockChatResponse => ({
  content,
  usage: spend(cost),
});

function setup(responses: MockChatResponse[], config: CogitatorConfig = {}) {
  lookups.mockClear();
  const backend = new MockLLMBackend().setResponses(responses);
  const cog = new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { backends: { mock: backend }, retry: false },
  });
  const agent = new Agent({
    name: 'finder',
    model: 'mock/m',
    instructions: 'Find.',
    tools: [lookup],
  });
  return { cog, backend, agent };
}

describe('session budgets', () => {
  it('pauses before the model call that would pass the session budget, and goes on with a raised one', async () => {
    const { cog, backend, agent } = setup([toolTurn(0.6, 'a'), toolTurn(0.6, 'b'), answer(0.1)], {
      budget: { session: { maxCostUsd: 1 }, allowRaise: true },
    });
    const paused = await cog.run(agent, { input: 'find', threadId: 'b-raise' });

    expect(paused.status).toBe('paused');
    expect(backend.getCallCount()).toBe(2);
    expect(paused.interrupts).toEqual([
      expect.objectContaining({
        id: 'budget:session.cost',
        kind: 'budget',
        details: { scope: 'session', metric: 'cost', used: 1.2, limit: 1 },
      }),
    ]);
    expect(paused.sessionSpend).toMatchObject({ costUsd: 1.2, toolCalls: 2 });

    const done = await cog.resume(agent, 'b-raise', {
      responses: { 'budget:session.cost': { action: 'continue', limit: 5 } },
    });
    expect(done.status).toBe('completed');
    expect(done.output).toBe('done');
    expect(done.sessionSpend).toMatchObject({ costUsd: 1.3, raised: { 'session.cost': 5 } });

    const memory = await cog.getMemory();
    const thread = await memory!.getThread('b-raise');
    expect(thread.success && thread.data?.metadata[SESSION_BUDGET_KEY]).toMatchObject({
      costUsd: 1.3,
      tokens: 30,
      toolCalls: 2,
      agents: { [agent.id]: { costUsd: 1.3 } },
    });
    await cog.close();
  });

  it('ends the run when the answer is stop, and counts earlier runs of the thread', async () => {
    const { cog, agent } = setup([answer(0.7, 'first'), toolTurn(0.1, 'a'), answer(0.1)], {
      budget: { session: { maxCostUsd: 0.75 } },
    });
    const first = await cog.run(agent, { input: 'one', threadId: 'b-stop' });
    expect(first.status).toBe('completed');

    const second = await cog.run(agent, { input: 'two', threadId: 'b-stop' });
    expect(second.status).toBe('paused');
    expect(second.interrupts?.[0].details).toMatchObject({
      used: expect.closeTo(0.8),
      limit: 0.75,
    });

    const stopped = await cog.resume(agent, 'b-stop', {
      responses: { 'budget:session.cost': { action: 'stop' } },
    });
    expect(stopped.status).toBe('completed');
    expect(stopped.budgetStop).toMatchObject({ scope: 'session', metric: 'cost' });
    expect(stopped.output).toBe('looking');
    await cog.close();
  });

  it('goes on past a limit for the rest of the run when continue names none', async () => {
    const { cog, agent } = setup([toolTurn(1, 'a'), answer(0), answer(0)], {
      budget: { session: { maxCostUsd: 0.5 }, allowRaise: true },
    });
    await cog.run(agent, { input: 'one', threadId: 'b-lift' });
    const done = await cog.resume(agent, 'b-lift', {
      responses: { 'budget:session.cost': { action: 'continue' } },
    });
    expect(done.status).toBe('completed');
    const next = await cog.run(agent, { input: 'two', threadId: 'b-lift' });
    expect(next.status).toBe('paused');
    await cog.close();
  });

  it('pauses a tool turn that would pass the tool call budget, and stops it cleanly', async () => {
    const { cog, agent } = setup([toolTurn(0, 'a', 'b'), answer(0)], {
      budget: { session: { maxToolCalls: 1 } },
    });
    const paused = await cog.run(agent, { input: 'find', threadId: 'b-tools' });
    expect(paused.status).toBe('paused');
    expect(lookups).not.toHaveBeenCalled();
    expect(paused.interrupts?.[0].details).toMatchObject({
      metric: 'toolCalls',
      used: 0,
      limit: 1,
    });

    const stopped = await cog.resume(agent, paused.checkpoint!, {
      responses: { 'budget:session.toolCalls': { action: 'stop' } },
    });
    expect(stopped.budgetStop).toMatchObject({ metric: 'toolCalls' });
    const results = stopped.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(results).toEqual([
      expect.stringContaining('stopped at its budget'),
      expect.stringContaining('stopped at its budget'),
    ]);
    await cog.close();
  });

  it('holds an agent to its own budget and warns once past the warning share', async () => {
    const warnings: BudgetWarning[] = [];
    const { cog } = setup([toolTurn(0, 'a'), toolTurn(0, 'b'), answer(0)], {
      budget: { warnAt: 0.5, onWarning: (warning) => warnings.push(warning) },
    });
    const agent = new Agent({
      name: 'thrifty',
      model: 'mock/m',
      instructions: 'Find.',
      tools: [lookup],
      budget: { maxTokens: 15 },
    });
    const paused = await cog.run(agent, { input: 'find', threadId: 'b-agent' });
    expect(paused.status).toBe('paused');
    expect(paused.interrupts?.[0].details).toMatchObject({
      scope: 'agent',
      metric: 'tokens',
      agentId: agent.id,
      used: 20,
      limit: 15,
    });
    expect(warnings).toEqual([
      expect.objectContaining({ scope: 'agent', metric: 'tokens', used: 10 }),
    ]);
    await cog.close();
  });

  it('keeps the spending of a thread without memory in the process', async () => {
    const backend = new MockLLMBackend().setResponses([answer(0.5), answer(0.5)]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      budget: { session: { maxCostUsd: 0.9 } },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });
    await cog.run(agent, { input: '1', threadId: 'b-process' });
    await cog.run(agent, { input: '2', threadId: 'b-process' });
    const third = await cog.run(agent, { input: '3', threadId: 'b-process' });
    expect(third.status).toBe('paused');
    await cog.close();
  });
});

describe('who may raise a limit', () => {
  it('lets a client only stop the run unless the host allows raising', async () => {
    const { cog, agent } = setup([toolTurn(1, 'a'), answer(0), answer(0)], {
      budget: { session: { maxCostUsd: 0.5 } },
    });
    const paused = await cog.run(agent, { input: 'find', threadId: 'b-host' });
    expect(paused.interrupts?.[0].responseSchema).toMatchObject({
      properties: { action: { enum: ['stop'] } },
    });
    await expect(
      cog.resume(agent, 'b-host', {
        responses: { 'budget:session.cost': { action: 'continue', limit: 100 } },
      })
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPT_ANSWER_INVALID });
    const raised = await cog.resume(agent, 'b-host', { budget: { session: { maxCostUsd: 5 } } });
    expect(raised.status).toBe('completed');
    await cog.close();
  });

  it('keeps the run budget of a paused run for its resume', async () => {
    const { cog, agent } = setup([toolTurn(0, 'a'), answer(0), answer(0)]);
    const paused = await cog.run(agent, {
      input: 'find',
      threadId: 'b-own',
      budget: { session: { maxTokens: 5 } },
    });
    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.budget?.limits).toEqual({ session: { maxTokens: 5 } });
    const again = await cog.resume(agent, 'b-own', {});
    expect(again.status).toBe('paused');
    await cog.close();
  });

  it('keeps the spending of an agent with a budget of its own across runs', async () => {
    const backend = new MockLLMBackend().setResponses([answer(0), answer(0)]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: backend } },
    });
    const thrifty = new Agent({
      name: 't',
      model: 'mock/m',
      instructions: 'x',
      budget: { maxTokens: 15 },
    });
    await cog.run(thrifty, { input: '1', threadId: 'b-agent-own' });
    await cog.run(thrifty, { input: '2', threadId: 'b-agent-own' });
    const third = await cog.run(thrifty, { input: '3', threadId: 'b-agent-own' });
    expect(third.status).toBe('paused');
    await cog.close();
  });

  it('charges what a delegated agent spends to the caller session', async () => {
    const inner = new MockLLMBackend().setResponse({ content: 'inner', usage: spend(0.4) });
    const outer = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'd1', name: 'helper', arguments: { task: 'x' } }],
        usage: spend(0.1),
      },
      answer(0.1),
      answer(0.1),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { inner, outer } },
      budget: { session: { maxCostUsd: 0.45 } },
    });
    const helper = new Agent({ name: 'helper-agent', model: 'inner/m', instructions: 'x' });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'x',
      tools: [agentAsTool(cog, helper, { name: 'helper', description: 'Helps' })],
    });
    const result = await cog.run(lead, { input: 'go', threadId: 'b-delegate' });
    expect(result.status).toBe('paused');
    expect(result.interrupts?.[0].details).toMatchObject({ used: expect.closeTo(0.5) });
    await cog.close();
  });
});

describe('run limits', () => {
  it('fail as before by default and pause with limits.onExceeded interrupt', async () => {
    const failing = setup([toolTurn(0, 'a'), answer(0)], { limits: { maxTokensPerRun: 5 } });
    await expect(failing.cog.run(failing.agent, { input: 'find' })).rejects.toMatchObject({
      code: ErrorCode.RUN_TOKEN_LIMIT_EXCEEDED,
    });
    await failing.cog.close();

    const pausing = setup([toolTurn(0, 'a'), answer(0)], {
      limits: { maxTokensPerRun: 5, onExceeded: 'interrupt' },
      budget: { allowRaise: true },
    });
    const paused = await pausing.cog.run(pausing.agent, { input: 'find', threadId: 'b-run' });
    expect(paused.interrupts?.[0]).toMatchObject({
      id: 'budget:run.tokens',
      details: { scope: 'run', metric: 'tokens', used: 10, limit: 5 },
    });
    const done = await pausing.cog.resume(pausing.agent, 'b-run', {
      responses: { 'budget:run.tokens': { action: 'continue', limit: 100 } },
    });
    expect(done.status).toBe('completed');
    expect(done.checkpoint).toBeUndefined();
    await pausing.cog.close();
  });

  it('refuses an answer that is not a budget answer', async () => {
    const { cog, agent } = setup([toolTurn(1, 'a'), answer(0)], {
      budget: { session: { maxCostUsd: 0.5 } },
    });
    await cog.run(agent, { input: 'find', threadId: 'b-bad' });
    await expect(
      cog.resume(agent, 'b-bad', { responses: { 'budget:session.cost': { action: 'more' } } })
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPT_ANSWER_INVALID });
    await cog.close();
  });
});

describe('budgets in the second review round', () => {
  it('adds up what runs of one thread spend at the same time', async () => {
    const backend = new MockLLMBackend().setResponse({ ...answer(0.1), delay: 20 });
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: backend } },
      budget: { session: { maxCostUsd: 100 } },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });
    await cog.run(agent, { input: 'first', threadId: 'b-parallel' });
    await Promise.all([
      cog.run(agent, { input: 'a', threadId: 'b-parallel' }),
      cog.run(agent, { input: 'b', threadId: 'b-parallel' }),
    ]);
    const memory = await cog.getMemory();
    const thread = await memory!.getThread('b-parallel');
    const spent = thread.success ? thread.data?.metadata[SESSION_BUDGET_KEY] : undefined;
    expect(spent).toMatchObject({ costUsd: expect.closeTo(0.3), tokens: 30 });
    await cog.close();
  });

  it('charges the tool calls of a delegated agent to the caller and stops them at its limit', async () => {
    const inner = new MockLLMBackend().setResponses([
      { content: '', toolCalls: [call('i1'), call('i2')], usage: spend(0) },
      answer(0),
    ]);
    const outer = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'd1', name: 'helper', arguments: { task: 'x' } }],
        usage: spend(0),
      },
      answer(0),
    ]);
    lookups.mockClear();
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { inner, outer } },
      budget: { session: { maxToolCalls: 2 } },
    });
    const helper = new Agent({
      name: 'helper-agent',
      model: 'inner/m',
      instructions: 'x',
      tools: [lookup],
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'x',
      tools: [agentAsTool(cog, helper, { name: 'helper', description: 'Helps' })],
    });
    await cog.run(lead, { input: 'go', threadId: 'b-delegate-tools' });
    expect(lookups).not.toHaveBeenCalled();
    await cog.close();
  });

  it('pauses instead of failing when the hourly budget is spent before the run starts', async () => {
    const backend = new MockLLMBackend().setResponse(answer(1));
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      limits: { onExceeded: 'interrupt' },
      costRouting: { enabled: true, budget: { maxCostPerHour: 0.5 } },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });
    await cog.run(agent, { input: '1', threadId: 'b-hour' });
    const second = await cog.run(agent, { input: '2', threadId: 'b-hour-2' });
    expect(second.status).toBe('paused');
    expect(second.interrupts?.[0].details).toMatchObject({ scope: 'hour', metric: 'cost' });
    await cog.close();
  });
});

describe('third review round budgets', () => {
  it('stops a delegate at the caller session limit', async () => {
    const inner = new MockLLMBackend().setResponses([
      { content: '', toolCalls: [call('i1')], usage: spend(0.4) },
      { content: '', toolCalls: [call('i2')], usage: spend(0.4) },
      { content: '', toolCalls: [call('i3')], usage: spend(0.4) },
      answer(0.4),
    ]);
    const outer = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'd1', name: 'helper', arguments: { task: 'x' } }],
        usage: spend(0),
      },
      answer(0),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { inner, outer } },
      budget: { session: { maxCostUsd: 0.5 } },
    });
    const helper = new Agent({
      name: 'helper-agent',
      model: 'inner/m',
      instructions: 'x',
      tools: [lookup],
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'x',
      tools: [agentAsTool(cog, helper, { name: 'helper', description: 'Helps' })],
    });
    await cog.run(lead, { input: 'go', threadId: 'b-delegate-cost' });
    expect(inner.getCallCount()).toBe(2);
    await cog.close();
  });

  it('does not count a tool that asked a question twice against maxToolCalls', async () => {
    const asker = tool({
      name: 'asker',
      description: 'Asks',
      parameters: z.object({}),
      execute: async (_args, context) => {
        const answer = await context.interrupt?.({ reason: 'confirm', message: 'Sure?' });
        return answer;
      },
    });
    const backend = new MockLLMBackend().setResponses([
      { content: '', toolCalls: [{ id: 'q1', name: 'asker', arguments: {} }], usage: spend(0) },
      answer(0),
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: backend } },
      budget: { session: { maxToolCalls: 1 } },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [asker] });
    const paused = await cog.run(agent, { input: 'go', threadId: 'b-asked' });
    expect(paused.interrupts?.[0].kind).toBe('input');
    const done = await cog.resume(agent, 'b-asked', { responses: { 'q1#0': 'yes' } });
    expect(done.status).toBe('completed');
    expect(done.budgetStop).toBeUndefined();
    await cog.close();
  });

  it('a budget the host passes to the resume wins over a limit an answer raised', async () => {
    const { cog, agent } = setup([toolTurn(1, 'a'), toolTurn(1, 'b'), answer(0), answer(0)], {
      budget: { session: { maxCostUsd: 0.5 }, allowRaise: true },
    });
    await cog.run(agent, { input: 'find', threadId: 'b-host-wins' });
    const again = await cog.resume(agent, 'b-host-wins', {
      responses: { 'budget:session.cost': { action: 'continue', limit: 1.5 } },
    });
    expect(again.status).toBe('paused');
    const done = await cog.resume(agent, 'b-host-wins', { budget: { session: { maxCostUsd: 5 } } });
    expect(done.status).toBe('completed');
    await cog.close();
  });
});
