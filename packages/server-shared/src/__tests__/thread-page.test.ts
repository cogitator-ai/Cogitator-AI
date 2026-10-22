import { describe, it, expect } from 'vitest';
import type { MemoryEntry, MemoryQueryOptions } from '@cogitator-ai/types';
import { parseThreadPageQuery, readThreadPage } from '../thread-page';

function memoryOf(entries: MemoryEntry[]) {
  return {
    getEntries: async (options: MemoryQueryOptions) => {
      let found = entries.filter((entry) => entry.threadId === options.threadId);
      if (options.before) found = found.filter((entry) => entry.createdAt < options.before!);
      if (options.limit) found = found.slice(-options.limit);
      return { success: true as const, data: found };
    },
  };
}

const entry = (id: string, at: number): MemoryEntry => ({
  id,
  threadId: 't1',
  message: { role: 'user', content: id },
  tokenCount: 1,
  createdAt: new Date(at),
});

describe('thread pages', () => {
  it('reads a thread back to its start a page at a time, entries of one time told apart', async () => {
    const entries = [
      entry('a', 1),
      entry('b', 2),
      entry('c', 2),
      entry('d', 2),
      entry('e', 3),
      entry('f', 4),
    ];
    const memory = memoryOf(entries);
    const seen: string[][] = [];
    let cursor: string | undefined;

    do {
      const page = await readThreadPage(memory, 't1', { limit: 2, cursor });
      seen.push(page.messages.map((message) => String(message.content)));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([
      ['e', 'f'],
      ['c', 'd'],
      ['a', 'b'],
    ]);
  });

  it('answers the whole thread without a limit, with the times of the thread when it has them', async () => {
    const memory = memoryOf([entry('a', 10), entry('b', 20)]);

    const all = await readThreadPage(memory, 't1');
    const withThread = await readThreadPage(
      memory,
      't1',
      {},
      {
        createdAt: new Date(5),
        updatedAt: new Date(30),
      }
    );

    expect(all).toEqual({
      id: 't1',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
      createdAt: 10,
      updatedAt: 20,
    });
    expect([withThread.createdAt, withThread.updatedAt]).toEqual([5, 30]);
  });

  it('dates the update of a thread by its newest entry when the record is older, on every page', async () => {
    const memory = memoryOf([entry('a', 10), entry('b', 20), entry('c', 40)]);
    const thread = { createdAt: new Date(5), updatedAt: new Date(5) };

    const newest = await readThreadPage(memory, 't1', { limit: 1 }, thread);
    const older = await readThreadPage(
      memory,
      't1',
      { limit: 1, cursor: newest.nextCursor },
      thread
    );

    expect(newest.updatedAt).toBe(40);
    expect(older.updatedAt).toBe(40);
  });

  it('gives no cursor on the page that reaches the start of the thread', async () => {
    const page = await readThreadPage(memoryOf([entry('a', 1), entry('b', 2)]), 't1', {
      limit: 2,
    });

    expect(page.nextCursor).toBeUndefined();
  });

  it('reads limit and cursor from a query, refusing what the server never gave', () => {
    expect(parseThreadPageQuery({ limit: '25' })).toEqual({ ok: true, value: { limit: 25 } });
    expect(parseThreadPageQuery({})).toEqual({ ok: true, value: {} });
    expect(parseThreadPageQuery({ limit: '0' }).ok).toBe(false);
    expect(parseThreadPageQuery({ limit: '1001' }).ok).toBe(false);
    expect(parseThreadPageQuery({ limit: 'ten' }).ok).toBe(false);
    expect(parseThreadPageQuery({ cursor: 'not-a-cursor' }).ok).toBe(false);
    const forged = (cursor: unknown) =>
      btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parseThreadPageQuery({ cursor: forged({ t: 1.5, n: 1 }) }).ok).toBe(false);
    expect(parseThreadPageQuery({ cursor: forged({ t: -1, n: 1 }) }).ok).toBe(true);
    expect(parseThreadPageQuery({ cursor: forged({ t: -9e15, n: 1 }) }).ok).toBe(false);
    expect(parseThreadPageQuery({ cursor: forged({ t: 9e15, n: 1 }) }).ok).toBe(false);
    expect(parseThreadPageQuery({ cursor: forged({ t: 1, n: 0 }) }).ok).toBe(false);
    expect(parseThreadPageQuery({ cursor: forged({ t: 1, n: 100_001 }) }).ok).toBe(false);
    expect(parseThreadPageQuery({ cursor: forged({ t: 1, n: 3 }) }).ok).toBe(true);
  });

  it('reads thousands of entries of one time to the end of the thread', async () => {
    const entries = [
      entry('first', 1),
      ...Array.from({ length: 2500 }, (_, at) => entry(`bulk-${at}`, 2)),
      entry('last', 3),
    ];
    const memory = memoryOf(entries);
    const read: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await readThreadPage(memory, 't1', { limit: 100, cursor });
      read.unshift(...page.messages.map((message) => String(message.content)));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(read).toEqual(entries.map((one) => String(one.message.content)));
    expect(pages).toBe(26);
  });
});
