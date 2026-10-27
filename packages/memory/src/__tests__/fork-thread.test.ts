import { describe, expect, it } from 'vitest';
import type { MemoryResult } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

describe('forkThread', () => {
  it('takes a fork that fails on the way back: no thread, and the origin does not list it', async () => {
    const memory = new InMemoryAdapter();
    await memory.connect();
    unwrap(await memory.createThread('agent', {}, 't'));
    unwrap(await memory.forkThread('t', unwrap(await say(memory, 'first')).id, 'kept'));
    const second = unwrap(await say(memory, 'second'));
    const add = memory.addEntry.bind(memory);
    let adds = 0;
    memory.addEntry = async (entry) =>
      entry.threadId === 'broken' && ++adds === 2
        ? { success: false, error: 'the store is full' }
        : add(entry);

    const failed = await memory.forkThread('t', second.id, 'broken');

    expect(failed).toEqual({ success: false, error: 'the store is full' });
    expect(unwrap(await memory.getThread('broken'))).toBeNull();
    expect(unwrap(await memory.getEntries({ threadId: 'broken' }))).toEqual([]);
    expect(unwrap(await memory.getThread('t'))?.metadata.memoryForks).toEqual(['kept']);
  });

  it('refuses a new id that names a thread already, before it changes anything', async () => {
    const memory = new InMemoryAdapter();
    await memory.connect();
    unwrap(await memory.createThread('agent', {}, 't'));
    const point = unwrap(await say(memory, 'first'));
    unwrap(await memory.createThread('agent', { mine: true }, 'taken'));
    unwrap(
      await memory.addEntry({
        threadId: 'taken',
        message: { role: 'user', content: 'keep' },
        tokenCount: 1,
      })
    );
    const add = memory.addEntry.bind(memory);
    memory.addEntry = async (entry) =>
      entry.threadId === 'taken' ? { success: false, error: 'the store is full' } : add(entry);

    const refused = await memory.forkThread('t', point.id, 'taken');

    expect(refused.success).toBe(false);
    expect(refused.success ? '' : refused.error).toContain('exists already');
    expect(unwrap(await memory.getThread('taken'))?.metadata).toEqual({ mine: true });
    const kept = unwrap(await memory.getEntries({ threadId: 'taken' }));
    expect(kept.map((entry) => entry.message.content)).toEqual(['keep']);
    expect(unwrap(await memory.getThread('t'))?.metadata.memoryForks).toBeUndefined();
  });
});

function say(memory: InMemoryAdapter, content: string) {
  return memory.addEntry({
    threadId: 't',
    message: { role: 'user', content },
    tokenCount: 1,
  });
}
