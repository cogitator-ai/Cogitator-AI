import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

const lookup = tool({
  name: 'lookup',
  description: 'Look something up',
  parameters: z.object({ q: z.string() }),
  execute: async () => 'found',
});

/** Calls `lookup` once, then answers; every turn reasons and reads from the cache. */
function reasoningBackend() {
  const requests: ChatRequest[] = [];
  const turn = (request: ChatRequest): ChatResponse => {
    requests.push(request);
    const done = request.messages.some((m) => m.role === 'tool');
    return {
      id: 'r',
      content: done ? 'answer' : '',
      reasoning: done ? 'Now I can answer.' : 'I should look it up.',
      ...(!done && { toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }] }),
      finishReason: done ? 'stop' : 'tool_calls',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        reasoningTokens: 0,
      },
    };
  };
  const backend: LLMBackend = {
    provider: 'anthropic',
    chat: vi.fn(async (request: ChatRequest) => turn(request)),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      const response = turn(request);
      yield { id: 'r', delta: { reasoning: response.reasoning } };
      if (response.content) yield { id: 'r', delta: { content: response.content } };
      yield {
        id: 'r',
        delta: { toolCalls: response.toolCalls },
        finishReason: response.finishReason,
        usage: response.usage,
      };
    }),
  };
  return { backend, requests };
}

const agent = (reasoning?: Agent['config']['reasoning']) =>
  new Agent({
    name: 'thinker',
    model: 'anthropic/claude-opus-5-5',
    instructions: 'Think.',
    tools: [lookup],
    ...(reasoning && { reasoning }),
  });

describe('reasoning and prompt caching in runs', () => {
  it("sends the agent's reasoning, a run override, and caching by default", async () => {
    const { backend, requests } = reasoningBackend();
    const cog = new Cogitator({ llm: { backends: { anthropic: backend } } });

    await cog.run(agent({ effort: 'high', summary: true }), { input: 'q' });
    await cog.run(agent({ effort: 'high' }), { input: 'q', reasoning: { effort: 'low' } });

    expect(requests[0]).toMatchObject({ reasoning: { effort: 'high', summary: true }, cache: {} });
    expect(requests.at(-1)?.reasoning).toEqual({ effort: 'low' });
    await cog.close();
  });

  it('turns prompt caching off with promptCache: false', async () => {
    const { backend, requests } = reasoningBackend();
    const cog = new Cogitator({ llm: { backends: { anthropic: backend }, promptCache: false } });

    await cog.run(agent(), { input: 'q' });

    expect(requests[0].cache).toBe(false);
    await cog.close();
  });

  it('collects the reasoning of every turn and prices cached input', async () => {
    const { backend } = reasoningBackend();
    const cog = new Cogitator({ llm: { backends: { anthropic: backend } } });

    const result = await cog.run(agent({ summary: true }), { input: 'q' });

    expect(result.reasoning).toBe('I should look it up.\n\nNow I can answer.');
    expect(result.usage).toMatchObject({ inputTokens: 2_000_000, cachedInputTokens: 2_000_000 });
    expect(result.usage.cost).toBeCloseTo(0.4);
    await cog.close();
  });

  it('streams reasoning to onReasoning', async () => {
    const { backend } = reasoningBackend();
    const cog = new Cogitator({ llm: { backends: { anthropic: backend } } });
    const deltas: string[] = [];

    const result = await cog.run(agent({ summary: true }), {
      input: 'q',
      stream: true,
      onToken: () => undefined,
      onReasoning: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['I should look it up.', 'Now I can answer.']);
    expect(result.reasoning).toBe('I should look it up.\n\nNow I can answer.');
    await cog.close();
  });

  it('streams reasoning to onReasoning without an onToken', async () => {
    const { backend } = reasoningBackend();
    const cog = new Cogitator({ llm: { backends: { anthropic: backend } } });
    const deltas: string[] = [];

    await cog.run(agent({ summary: true }), {
      input: 'q',
      stream: true,
      onReasoning: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['I should look it up.', 'Now I can answer.']);
    await cog.close();
  });
});
