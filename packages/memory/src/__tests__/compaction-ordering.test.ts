import { describe, it, expect } from 'vitest';
import type { MemoryAdapter, Message } from '@cogitator-ai/types';
import { CompactionService, type SummarizeFn } from '../compaction';
import { InMemoryAdapter } from '../adapters/memory';
import { SQLiteAdapter } from '../adapters/sqlite';
import { countMessageTokens } from '../token-counter';

async function seed(adapter: MemoryAdapter, threadId: string, contents: string[]): Promise<void> {
  await adapter.createThread('agent', {}, threadId);
  for (const [i, content] of contents.entries()) {
    const message: Message = { role: i % 2 === 0 ? 'user' : 'assistant', content };
    await adapter.addEntry({ threadId, message, tokenCount: countMessageTokens(message) });
  }
}

async function contentsOf(adapter: MemoryAdapter, threadId: string): Promise<string[]> {
  const entries = await adapter.getEntries({ threadId });
  if (!entries.success) throw new Error(entries.error);
  return entries.data.map((e) => (typeof e.message.content === 'string' ? e.message.content : ''));
}

const adapters: [string, () => Promise<MemoryAdapter>][] = [
  ['in-memory', async () => new InMemoryAdapter({ provider: 'memory' })],
  [
    'sqlite',
    async () => {
      const adapter = new SQLiteAdapter({ provider: 'sqlite', path: ':memory:' });
      await adapter.connect();
      return adapter;
    },
  ],
];

describe.each(adapters)('compaction on %s', (_name, create) => {
  it('keeps a reply saved during summarization after the messages it follows', async () => {
    const adapter = await create();
    await seed(adapter, 't1', ['q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'q4']);
    const summarize: SummarizeFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await adapter.addEntry({
        threadId: 't1',
        message: { role: 'assistant', content: 'a4' },
        tokenCount: 5,
      });
      return 'what was said';
    };
    const service = new CompactionService({ adapter, summarize });

    await service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 3 });

    expect(await contentsOf(adapter, 't1')).toEqual([
      '[Conversation summary]\nwhat was said',
      'q3',
      'a3',
      'q4',
      'a4',
    ]);
  });

  it('keeps the ids of the entries it keeps', async () => {
    const adapter = await create();
    await seed(adapter, 't1', ['q1', 'a1', 'q2', 'a2', 'q3']);
    const before = await adapter.getEntries({ threadId: 't1' });
    if (!before.success) throw new Error(before.error);
    const keptIds = before.data.slice(-2).map((e) => e.id);
    const service = new CompactionService({ adapter, summarize: async () => 'sum' });

    await service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 2 });

    const after = await adapter.getEntries({ threadId: 't1' });
    if (!after.success) throw new Error(after.error);
    expect(after.data.slice(1).map((e) => e.id)).toEqual(keptIds);
  });
});

describe('compaction thresholds', () => {
  it('compacts once the thread holds messageThreshold entries, whatever their tokens', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await seed(adapter, 't1', ['a', 'b', 'c', 'd', 'e', 'f']);
    const service = new CompactionService({ adapter, summarize: async () => 'sum' });

    const result = await service.compact('t1', {
      strategy: 'summary',
      threshold: 100_000,
      messageThreshold: 5,
      keepRecent: 2,
    });

    expect(result.compactedMessages).toBe(3);
    expect(await contentsOf(adapter, 't1')).toEqual(['[Conversation summary]\nsum', 'e', 'f']);
  });

  it('compacts by entries alone when no token threshold is set', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await seed(adapter, 't1', ['a', 'b', 'c', 'd']);
    const service = new CompactionService({ adapter, summarize: async () => 'sum' });

    const below = await service.compact('t1', {
      strategy: 'summary',
      messageThreshold: 5,
      keepRecent: 1,
    });
    expect(below.compactedMessages).toBe(4);

    await adapter.addEntry({
      threadId: 't1',
      message: { role: 'user', content: 'e' },
      tokenCount: 1,
    });
    const reached = await service.compact('t1', {
      strategy: 'summary',
      messageThreshold: 5,
      keepRecent: 1,
    });
    expect(reached.compactedMessages).toBe(2);
  });

  it('rejects a config without any threshold', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const service = new CompactionService({ adapter, summarize: async () => 'sum' });

    await expect(service.compact('t1', { strategy: 'summary', keepRecent: 1 })).rejects.toThrow(
      /threshold/
    );
  });
});
