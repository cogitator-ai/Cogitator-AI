import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  RunCheckpoint,
  ToolCall,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { ErrorCode } from '@cogitator-ai/types';
import { InMemoryRunCheckpointStore, ThreadRunCheckpointStore } from '../cogitator/run-checkpoints';

const refundImpl = vi.fn(async ({ order, amount }: { order: string; amount: number }) => ({
  refunded: order,
  amount,
}));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string(), amount: z.number() }),
  requiresApproval: ({ amount }) => amount > 100,
  sideEffects: ['external'],
  execute: refundImpl,
});
const lookupImpl = vi.fn(async ({ order }: { order: string }) => ({ order, status: 'paid' }));
const lookup = tool({
  name: 'lookup',
  description: 'Look up an order',
  parameters: z.object({ order: z.string() }),
  execute: lookupImpl,
});

/** Asks for `calls` on the first turn, then echoes what the tools answered. */
function scriptedBackend(calls: ToolCall[]) {
  const requests: ChatRequest[] = [];
  const respond = (request: ChatRequest): ChatResponse => {
    requests.push({ ...request, messages: [...request.messages] });
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me do that.',
        toolCalls: calls,
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'r2',
      content: results.map((m) => String(m.content)).join(' | '),
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

const bigRefund: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1', amount: 500 } };
const smallRefund: ToolCall = { id: 'c2', name: 'refund', arguments: { order: 'A-2', amount: 20 } };
const orderLookup: ToolCall = { id: 'c3', name: 'lookup', arguments: { order: 'A-1' } };

const agent = new Agent({
  name: 'support',
  model: 'mock/m',
  instructions: 'Handle refunds.',
  tools: [refund, lookup],
});

function setup(calls: ToolCall[], config: ConstructorParameters<typeof Cogitator>[0] = {}) {
  refundImpl.mockClear();
  lookupImpl.mockClear();
  const scripted = scriptedBackend(calls);
  const cog = new Cogitator({
    ...config,
    llm: { ...config.llm, backends: { mock: scripted.backend } },
  });
  return { cog, ...scripted };
}

const roundTrip = (checkpoint: RunCheckpoint | undefined): RunCheckpoint =>
  JSON.parse(JSON.stringify(checkpoint)) as RunCheckpoint;

describe('tool approvals', () => {
  it('pauses before running a call that needs approval', async () => {
    const { cog, backend } = setup([bigRefund]);

    const result = await cog.run(agent, { input: 'Refund A-1' });

    expect(result.status).toBe('paused');
    expect(result.pendingApprovals).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'refund',
        arguments: { order: 'A-1', amount: 500 },
        description: 'Refund an order',
        sideEffects: ['external'],
      },
    ]);
    expect(refundImpl).not.toHaveBeenCalled();
    expect(backend.chat).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('Let me do that.');
    expect(result.usage.inputTokens).toBe(10);
    await cog.close();
  });

  it('runs approved calls when resumed and finishes the run', async () => {
    const { cog } = setup([bigRefund]);
    const paused = await cog.run(agent, { input: 'Refund A-1' });

    const result = await cog.resume(agent, roundTrip(paused.checkpoint), {
      decisions: { c1: { approved: true } },
    });

    expect(result.status).toBe('completed');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('"refunded":"A-1"');
    expect(result.runId).toBe(paused.runId);
    expect(result.threadId).toBe(paused.threadId);
    expect(result.usage.inputTokens).toBe(30);
    expect(result.toolCalls.map((c) => c.id)).toEqual(['c1']);
    await cog.close();
  });

  it('tells the model when a call was declined', async () => {
    const { cog } = setup([bigRefund]);
    const paused = await cog.run(agent, { input: 'Refund A-1' });

    const result = await cog.resume(agent, paused.checkpoint!, {
      decisions: { c1: { approved: false, reason: 'amount too high' } },
    });

    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.output).toContain('The user declined this tool call: amount too high');
    await cog.close();
  });

  it('pauses again while a call has no decision', async () => {
    const { cog, backend } = setup([bigRefund]);
    const paused = await cog.run(agent, { input: 'Refund A-1' });

    const again = await cog.resume(agent, paused.checkpoint!);

    expect(again.status).toBe('paused');
    expect(again.pendingApprovals?.map((p) => p.toolCallId)).toEqual(['c1']);
    expect(backend.chat).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('runs nothing of a turn until every call in it is decided', async () => {
    const { cog } = setup([orderLookup, bigRefund, smallRefund]);

    const paused = await cog.run(agent, { input: 'Check A-1 and refund' });
    expect(lookupImpl).not.toHaveBeenCalled();
    expect(paused.pendingApprovals?.map((p) => p.toolCallId)).toEqual(['c1']);

    await cog.resume(agent, paused.checkpoint!, { decisions: { c1: { approved: true } } });
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(refundImpl.mock.calls.map(([args]) => args.order)).toEqual(['A-1', 'A-2']);
    await cog.close();
  });

  it('decides inline with onApproval', async () => {
    const { cog } = setup([bigRefund]);
    const onApproval = vi.fn(async () => ({ approved: true as const }));

    const result = await cog.run(agent, { input: 'Refund A-1', onApproval });

    expect(result.status).toBe('completed');
    expect(onApproval).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'c1' }));
    expect(refundImpl).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('pauses when onApproval asks to', async () => {
    const { cog } = setup([bigRefund]);

    const result = await cog.run(agent, { input: 'Refund A-1', onApproval: () => 'pause' });

    expect(result.status).toBe('paused');
    await cog.close();
  });

  it('falls back to guardrails.onToolApproval and does not ask twice', async () => {
    const onToolApproval = vi.fn(async () => true);
    const { cog } = setup([bigRefund], {
      guardrails: { enabled: true, filterInput: false, filterOutput: false, onToolApproval },
    });

    const result = await cog.run(agent, { input: 'Refund A-1' });

    expect(result.status).toBe('completed');
    expect(onToolApproval).toHaveBeenCalledTimes(1);
    expect(onToolApproval).toHaveBeenCalledWith('refund', { order: 'A-1', amount: 500 }, [
      'external',
    ]);
    await cog.close();
  });

  it('keeps the resumed turn in the thread', async () => {
    const { cog, requests } = setup([bigRefund], { memory: { adapter: 'memory' } });
    const paused = await cog.run(agent, { input: 'Refund A-1', threadId: 't1' });

    await cog.resume(agent, paused.checkpoint!, { decisions: { c1: { approved: true } } });
    await cog.run(agent, { input: 'Anything else?', threadId: 't1' });

    const history = requests.at(-1)?.messages.map((m) => m.role);
    expect(history).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    await cog.close();
  });

  it('refuses checkpoints of an unknown version', async () => {
    const { cog } = setup([bigRefund]);
    const paused = await cog.run(agent, { input: 'Refund A-1' });

    await expect(cog.resume(agent, { ...paused.checkpoint!, version: 2 as 1 })).rejects.toThrow(
      'Unsupported run checkpoint version'
    );
    await cog.close();
  });
});

describe('paused runs by thread', () => {
  it('resumes the run waiting in a thread', async () => {
    const { cog } = setup([bigRefund], { memory: { adapter: 'memory' } });
    await cog.run(agent, { input: 'Refund A-1', threadId: 't1', userId: 'ann' });

    const result = await cog.resume(agent, 't1', {
      userId: 'ann',
      decisions: { c1: { approved: true } },
    });

    expect(result.status).toBe('completed');
    await expect(cog.resume(agent, 't1', { userId: 'ann' })).rejects.toMatchObject({
      code: ErrorCode.RUN_NOT_PAUSED,
    });
    await cog.close();
  });

  it("refuses to resume another user's run", async () => {
    const { cog } = setup([bigRefund], { memory: { adapter: 'memory' } });
    await cog.run(agent, { input: 'Refund A-1', threadId: 't1', userId: 'ann' });

    await expect(
      cog.resume(agent, 't1', { userId: 'bob', decisions: { c1: { approved: true } } })
    ).rejects.toMatchObject({ code: ErrorCode.THREAD_ACCESS_DENIED });
    expect(refundImpl).not.toHaveBeenCalled();
    await cog.close();
  });

  it('survives a restart through a shared checkpoint store', async () => {
    const store = new InMemoryRunCheckpointStore();
    const first = setup([bigRefund], { runCheckpoints: store });
    await first.cog.run(agent, { input: 'Refund A-1', threadId: 't1' });
    await first.cog.close();

    const second = setup([bigRefund], { runCheckpoints: store });
    const result = await second.cog.resume(agent, 't1', { decisions: { c1: { approved: true } } });

    expect(result.status).toBe('completed');
    expect(await store.load('t1')).toBeNull();
    await second.cog.close();
  });

  it('declines the waiting calls when the user moves on', async () => {
    const { cog, requests } = setup([bigRefund], { memory: { adapter: 'memory' } });
    await cog.run(agent, { input: 'Refund A-1', threadId: 't1' });

    await cog.run(agent, { input: 'Never mind', threadId: 't1' });

    const sent = requests.at(-1)!.messages;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(String(sent[3].content)).toContain('moved on without approving');
    expect(refundImpl).not.toHaveBeenCalled();
    await expect(cog.resume(agent, 't1')).rejects.toMatchObject({
      code: ErrorCode.RUN_NOT_PAUSED,
    });
    await cog.close();
  });
});

describe('ThreadRunCheckpointStore', () => {
  it('keeps the checkpoint in thread metadata without touching the owner', async () => {
    const memory = new InMemoryAdapter();
    await memory.createThread('support', { agentId: 'support', userId: 'ann' }, 't1');
    const store = new ThreadRunCheckpointStore(memory);
    const { cog } = setup([bigRefund]);
    const paused = await cog.run(agent, { input: 'Refund A-1', threadId: 't1', userId: 'ann' });
    await cog.close();

    await store.save(paused.checkpoint!);
    const thread = await memory.getThread('t1');

    expect((await store.load('t1'))?.runId).toBe(paused.runId);
    expect(thread.success && thread.data?.metadata.userId).toBe('ann');
    await store.delete('t1');
    expect(await store.load('t1')).toBeNull();
    expect(await store.load('missing')).toBeNull();
  });
});

describe('default decisions', () => {
  it('applies a default decision only to calls that need approval', async () => {
    const { cog } = setup([orderLookup, bigRefund]);
    const paused = await cog.run(agent, { input: 'Check and refund A-1' });

    const result = await cog.resume(agent, paused.checkpoint!, {
      defaultDecision: { approved: false, reason: 'not now' },
    });

    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.output).toContain('declined this tool call: not now');
    await cog.close();
  });
});
