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
      budget: { session: { maxCostUsd: 1 } },
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
      budget: { session: { maxCostUsd: 0.5 } },
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

describe('run limits', () => {
  it('fail as before by default and pause with limits.onExceeded interrupt', async () => {
    const failing = setup([toolTurn(0, 'a'), answer(0)], { limits: { maxTokensPerRun: 5 } });
    await expect(failing.cog.run(failing.agent, { input: 'find' })).rejects.toMatchObject({
      code: ErrorCode.RUN_TOKEN_LIMIT_EXCEEDED,
    });
    await failing.cog.close();

    const pausing = setup([toolTurn(0, 'a'), answer(0)], {
      limits: { maxTokensPerRun: 5, onExceeded: 'interrupt' },
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
