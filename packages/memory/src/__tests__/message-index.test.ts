import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmbeddingService, Message } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';
import { ContextBuilder } from '../context-builder';
import { MessageIndex } from '../message-index';
import { countMessageTokens } from '../token-counter';

const TOPICS = ['cat', 'tax', 'car', 'rain'];

function topicVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [...TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0)), 0.25];
}

function fakeEmbeddings(model = 'topics'): EmbeddingService & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  return {
    dimensions: TOPICS.length + 1,
    model,
    embed: vi.fn(async (text: string) => topicVector(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(topicVector)),
  };
}

const embedded = (service: ReturnType<typeof fakeEmbeddings>) =>
  service.embedBatch.mock.calls.flatMap(([texts]) => texts as string[]);

describe('MessageIndex', () => {
  let memory: InMemoryAdapter;
  let store: InMemoryEmbeddingAdapter;
  let embedding: ReturnType<typeof fakeEmbeddings>;
  let index: MessageIndex;
  let threadId: string;

  beforeEach(async () => {
    memory = new InMemoryAdapter({ provider: 'memory' });
    await memory.connect();
    store = new InMemoryEmbeddingAdapter();
    embedding = fakeEmbeddings();
    index = new MessageIndex({ store, embedding, batchSize: 2 });
    expect(index.attach(memory)).toBe(true);
    const thread = await memory.createThread('agent', {}, 'thread-1');
    if (!thread.success) throw new Error(thread.error);
    threadId = thread.data.id;
  });

  async function say(content: string, role: Message['role'] = 'user', thread = threadId) {
    const message = { role, content } as Message;
    const added = await memory.addEntry({
      threadId: thread,
      message,
      tokenCount: countMessageTokens(message),
    });
    if (!added.success) throw new Error(added.error);
    return added.data;
  }

  async function storedSources(): Promise<string[]> {
    const found = await store.search({ vector: [1, 1, 1, 1, 1], threshold: -1, limit: 100 });
    if (!found.success) throw new Error(found.error);
    return found.data.map((result) => result.sourceId).sort();
  }

  it('embeds new user and assistant entries in the background, batching what piles up', async () => {
    let release!: () => void;
    embedding.embedBatch.mockImplementationOnce(async (texts: string[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return texts.map(topicVector);
    });
    const entries = [await say('my cat sleeps')];
    await new Promise((resolve) => setTimeout(resolve, 0));
    entries.push(
      await say('cats are great', 'assistant'),
      await say('tax is due'),
      await say('car wash')
    );
    await say('internal note', 'system');
    await say('   ');
    release();

    await index.flush();

    expect(embedding.embedBatch.mock.calls.map(([texts]) => texts)).toEqual([
      ['my cat sleeps'],
      ['cats are great', 'tax is due'],
      ['car wash'],
    ]);
    expect(await storedSources()).toEqual(entries.map((entry) => entry.id).sort());
    const kept = await store.getBySources([entries[0].id]);
    expect(kept.success && kept.data[0]).toMatchObject({
      sourceType: 'message',
      content: 'my cat sleeps',
      metadata: { threadId, entryId: entries[0].id, role: 'user', model: 'topics' },
    });
  });

  it('deletes the vectors of deleted entries and of cleared or deleted threads', async () => {
    const kept = await say('cat one');
    const removed = await say('cat two');
    await memory.createThread('agent', {}, 'thread-2');
    const other = await say('tax elsewhere', 'user', 'thread-2');
    await index.flush();

    await memory.deleteEntry(removed.id);
    await index.flush();
    expect(await storedSources()).toEqual([kept.id, other.id].sort());

    await memory.clearThread(threadId);
    await index.flush();
    expect(await storedSources()).toEqual([other.id]);

    await memory.deleteThread('thread-2');
    await index.flush();
    expect(await storedSources()).toEqual([]);
  });

  it('keeps no vector of an entry deleted before the background reached it', async () => {
    let release!: () => void;
    embedding.embedBatch.mockImplementationOnce(async (texts: string[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return texts.map(topicVector);
    });
    const first = await say('cat first');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await say('cat second');
    await memory.deleteEntry(first.id);
    await memory.deleteEntry(second.id);
    release();

    await index.flush();

    expect(await storedSources()).toEqual([]);
    expect(embedded(embedding)).not.toContain('cat second');
  });

  it('reads kept vectors instead of embedding again, and replaces those of another model', async () => {
    const entry = await say('rain today');
    await index.flush();
    embedding.embedBatch.mockClear();

    const fresh = new MessageIndex({ store, embedding });
    const vectors = await fresh.vectorsOf([
      { entryId: entry.id, threadId, role: 'user', text: 'rain today' },
    ]);
    expect(Array.from(vectors.get(entry.id) ?? [])).toEqual(topicVector('rain today'));
    expect(embedding.embedBatch).not.toHaveBeenCalled();

    const otherModel = fakeEmbeddings('other');
    const switched = new MessageIndex({ store, embedding: otherModel });
    await switched.vectorsOf([{ entryId: entry.id, threadId, role: 'user', text: 'rain today' }]);
    await switched.flush();

    expect(embedded(otherModel)).toEqual(['rain today']);
    const kept = await store.getBySources([entry.id]);
    expect(kept.success && kept.data.map((e) => e.metadata?.model)).toEqual(['other']);
  });

  it('reports a background failure and embeds the entries when a build needs them', async () => {
    const onError = vi.fn();
    const failing = fakeEmbeddings();
    failing.embedBatch.mockRejectedValueOnce(new Error('embedding down'));
    const watched = new InMemoryAdapter({ provider: 'memory' });
    await watched.connect();
    await watched.createThread('agent', {}, 't');
    const failingIndex = new MessageIndex({ store, embedding: failing, onError });
    failingIndex.attach(watched);
    const added = await watched.addEntry({
      threadId: 't',
      message: { role: 'user', content: 'cat lost' },
      tokenCount: 3,
    });
    if (!added.success) throw new Error(added.error);
    await failingIndex.flush();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'embedding down' }));
    const vectors = await failingIndex.vectorsOf([
      { entryId: added.data.id, threadId: 't', role: 'user', text: 'cat lost' },
    ]);
    await failingIndex.flush();
    expect(vectors.has(added.data.id)).toBe(true);
    expect(await storedSources()).toContain(added.data.id);
  });

  it('stops indexing an adapter once closed', async () => {
    await index.close();
    await say('cat after close');
    await index.flush();

    expect(embedding.embedBatch).not.toHaveBeenCalled();
  });

  it('is refused a batch size below one', () => {
    expect(() => new MessageIndex({ store, embedding, batchSize: 0 })).toThrow(/batchSize/);
  });

  describe('in a context build', () => {
    it('finds entries older than the scored window through the store', async () => {
      await say('my cat is called Whiskers');
      for (let i = 0; i < 205; i++) await say(`filler message ${i}`);
      await index.flush();
      embedding.embedBatch.mockClear();
      embedding.embed.mockClear();
      const builder = new ContextBuilder(
        { maxTokens: 120, reserveTokens: 0, strategy: 'relevant', includeSystemPrompt: false },
        { memoryAdapter: memory, embeddingService: embedding, messageIndex: index }
      );

      const context = await builder.build({
        threadId,
        agentId: 'agent',
        currentInput: 'what is my cat called?',
      });

      expect(context.messages.map((m) => m.content)).toContain('my cat is called Whiskers');
      expect(embedding.embed).toHaveBeenCalledTimes(1);
      expect(embedding.embedBatch).not.toHaveBeenCalled();
    });

    it('embeds and keeps entries the background has not indexed yet', async () => {
      const unwatched = new InMemoryAdapter({ provider: 'memory' });
      await unwatched.connect();
      await unwatched.createThread('agent', {}, 'u');
      const entry = await unwatched.addEntry({
        threadId: 'u',
        message: { role: 'user', content: 'tax forms' },
        tokenCount: 3,
      });
      if (!entry.success) throw new Error(entry.error);
      const builder = new ContextBuilder(
        { maxTokens: 500, strategy: 'relevant', includeSystemPrompt: false },
        { memoryAdapter: unwatched, embeddingService: embedding, messageIndex: index }
      );

      await builder.build({ threadId: 'u', agentId: 'agent', currentInput: 'tax' });
      await index.flush();

      expect(embedded(embedding)).toEqual(['tax forms']);
      expect(await storedSources()).toContain(entry.data.id);
    });

    it('leaves message vectors out of semantic context', async () => {
      await say('my cat Whiskers');
      await index.flush();
      await store.addEmbedding({
        sourceId: 'doc-1',
        sourceType: 'document',
        vector: topicVector('cat care guide'),
        content: 'cat care guide',
      });
      const builder = new ContextBuilder(
        {
          maxTokens: 500,
          strategy: 'recent',
          includeSystemPrompt: false,
          includeSemanticContext: true,
        },
        { memoryAdapter: memory, embeddingService: embedding, embeddingAdapter: store }
      );

      const context = await builder.build({
        threadId: 'thread-new',
        agentId: 'agent',
        currentInput: 'cat',
      });

      expect(context.semanticResults.map((r) => r.content)).toEqual(['cat care guide']);
    });
  });
});
