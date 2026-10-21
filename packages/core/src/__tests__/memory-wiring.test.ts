import { describe, it, expect, vi } from 'vitest';
import type { ChatStreamChunk, EmbeddingService, LLMBackend } from '@cogitator-ai/types';
import type { ContextBuilderDeps } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';

const captured = vi.hoisted(() => [] as ContextBuilderDeps[]);

vi.mock('@cogitator-ai/memory', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cogitator-ai/memory')>();
  class CapturingContextBuilder extends original.ContextBuilder {
    constructor(...args: ConstructorParameters<typeof original.ContextBuilder>) {
      super(...args);
      captured.push(args[1]);
    }
  }
  return { ...original, ContextBuilder: CapturingContextBuilder };
});

const backend: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(async () => ({
    id: 'r',
    content: 'ok',
    finishReason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })),
  chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
    yield { id: 's', delta: {}, finishReason: 'stop' };
  }),
};

describe('memory wiring', () => {
  it('gives the context builder the embedding service from memory.embedding', async () => {
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: {
        adapter: 'memory',
        contextBuilder: { maxTokens: 4000, strategy: 'hybrid' },
        embedding: { provider: 'ollama', model: 'nomic-embed-text' },
      },
    });

    await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), { input: 'hi' });

    const deps = captured.at(-1);
    expect(deps?.memoryAdapter).toBe(cog.memory);
    expect(deps?.embeddingService?.model).toBe('nomic-embed-text');
    expect(deps?.factAdapter).toBeUndefined();
    expect(deps?.embeddingAdapter).toBeUndefined();
    await cog.close();
  });

  describe('message index', () => {
    function fakeEmbedding(): EmbeddingService & { embedBatch: ReturnType<typeof vi.fn> } {
      return {
        dimensions: 2,
        model: 'fake-embed',
        embed: vi.fn(async (text: string) => [text.length, 1]),
        embedBatch: vi.fn(async (texts: string[]) => texts.map((text) => [text.length, 1])),
      };
    }
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x' });

    it('indexes the entries of runs once, in the background, for the relevant strategy', async () => {
      const embedding = fakeEmbedding();
      const cog = new Cogitator({
        llm: { backends: { mock: backend } },
        memory: {
          adapter: 'memory',
          contextBuilder: { maxTokens: 4000, strategy: 'relevant' },
          embedding,
        },
      });

      await cog.run(agent, { input: 'first question', threadId: 't' });
      const deps = captured.at(-1);
      expect(deps?.messageIndex).toBeDefined();
      await deps?.messageIndex?.flush();
      embedding.embedBatch.mockClear();
      await cog.run(agent, { input: 'second question', threadId: 't' });
      await cog.close();

      const embedded = embedding.embedBatch.mock.calls.flatMap(([texts]) => texts as string[]);
      expect(embedded).not.toContain('first question');
      expect(embedded).toEqual(['second question', 'ok']);
    });

    it('keeps no index for the recent strategy', async () => {
      const cog = new Cogitator({
        llm: { backends: { mock: backend } },
        memory: {
          adapter: 'memory',
          contextBuilder: { maxTokens: 4000, strategy: 'recent' },
          embedding: fakeEmbedding(),
        },
      });

      await cog.run(agent, { input: 'hi' });

      expect(captured.at(-1)?.messageIndex).toBeUndefined();
      await cog.close();
    });
  });
});
