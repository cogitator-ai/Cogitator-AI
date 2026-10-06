import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  EmbeddingAdapter,
  EmbeddingService,
  FactAdapter,
  Message,
  MemoryAdapter,
  MemoryResult,
  MemoryEntry,
} from '@cogitator-ai/types';
import { ContextBuilder } from '../context-builder';
import { InMemoryAdapter } from '../adapters/memory';
import { countMessageTokens, countEntryTokens } from '../token-counter';

function fakeEmbeddings(): EmbeddingService & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  const vectorOf = (text: string) => [text.length % 7, text.includes('cat') ? 5 : 1, 1];
  return {
    dimensions: 3,
    model: 'fake',
    embed: vi.fn(async (text: string) => vectorOf(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(vectorOf)),
  };
}

describe('ContextBuilder budget and failures', () => {
  let adapter: InMemoryAdapter;
  let threadId: string;

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
    const thread = await adapter.createThread('agent1');
    if (!thread.success) throw new Error('no thread');
    threadId = thread.data.id;
  });

  async function addMessages(count: number, content = (i: number) => `message number ${i}`) {
    for (let i = 0; i < count; i++) {
      const message: Message = { role: i % 2 === 0 ? 'user' : 'assistant', content: content(i) };
      await adapter.addEntry({ threadId, message, tokenCount: countMessageTokens(message) });
    }
  }

  describe('system prompt', () => {
    it('keeps a system prompt larger than the budget and warns instead of dropping it', async () => {
      await addMessages(4);
      const instructions = 'Follow these rules. '.repeat(1000);
      const builder = new ContextBuilder(
        { maxTokens: 4000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: instructions,
      });

      expect(result.messages[0]).toEqual({ role: 'system', content: instructions });
      expect(result.messages).toHaveLength(1);
      expect(result.truncated).toBe(true);
      expect(result.warnings?.[0]).toMatch(/system prompt/i);
    });

    it('gives history only the budget the system prompt leaves', async () => {
      await addMessages(40);
      const instructions = 'x'.repeat(2000);
      const builder = new ContextBuilder(
        { maxTokens: 1000, reserveTokens: 0, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: instructions,
      });

      expect(result.messages[0].role).toBe('system');
      expect(result.tokenCount).toBeLessThanOrEqual(1000);
      expect(result.warnings ?? []).toEqual([]);
    });
  });

  describe('token counting', () => {
    it('counts tool call arguments and images', () => {
      const write = {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: { content: 'a'.repeat(80_000) } }],
      } as Message;
      expect(countMessageTokens(write)).toBeGreaterThan(20_000);

      const image: Message = {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      };
      expect(countMessageTokens(image)).toBeGreaterThan(500);

      const lowDetail: Message = {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://x/a.png', detail: 'low' } }],
      };
      expect(countMessageTokens(lowDetail)).toBeLessThan(countMessageTokens(image));
    });

    it('recounts entries saved with a stale token count', () => {
      const entry: MemoryEntry = {
        id: 'e1',
        threadId: 't',
        message: { role: 'assistant', content: '' },
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: { content: 'a'.repeat(40_000) } }],
        tokenCount: 4,
        createdAt: new Date(),
      };
      expect(countEntryTokens(entry)).toBeGreaterThan(10_000);
    });

    it('keeps the history within budget when entries carry large tool calls', async () => {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'write it' },
        tokenCount: 5,
      });
      await adapter.addEntry({
        threadId,
        message: { role: 'assistant', content: '' },
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: { content: 'a'.repeat(80_000) } }],
        tokenCount: 4,
      });
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'thanks' },
        tokenCount: 5,
      });

      const builder = new ContextBuilder(
        { maxTokens: 8000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );
      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.tokenCount).toBeLessThanOrEqual(8000);
      expect(result.messages.map((m) => m.content)).toEqual(['thanks']);
    });
  });

  describe('load failures', () => {
    it('builds without semantic context when embedding fails, and reports it', async () => {
      await addMessages(2);
      const embeddingService = fakeEmbeddings();
      embeddingService.embed.mockRejectedValue(new Error('429 Too Many Requests'));
      const embeddingAdapter: EmbeddingAdapter = {
        addEmbedding: vi.fn(),
        search: vi.fn(),
        deleteEmbedding: vi.fn(),
        deleteBySource: vi.fn(),
      };
      const builder = new ContextBuilder(
        { maxTokens: 4000, strategy: 'recent', includeSemanticContext: true },
        { memoryAdapter: adapter, embeddingAdapter, embeddingService }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'sys',
        currentInput: 'hello',
      });

      expect(result.messages).toHaveLength(3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0].source).toBe('semantic');
      expect(result.errors?.[0].error.message).toMatch(/429/);
    });

    it('reports a failed semantic search', async () => {
      const embeddingAdapter: EmbeddingAdapter = {
        addEmbedding: vi.fn(),
        search: vi.fn(
          async () => ({ success: false, error: 'different vector dimensions' }) as const
        ),
        deleteEmbedding: vi.fn(),
        deleteBySource: vi.fn(),
      };
      const builder = new ContextBuilder(
        { maxTokens: 4000, strategy: 'recent', includeSemanticContext: true },
        { memoryAdapter: adapter, embeddingAdapter, embeddingService: fakeEmbeddings() }
      );

      const result = await builder.build({ threadId, agentId: 'agent1', currentInput: 'hi' });

      expect(result.errors?.map((e) => e.source)).toEqual(['semantic']);
      expect(result.errors?.[0].error.message).toMatch(/different vector dimensions/);
    });

    it('reports failed history and fact loads instead of building an empty context silently', async () => {
      const broken: MemoryAdapter = Object.assign(Object.create(adapter) as InMemoryAdapter, {
        getEntries: async (): Promise<MemoryResult<MemoryEntry[]>> => ({
          success: false,
          error: 'connection reset',
        }),
      });
      const factAdapter = {
        getFacts: vi.fn(async () => {
          throw new Error('facts table missing');
        }),
      } as unknown as FactAdapter;
      const builder = new ContextBuilder(
        { maxTokens: 4000, strategy: 'recent', includeFacts: true },
        { memoryAdapter: broken, factAdapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1', systemPrompt: 'sys' });

      expect(result.messages).toEqual([{ role: 'system', content: 'sys' }]);
      expect(result.errors?.map((e) => e.source).sort()).toEqual(['facts', 'history']);
      expect(result.errors?.find((e) => e.source === 'history')?.error.message).toMatch(
        /connection reset/
      );
    });

    it('reports a relevance scoring failure and falls back to recent entries', async () => {
      await addMessages(4);
      const embeddingService = fakeEmbeddings();
      embeddingService.embedBatch.mockRejectedValue(new Error('embedding service down'));
      const builder = new ContextBuilder(
        { maxTokens: 4000, strategy: 'relevant' },
        { memoryAdapter: adapter, embeddingService }
      );

      const result = await builder.build({ threadId, agentId: 'agent1', currentInput: 'cat' });

      expect(result.messages).toHaveLength(4);
      expect(result.errors?.map((e) => e.source)).toEqual(['relevance']);
    });
  });

  describe('relevance scoring', () => {
    it('embeds each history entry once across turns', async () => {
      await addMessages(30, (i) => `entry ${i} about ${i % 3 === 0 ? 'cats' : 'dogs'} and more`);
      const embeddingService = fakeEmbeddings();
      const builder = new ContextBuilder(
        { maxTokens: 4000, strategy: 'relevant' },
        { memoryAdapter: adapter, embeddingService }
      );

      await builder.build({ threadId, agentId: 'agent1', currentInput: 'cat' });
      const embeddedFirst = embeddingService.embedBatch.mock.calls.flatMap(([t]) => t as string[]);
      expect(embeddedFirst).toHaveLength(30);

      await addMessages(2, (i) => `new message ${i} about cats`);
      await builder.build({ threadId, agentId: 'agent1', currentInput: 'cat' });
      const embeddedTotal = embeddingService.embedBatch.mock.calls.flatMap(([t]) => t as string[]);
      expect(embeddedTotal).toHaveLength(32);
    });

    it('scores at most a bounded window of recent entries', async () => {
      await addMessages(600, (i) => `history entry ${i} with some words`);
      const embeddingService = fakeEmbeddings();
      const builder = new ContextBuilder(
        { maxTokens: 100_000, strategy: 'hybrid' },
        { memoryAdapter: adapter, embeddingService }
      );

      await builder.build({ threadId, agentId: 'agent1', currentInput: 'cat' });

      const embedded = embeddingService.embedBatch.mock.calls.flatMap(([t]) => t as string[]);
      expect(embedded.length).toBeLessThanOrEqual(200);
      expect(embedded.length).toBeGreaterThan(0);
    });
  });
});
