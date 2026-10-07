import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatStreamChunk, LLMBackend, Message } from '@cogitator-ai/types';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { getLogger } from '../logger';

function recordingBackend(): { backend: LLMBackend; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push(structuredClone(request));
      return {
        id: 'r',
        content: 'ok',
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

function systemText(messages: Message[]): string {
  const first = messages[0];
  expect(first?.role).toBe('system');
  return typeof first.content === 'string' ? first.content : '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runs with memory.contextBuilder', () => {
  it('sends instructions larger than the context budget, with the run context', async () => {
    const { backend, requests } = recordingBackend();
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory', contextBuilder: { strategy: 'recent' } },
    });
    const instructions = 'Always answer as a pirate. '.repeat(600);
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions });

    await cog.run(agent, { input: 'hi', threadId: 't1', context: { plan: 'gold' } });

    const system = systemText(requests[0].messages);
    expect(system.startsWith(instructions)).toBe(true);
    expect(system).toContain('"plan": "gold"');
    expect(warn.mock.calls.some(([message]) => /system prompt/i.test(String(message)))).toBe(true);
    await cog.close();
  });

  it('sends the instructions when includeSystemPrompt is false', async () => {
    const { backend, requests } = recordingBackend();
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: {
        adapter: 'memory',
        contextBuilder: { strategy: 'recent', includeSystemPrompt: false },
      },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'Be brief.' });

    await cog.run(agent, { input: 'hi', threadId: 't1', context: { tier: 'pro' } });

    const system = systemText(requests[0].messages);
    expect(system.startsWith('Be brief.')).toBe(true);
    expect(system).toContain('"tier": "pro"');
    await cog.close();
  });

  it('reports a failed history load to onMemoryError and still answers', async () => {
    const { backend, requests } = recordingBackend();
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.spyOn(InMemoryAdapter.prototype, 'getEntries').mockResolvedValue({
      success: false,
      error: 'connection reset',
    });
    const onMemoryError = vi.fn();
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory', contextBuilder: { strategy: 'recent' } },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });

    const result = await cog.run(agent, { input: 'hi', threadId: 't1', onMemoryError });

    expect(result.output).toBe('ok');
    expect(requests[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(onMemoryError).toHaveBeenCalledWith(expect.any(Error), 'load');
    expect(String(onMemoryError.mock.calls[0][0].message)).toMatch(/connection reset/);
    await cog.close();
  });

  it('warns about context parts the runtime cannot provide', async () => {
    const { backend } = recordingBackend();
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: {
        adapter: 'memory',
        contextBuilder: {
          includeFacts: true,
          includeSemanticContext: true,
          includeGraphContext: true,
        },
      },
    });

    await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), { input: 'hi' });

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.some((m) => m.includes('includeFacts'))).toBe(true);
    expect(messages.some((m) => m.includes('includeSemanticContext'))).toBe(true);
    expect(messages.some((m) => m.includes('includeGraphContext'))).toBe(true);
    await cog.close();
  });
});
