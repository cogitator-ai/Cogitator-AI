import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { TimeTravel } from '../time-travel/index';

vi.mock('../llm/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('../llm/index')>();
  return { ...original, createLLMBackend: vi.fn() };
});

const searchImpl = vi.fn(async ({ q }: { q: string }) => ({ hits: [`real result for ${q}`] }));
const search = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ q: z.string() }),
  execute: searchImpl,
});
const notify = tool({
  name: 'notify',
  description: 'Send a notification',
  parameters: z.object({ text: z.string() }),
  execute: async () => 'sent',
});

/** Calls `search` once, then answers with what the tool returned. */
function searchingBackend() {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const toolMessage = request.messages.findLast((m) => m.role === 'tool');
      if (!toolMessage) {
        return {
          id: 'r1',
          content: '',
          toolCalls: [{ id: `call_${requests.length}`, name: 'search', arguments: { q: 'ai' } }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }
      return {
        id: 'r2',
        content: `Found: ${String(toolMessage.content)}`,
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

describe('TimeTravel on real runs', () => {
  let cog: Cogitator;
  let requests: ChatRequest[];
  const agent = () =>
    new Agent({
      name: 'researcher',
      model: 'openai/gpt-6-luna',
      instructions: 'Research the question.',
      tools: [search, notify],
    });

  beforeEach(async () => {
    searchImpl.mockClear();
    const scripted = searchingBackend();
    requests = scripted.requests;
    const { createLLMBackend } = await import('../llm/index');
    vi.mocked(createLLMBackend).mockReturnValue(scripted.backend);
    cog = new Cogitator();
  });

  afterEach(async () => {
    await cog.close();
  });

  it('stores tool results in checkpoints', async () => {
    const tt = new TimeTravel(cog);
    const run = await cog.run(agent(), { input: 'Research AI' });

    const checkpoint = await tt.checkpoint(run, 1);

    expect(checkpoint.toolResults).toEqual({ call_1: { hits: ['real result for ai'] } });
    expect(checkpoint.pendingToolCalls).toEqual([]);
  });

  it('answers a mocked tool by name without running it', async () => {
    const tt = new TimeTravel(cog);
    const run = await cog.run(agent(), { input: 'Research AI' });
    const checkpoint = await tt.checkpoint(run, 0);
    searchImpl.mockClear();

    const fork = await tt.forkWithMockedTool(agent(), checkpoint.id, 'search', { hits: [] });

    expect(searchImpl).not.toHaveBeenCalled();
    expect(fork.result.output).toBe('Found: {"hits":[]}');
  });

  it('removes skipped tools from the replayed agent', async () => {
    const tt = new TimeTravel(cog);
    const run = await cog.run(agent(), { input: 'Research AI' });
    const checkpoint = await tt.checkpoint(run, 0);
    requests.length = 0;

    await tt.replay(agent(), checkpoint.id, { skipTools: ['notify'] });

    expect(requests[0].tools?.map((t) => t.name)).toEqual(['search']);
  });

  it('compares a fork with the original run', async () => {
    const tt = new TimeTravel(cog);
    const run = await cog.run(agent(), { input: 'Research AI' });
    const checkpoint = await tt.checkpoint(run, 0);

    const fork = await tt.forkWithMockedTool(agent(), checkpoint.id, 'search', { hits: [] });
    const diff = await tt.compareWithOriginal(fork.result);

    expect(diff.trace1Id).toBe(run.trace.traceId);
    expect(diff.trace2Id).toBe(fork.result.trace.traceId);
    expect(diff.commonSteps + diff.trace1OnlySteps).toBeGreaterThan(0);
    const forkTrace = await tt.getTraceStore().get(fork.result.trace.traceId);
    expect(forkTrace?.output).toBe('Found: {"hits":[]}');
    expect(forkTrace?.steps.find((s) => s.type === 'tool_call')?.toolResult?.result).toEqual({
      hits: [],
    });
  });

  it('compares a deterministic replay with the steps it replayed', async () => {
    const tt = new TimeTravel(cog);
    const run = await cog.run(agent(), { input: 'Research AI' });
    const checkpoint = await tt.checkpoint(run, 1);

    const replay = await tt.replayDeterministic(agent(), checkpoint.id);
    const diff = await tt.compareWithOriginal(replay);

    expect(diff.trace2Id).toBe(replay.trace.traceId);
    expect(diff.trace2OnlySteps).toBe(0);
    expect(diff.commonSteps).toBeGreaterThan(0);
  });

  it('applies name-keyed results in a deterministic replay', async () => {
    const tt = new TimeTravel(cog);
    const run = await cog.run(agent(), { input: 'Research AI' });
    const checkpoint = await tt.checkpoint(run, 1);

    const replay = await tt.replay(agent(), checkpoint.id, {
      mode: 'deterministic',
      modifiedToolResults: { search: { hits: ['mocked'] } },
    });

    const toolMessage = replay.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('{"hits":["mocked"]}');
  });
});
