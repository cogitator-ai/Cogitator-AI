import { describe, it, expect } from 'vitest';
import type { MemoryAdapter, Message } from '@cogitator-ai/types';
import type { MemoryEntry } from '@cogitator-ai/types';
import {
  CompactionService,
  compactedHistory,
  HISTORY_ENTRY_TYPES,
  type SummarizeFn,
} from '../compaction';
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

/** The conversation of a thread's active branch, as a context reads it */
async function conversationOf(adapter: MemoryAdapter, threadId: string): Promise<MemoryEntry[]> {
  const path = await adapter.getPath!({ threadId, types: HISTORY_ENTRY_TYPES });
  if (!path.success) throw new Error(path.error);
  return compactedHistory(path.data);
}

async function contentsOf(adapter: MemoryAdapter, threadId: string): Promise<string[]> {
  return (await conversationOf(adapter, threadId)).map((e) =>
    typeof e.message.content === 'string' ? e.message.content : ''
  );
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

    const after = await conversationOf(adapter, 't1');
    expect(after.slice(1).map((e) => e.id)).toEqual(keptIds);
  });

  it('deletes nothing, so a branch off a summarized entry keeps its history', async () => {
    const adapter = await create();
    await seed(adapter, 't1', ['q1', 'a1', 'q2', 'a2', 'q3']);
    const before = await adapter.getEntries({ threadId: 't1' });
    if (!before.success) throw new Error(before.error);
    const a1 = before.data[1]!;
    const side = await adapter.addEntry({
      threadId: 't1',
      message: { role: 'user', content: 'side' },
      tokenCount: 1,
      parentId: a1.id,
      activate: false,
    });
    if (!side.success) throw new Error(side.error);
    const service = new CompactionService({ adapter, summarize: async () => 'sum' });

    await service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 2 });

    const branch = await adapter.getPath!({ threadId: 't1', leafId: side.data.id });
    expect(branch.success && branch.data.map((e) => e.message.content)).toEqual([
      'q1',
      'a1',
      'side',
    ]);
    expect(await contentsOf(adapter, 't1')).toEqual(['[Conversation summary]\nsum', 'a2', 'q3']);
  });

  it('summarizes the summary and what followed it in the next compaction', async () => {
    const adapter = await create();
    await seed(adapter, 't1', ['q1', 'a1', 'q2', 'a2']);
    const seen: string[][] = [];
    const service = new CompactionService({
      adapter,
      summarize: async (messages) => {
        seen.push(messages.map((m) => String(m.content)));
        return `sum${seen.length}`;
      },
    });
    await service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 1 });
    await adapter.addEntry({
      threadId: 't1',
      message: { role: 'assistant', content: 'a3' },
      tokenCount: 1,
    });

    await service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 1 });

    expect(seen[1]).toEqual(['[Conversation summary]\nsum1', 'a2']);
    expect(await contentsOf(adapter, 't1')).toEqual(['[Conversation summary]\nsum2', 'a3']);
  });
});

describe('compacted history', () => {
  it('reads only the newest entries of a branch that do not reach the first kept one', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await seed(adapter, 't1', ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
    const service = new CompactionService({ adapter, summarize: async () => 'sum' });
    await service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 4 });
    for (const content of ['n1', 'n2', 'n3']) {
      await adapter.addEntry({ threadId: 't1', message: { role: 'user', content }, tokenCount: 1 });
    }

    const window = await adapter.getPath({ threadId: 't1', types: HISTORY_ENTRY_TYPES, limit: 6 });
    if (!window.success) throw new Error(window.error);

    expect(compactedHistory(window.data).map((e) => e.message.content)).toEqual([
      '[Conversation summary]\nsum',
      'q3',
      'a3',
      'n1',
      'n2',
      'n3',
    ]);
  });

  it('refuses to compact when the active branch moved while the summary was written', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await seed(adapter, 't1', ['q1', 'a1', 'q2', 'a2']);
    const first = await adapter.getEntries({ threadId: 't1' });
    if (!first.success) throw new Error(first.error);
    const service = new CompactionService({
      adapter,
      summarize: async () => {
        await adapter.addEntry({
          threadId: 't1',
          message: { role: 'user', content: 'elsewhere' },
          tokenCount: 1,
          parentId: first.data[0]!.id,
        });
        return 'sum';
      },
    });

    await expect(
      service.compact('t1', { strategy: 'summary', threshold: 0, keepRecent: 1 })
    ).rejects.toThrow(/changed while it was compacted/);
    const all = await adapter.getEntries({ threadId: 't1', types: 'all' });
    expect(all.success && all.data.some((e) => e.type === 'compaction')).toBe(false);
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
