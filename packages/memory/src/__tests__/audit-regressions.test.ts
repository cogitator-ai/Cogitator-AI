import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EmbeddingService, Message } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { SQLiteAdapter } from '../adapters/sqlite';
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';
import { ContextBuilder } from '../context-builder';
import { SessionManager } from '../session-manager';
import { CompactionService } from '../compaction';
import { SQLiteGraphAdapter } from '../knowledge-graph/sqlite-graph-adapter';
import { fetchWithRetry } from '../embedding/retry';

const msg = (role: Message['role'], content: string): Message => ({ role, content }) as Message;

describe('thread creation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps existing entries when a thread is created again', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createThread('agent', {}, 't1');
    await adapter.addEntry({ threadId: 't1', message: msg('user', 'hello'), tokenCount: 1 });

    const again = await adapter.createThread('agent', { updated: true }, 't1');
    const entries = await adapter.getEntries({ threadId: 't1' });

    expect(again.success).toBe(true);
    expect(entries.success && entries.data).toHaveLength(1);
    const thread = await adapter.getThread('t1');
    expect(thread.success && thread.data?.metadata).toEqual({ updated: true });
  });

  it('upserts threads in SQLite instead of failing', async () => {
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
    await adapter.connect();
    await adapter.createThread('agent', {}, 't1');
    await adapter.addEntry({ threadId: 't1', message: msg('user', 'hi'), tokenCount: 1 });

    const again = await adapter.createThread('agent', { v: 2 }, 't1');

    expect(again.success).toBe(true);
    const entries = await adapter.getEntries({ threadId: 't1' });
    expect(entries.success && entries.data).toHaveLength(1);
    await adapter.disconnect();
  });

  it('returns the stored createdAt when SQLite upserts an existing thread', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
    await adapter.connect();

    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const created = await adapter.createThread('agent', {}, 't1');
    vi.setSystemTime(new Date('2024-06-01T00:00:00.000Z'));
    const again = await adapter.createThread('agent', { v: 2 }, 't1');
    const stored = await adapter.getThread('t1');

    expect(created.success && created.data.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(again.success && again.data.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(again.success && again.data.updatedAt).toEqual(new Date('2024-06-01T00:00:00.000Z'));
    expect(again.success && again.data.metadata).toEqual({ v: 2 });
    expect(stored.success && stored.data).toEqual(again.success && again.data);
    await adapter.disconnect();
  });
});

describe('entry ordering', () => {
  it('keeps insertion order for entries saved within the same millisecond', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
      await adapter.connect();
      await adapter.createThread('agent', {}, 't1');

      for (const content of ['first', 'second', 'third', 'fourth']) {
        await adapter.addEntry({ threadId: 't1', message: msg('user', content), tokenCount: 1 });
      }

      const all = await adapter.getEntries({ threadId: 't1' });
      const lastTwo = await adapter.getEntries({ threadId: 't1', limit: 2 });

      expect(all.success && all.data.map((e) => e.message.content)).toEqual([
        'first',
        'second',
        'third',
        'fourth',
      ]);
      expect(lastTwo.success && lastTwo.data.map((e) => e.message.content)).toEqual([
        'third',
        'fourth',
      ]);
      await adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('embedding scoping', () => {
  it('filters semantic and keyword search by agent and thread metadata', async () => {
    const adapter = new InMemoryEmbeddingAdapter();
    await adapter.addEmbedding({
      sourceId: 's1',
      sourceType: 'message',
      vector: [1, 0],
      content: 'alpha secret',
      metadata: { agentId: 'a1', threadId: 't1' },
    });
    await adapter.addEmbedding({
      sourceId: 's2',
      sourceType: 'message',
      vector: [1, 0],
      content: 'alpha other',
      metadata: { agentId: 'a2', threadId: 't2' },
    });

    const semantic = await adapter.search({ vector: [1, 0], filter: { agentId: 'a1' } });
    const keyword = await adapter.keywordSearch({ query: 'alpha', filter: { threadId: 't2' } });

    expect(semantic.success && semantic.data.map((r) => r.sourceId)).toEqual(['s1']);
    expect(keyword.success && keyword.data.map((r) => r.sourceId)).toEqual(['s2']);
  });
});

function fakeEmbeddings(vectors: Record<string, number[]>): EmbeddingService {
  const lookup = (text: string) => vectors[text] ?? [0, 0, 1];
  return {
    model: 'fake',
    dimensions: 3,
    embed: async (text) => lookup(text),
    embedBatch: async (texts) => texts.map(lookup),
  };
}

describe('ContextBuilder', () => {
  it('never injects embeddings scoped to another agent', async () => {
    const memoryAdapter = new InMemoryAdapter();
    await memoryAdapter.createThread('a1', {}, 't1');
    const embeddingAdapter = new InMemoryEmbeddingAdapter();
    await embeddingAdapter.addEmbedding({
      sourceId: 'mine',
      sourceType: 'fact',
      vector: [1, 0, 0],
      content: 'my private note',
      metadata: { agentId: 'a1' },
    });
    await embeddingAdapter.addEmbedding({
      sourceId: 'theirs',
      sourceType: 'fact',
      vector: [1, 0, 0],
      content: 'someone else note',
      metadata: { agentId: 'a2' },
    });
    await embeddingAdapter.addEmbedding({
      sourceId: 'shared',
      sourceType: 'document',
      vector: [1, 0, 0],
      content: 'shared handbook',
    });

    const builder = new ContextBuilder(
      { maxTokens: 4000, strategy: 'recent', includeSemanticContext: true },
      {
        memoryAdapter,
        embeddingAdapter,
        embeddingService: fakeEmbeddings({ question: [1, 0, 0] }),
      }
    );

    const context = await builder.build({
      threadId: 't1',
      agentId: 'a1',
      currentInput: 'question',
    });

    expect(context.semanticResults.map((r) => r.sourceId).sort()).toEqual(['mine', 'shared']);
  });

  it('selects the most relevant history with the relevant strategy', async () => {
    const memoryAdapter = new InMemoryAdapter();
    await memoryAdapter.createThread('a1', {}, 't1');
    for (const content of ['cats are great', 'the weather is nice', 'dogs bark loudly']) {
      await memoryAdapter.addEntry({
        threadId: 't1',
        message: msg('user', content),
        tokenCount: 10,
      });
    }

    const builder = new ContextBuilder(
      { maxTokens: 4000, reserveTokens: 3975, strategy: 'relevant', includeSystemPrompt: false },
      {
        memoryAdapter,
        embeddingService: fakeEmbeddings({
          'tell me about pets': [1, 0, 0],
          'cats are great': [0.9, 0.1, 0],
          'dogs bark loudly': [0.8, 0.2, 0],
          'the weather is nice': [0, 1, 0],
        }),
      }
    );

    const context = await builder.build({
      threadId: 't1',
      agentId: 'a1',
      currentInput: 'tell me about pets',
    });

    expect(context.messages.map((m) => m.content)).toEqual(['cats are great', 'dogs bark loudly']);
    expect(context.truncated).toBe(true);
  });

  it('uses the whole budget for recent history when hybrid has no embedding service', async () => {
    const memoryAdapter = new InMemoryAdapter();
    await memoryAdapter.createThread('a1', {}, 't1');
    for (let i = 0; i < 4; i++) {
      await memoryAdapter.addEntry({
        threadId: 't1',
        message: msg('user', `m${i}`),
        tokenCount: 10,
      });
    }

    const builder = new ContextBuilder(
      { maxTokens: 4000, reserveTokens: 3960, strategy: 'hybrid', includeSystemPrompt: false },
      { memoryAdapter }
    );

    const context = await builder.build({ threadId: 't1', agentId: 'a1', currentInput: 'q' });

    expect(context.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('returns hybrid selections in chronological order', async () => {
    const memoryAdapter = new InMemoryAdapter();
    await memoryAdapter.createThread('a1', {}, 't1');
    const contents = Array.from({ length: 14 }, (_, i) =>
      i === 2 ? 'a long message about pets and animals' : `filler message number ${i} here`
    );
    for (const content of contents) {
      await memoryAdapter.addEntry({
        threadId: 't1',
        message: msg('user', content),
        tokenCount: 10,
      });
    }

    const builder = new ContextBuilder(
      { maxTokens: 4000, reserveTokens: 3880, strategy: 'hybrid', includeSystemPrompt: false },
      {
        memoryAdapter,
        embeddingService: fakeEmbeddings({
          pets: [1, 0, 0],
          'a long message about pets and animals': [1, 0, 0],
        }),
      }
    );

    const context = await builder.build({ threadId: 't1', agentId: 'a1', currentInput: 'pets' });
    const included = context.messages.map((m) => contents.indexOf(m.content as string));

    expect(included[0]).toBe(2);
    expect(included).toEqual([...included].sort((a, b) => a - b));
    expect(included).toHaveLength(12);
  });
});

describe('SessionManager', () => {
  it('lists sessions without a user filter and forgets deleted sessions', async () => {
    const adapter = new InMemoryAdapter();
    const sessions = new SessionManager(adapter);

    const a = await sessions.getOrCreate({
      userId: 'u1',
      channelType: 'terminal',
      channelId: 'c1',
      agentId: 'agent',
    });
    await sessions.getOrCreate({
      userId: 'u2',
      channelType: 'telegram',
      channelId: 'c2',
      agentId: 'agent',
    });

    expect((await sessions.list()).map((s) => s.userId).sort()).toEqual(['u1', 'u2']);
    expect((await sessions.list({ userId: 'u1' })).map((s) => s.channelType)).toEqual(['terminal']);
    expect(await sessions.list({ limit: 1, offset: 1 })).toHaveLength(1);

    await sessions.delete(a.id);
    expect((await sessions.list()).map((s) => s.userId)).toEqual(['u2']);
  });

  it('compacts through the configured CompactionService', async () => {
    const adapter = new InMemoryAdapter();
    const compaction = new CompactionService({ adapter, summarize: async () => 'summary' });
    const sessions = new SessionManager(adapter, { compaction });
    const session = await sessions.getOrCreate({
      userId: 'u',
      channelType: 'webchat',
      channelId: 'c',
      agentId: 'agent',
    });
    for (let i = 0; i < 5; i++) {
      await adapter.addEntry({
        threadId: session.id,
        message: msg('user', `m${i}`),
        tokenCount: 50,
      });
    }

    const result = await sessions.compact(session.id, {
      strategy: 'summary',
      threshold: 10,
      keepRecent: 2,
    });

    expect(result.compactedMessages).toBe(3);
    await expect(
      new SessionManager(adapter).compact(session.id, {
        strategy: 'summary',
        threshold: 1,
        keepRecent: 1,
      })
    ).rejects.toThrow('CompactionService');
  });
});

describe('CompactionService', () => {
  it('places the summary before the kept recent messages', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.createThread('agent', {}, 't');
    for (let i = 0; i < 6; i++) {
      await adapter.addEntry({ threadId: 't', message: msg('user', `m${i}`), tokenCount: 50 });
    }

    const service = new CompactionService({ adapter, summarize: async () => 'old stuff' });
    await service.compact('t', { strategy: 'summary', threshold: 10, keepRecent: 2 });

    const entries = await adapter.getEntries({ threadId: 't' });
    expect(entries.success && entries.data.map((e) => e.message.content)).toEqual([
      '[Conversation summary]\nold stuff',
      'm4',
      'm5',
    ]);
  });
});

describe('SQLiteGraphAdapter name search', () => {
  it('matches names containing LIKE wildcards literally', async () => {
    const graph = new SQLiteGraphAdapter({ path: ':memory:' });
    await graph.initialize();
    const base = {
      agentId: 'a',
      type: 'concept' as const,
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user' as const,
    };
    await graph.addNode({ ...base, name: 'user_id' });
    await graph.addNode({ ...base, name: 'userXid' });

    const result = await graph.queryNodes({ agentId: 'a', namePattern: 'user_id' });

    expect(result.success && result.data.map((n) => n.name)).toEqual(['user_id']);
    await graph.close();
  });
});

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries network errors before failing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetry('http://embeddings.local');
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After on 429 responses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchWithRetry('http://embeddings.local');
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    const response = await pending;

    expect(response.status).toBe(200);
  });
});
