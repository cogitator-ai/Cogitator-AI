import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatStreamChunk, LLMBackend, Message } from '@cogitator-ai/types';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { getLogger } from '../logger';
import { ContextManager } from '../context/context-manager';

function recordingBackend(provider: LLMBackend['provider'] = 'openai'): {
  backend: LLMBackend;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider,
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
  it('sends instructions larger than the context budget, the run context with the input', async () => {
    const { backend, requests } = recordingBackend();
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory', contextBuilder: { strategy: 'recent', maxTokens: 4000 } },
    });
    const instructions = 'Always answer as a pirate. '.repeat(600);
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions });

    await cog.run(agent, { input: 'hi', threadId: 't1', context: { plan: 'gold' } });

    const system = systemText(requests[0].messages);
    expect(system.startsWith(instructions)).toBe(true);
    expect(system).not.toContain('"plan": "gold"');
    expect(String(requests[0].messages.at(-1)?.content)).toContain('"plan": "gold"');
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
    expect(system).toBe('Be brief.');
    expect(String(requests[0].messages.at(-1)?.content)).toMatch(/"tier": "pro"[\s\S]*hi$/);
    await cog.close();
  });

  it('reports a failed history load to onMemoryError and still answers', async () => {
    const { backend, requests } = recordingBackend();
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.spyOn(InMemoryAdapter.prototype, 'getPath').mockResolvedValue({
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

  describe('the history budget', () => {
    const longTurn = (i: number) =>
      `Turn ${i}: ${'the shipment moved through another depot. '.repeat(40)}`;

    async function seededRun(
      model: string,
      contextBuilder: { maxTokens?: number },
      setup: {
        provider?: LLMBackend['provider'];
        agentMaxTokens?: number;
        compression?: boolean;
      } = {}
    ) {
      const { backend, requests } = recordingBackend(setup.provider);
      const cog = new Cogitator({
        llm: { backends: { mock: backend } },
        memory: { adapter: 'memory', contextBuilder: { strategy: 'recent', ...contextBuilder } },
        ...(setup.compression && { context: { enabled: true, strategy: 'truncate' as const } }),
      });
      const agent = new Agent({
        id: 'agent',
        name: 'a',
        model,
        instructions: 'Track shipments.',
        ...(setup.agentMaxTokens !== undefined && { maxTokens: setup.agentMaxTokens }),
      });
      await cog.run(agent, { input: 'warm up', threadId: 'thread-warmup' });
      const memory = cog.memory!;
      await memory.createThread('agent', {}, 'thread-long');
      for (let i = 0; i < 30; i++) {
        await memory.addEntry({
          threadId: 'thread-long',
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: longTurn(i) },
          tokenCount: 0,
        });
      }
      requests.length = 0;

      await cog.run(agent, {
        input: 'Where is it now?',
        threadId: 'thread-long',
        threadAccess: 'shared',
      });
      await cog.close();
      return requests[0].messages.filter(
        (m) => typeof m.content === 'string' && m.content.startsWith('Turn ')
      );
    }

    it('fills the context window of the model the run is on', async () => {
      const history = await seededRun('mock/gpt-4o', {});

      expect(history).toHaveLength(30);
    });

    it('keeps an explicit maxTokens over the model window', async () => {
      const history = await seededRun('mock/gpt-4o', { maxTokens: 2000 });

      expect(history.length).toBeGreaterThan(0);
      expect(history.length).toBeLessThan(30);
      expect(history.at(-1)?.content).toBe(longTurn(29));
    });

    it('leaves room for the answer the agent asks for', async () => {
      const roomy = await seededRun('mock/house-model', {});
      const longAnswer = await seededRun('mock/house-model', {}, { agentMaxTokens: 4000 });

      expect(longAnswer.length).toBeLessThan(roomy.length);
    });

    it('keeps a local Ollama model within the context Ollama serves by default', async () => {
      const elsewhere = await seededRun('mock/gpt-4o', {});
      const local = await seededRun('mock/gpt-4o', {}, { provider: 'ollama' });
      const cloud = await seededRun('mock/gpt-4o:cloud', {}, { provider: 'ollama' });

      expect(elsewhere).toHaveLength(30);
      expect(local.length).toBeGreaterThan(0);
      expect(local.length).toBeLessThan(10);
      expect(cloud).toHaveLength(30);
    });

    it('keeps room for history when the agent asks for an answer as long as the window', async () => {
      const history = await seededRun('mock/house-model', {}, { agentMaxTokens: 9000 });

      expect(history.length).toBeGreaterThan(0);
    });

    it('gives a model on Ollama Cloud its whole window', async () => {
      const bodies: { messages: { content: string }[] }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)) as { messages: { content: string }[] });
          return new Response(
            JSON.stringify({
              model: 'gpt-4o',
              message: { role: 'assistant', content: 'ok' },
              done: true,
              prompt_eval_count: 1,
              eval_count: 1,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        })
      );
      const historyOn = async (baseUrl: string) => {
        bodies.length = 0;
        const cog = new Cogitator({
          llm: { providers: { ollama: { baseUrl, apiKey: 'test' } }, retry: false },
          memory: { adapter: 'memory', contextBuilder: { strategy: 'recent' } },
        });
        const agent = new Agent({
          id: 'agent',
          name: 'a',
          model: 'ollama/gpt-4o',
          instructions: 'T.',
        });
        await cog.run(agent, { input: 'warm up', threadId: 'warm' });
        await cog.memory!.createThread('agent', {}, 'long');
        for (let i = 0; i < 30; i++) {
          await cog.memory!.addEntry({
            threadId: 'long',
            message: { role: i % 2 === 0 ? 'user' : 'assistant', content: longTurn(i) },
            tokenCount: 0,
          });
        }
        bodies.length = 0;
        await cog.run(agent, { input: 'Where?', threadId: 'long', threadAccess: 'shared' });
        await cog.close();
        return bodies[0].messages.filter((m) => m.content.startsWith('Turn '));
      };

      const cloud = await historyOn('https://ollama.com');
      const local = await historyOn('http://localhost:11434');
      vi.unstubAllGlobals();

      expect(cloud).toHaveLength(30);
      expect(local.length).toBeLessThan(10);
    });

    it('stays below the point where the context manager compresses', async () => {
      const compress = vi.spyOn(ContextManager.prototype, 'compress');

      const history = await seededRun('mock/house-model', {}, { compression: true });

      expect(history.length).toBeGreaterThan(0);
      expect(compress).not.toHaveBeenCalled();
    });

    it('falls back to a window of 8192 tokens for a model nobody knows', async () => {
      const history = await seededRun('mock/house-model', {});

      expect(history.length).toBeGreaterThan(0);
      expect(history.length).toBeLessThan(30);
    });
  });
});
