import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type { DurableRunRecord, DurableRunStore, Message } from '@cogitator-ai/types';
import { InMemoryDurableRunStore, ThreadDurableRunStore } from '../cogitator/durable-stores';

function record(runId: string, threadId: string, base?: Message[]): DurableRunRecord {
  return {
    runId,
    threadId,
    agentId: 'agent-1',
    agentName: 'clerk',
    userId: 'u1',
    checkpoint: {
      version: 1,
      status: 'running',
      runId,
      agentId: 'agent-1',
      threadId,
      model: 'mock/m',
      input: 'Go',
      messages: [{ role: 'assistant', content: 'step' }],
      toolCalls: [],
      turn: { toolCalls: [], decisions: {} },
      iterations: 2,
      lastToolCallSignature: '',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      reasoning: [],
      startedAt: 500,
    },
    ...(base && { base }),
    journal: [],
    savedAt: 900,
  };
}

const stores: [string, (now: () => number) => Promise<DurableRunStore>][] = [
  ['in process memory', async (now) => new InMemoryDurableRunStore({ now })],
  [
    'thread metadata',
    async (now) => {
      const memory = new InMemoryAdapter({ provider: 'memory' });
      await memory.connect();
      return new ThreadDurableRunStore(memory, { now });
    },
  ],
];

const a = { owner: 'host', instance: 'a' };
const b = { owner: 'host', instance: 'b' };

describe.each(stores)('durable run store in %s', (_name, make) => {
  it('keeps the base across saves and the journal until the next save', async () => {
    const store = await make(() => 0);
    const ref = { runId: 'r1', threadId: 't1' };
    const base: Message[] = [{ role: 'system', content: 'You help.' }];
    expect(await store.acquire(ref, a, 100)).toBe(true);
    expect(await store.save(record('r1', 't1', base), a)).toBe(true);
    await store.append(ref, [{ kind: 'started', toolCallId: 'c1' }], a);
    await store.append(
      ref,
      [{ kind: 'finished', toolCallId: 'c1', result: { callId: 'c1', name: 'x', result: 1 } }],
      a
    );

    const loaded = await store.load(ref);
    expect(loaded?.base).toEqual(base);
    expect(loaded?.journal.map((mark) => mark.kind)).toEqual(['started', 'finished']);

    await store.save(record('r1', 't1'), a);
    const again = await store.load(ref);
    expect(again?.base).toEqual(base);
    expect(again?.journal).toEqual([]);
  });

  it('writes only for the instance that holds the lease', async () => {
    const store = await make(() => 0);
    const ref = { runId: 'r1', threadId: 't1' };
    expect(await store.save(record('r1', 't1'), a)).toBe(false);
    await store.acquire(ref, a, 100);
    await store.save(record('r1', 't1'), a);
    expect(await store.save(record('r1', 't1'), b)).toBe(false);
    expect(await store.append(ref, [{ kind: 'started', toolCallId: 'c' }], b)).toBe(false);
    expect(await store.delete(ref, b)).toBe(false);
    expect(await store.load(ref)).not.toBeNull();
    expect(await store.delete(ref, a)).toBe(true);
    expect(await store.load(ref)).toBeNull();
  });

  it('lists runs by filter with who holds them', async () => {
    let now = 1_000;
    const store = await make(() => now);
    for (const [runId, threadId] of [
      ['r1', 't1'],
      ['r2', 't2'],
    ]) {
      await store.acquire({ runId, threadId }, a, 100);
      await store.save(record(runId, threadId), a);
    }
    await store.release({ runId: 'r2', threadId: 't2' }, a);

    const all = await store.list();
    expect(all.map((run) => run.runId).sort()).toEqual(['r1', 'r2']);
    expect(all.find((run) => run.runId === 'r1')).toMatchObject({
      agentName: 'clerk',
      iterations: 2,
      startedAt: 500,
      savedAt: 900,
      lease: { owner: 'host', instance: 'a', expiresAt: 1_100 },
    });
    expect(all.find((run) => run.runId === 'r2')?.lease).toBeUndefined();
    expect((await store.list({ threadId: 't2' })).map((run) => run.runId)).toEqual(['r2']);
    expect(await store.list({ userId: 'nobody' })).toEqual([]);

    now = 1_200;
    expect((await store.list({ runId: 'r1' }))[0].lease).toBeUndefined();
  });

  it('holds a run for one instance until its lease runs out, it lets go or is replaced', async () => {
    let now = 0;
    const store = await make(() => now);
    const ref = { runId: 'r1', threadId: 't1' };

    expect(await store.acquire(ref, a, 100)).toBe(true);
    expect(await store.save(record('r1', 't1'), a)).toBe(true);
    expect(await store.acquire(ref, b, 100)).toBe(false);
    expect(await store.renew(ref, b, 100)).toBe(false);
    expect(await store.acquire(ref, b, 100, { replacing: 'other' })).toBe(false);
    now = 50;
    expect(await store.renew(ref, a, 100)).toBe(true);
    now = 140;
    expect(await store.acquire(ref, b, 100)).toBe(false);
    now = 151;
    expect(await store.renew(ref, a, 100)).toBe(false);
    expect(await store.acquire(ref, b, 100)).toBe(true);
    await store.release(ref, a);
    expect(await store.acquire(ref, a, 100)).toBe(false);
    expect(await store.acquire(ref, a, 100, { replacing: 'b' })).toBe(true);
    expect(await store.renew(ref, b, 100)).toBe(false);
    await store.release(ref, a);
    expect(await store.acquire(ref, b, 100)).toBe(true);
    await expect(store.acquire(ref, a, 0)).rejects.toThrow(RangeError);
  });

  it('forgets a run with its lease, so its holder cannot renew it', async () => {
    const store = await make(() => 0);
    const ref = { runId: 'r1', threadId: 't1' };
    for (const runId of ['r1', 'r2']) {
      await store.acquire({ runId, threadId: 't1' }, a, 100);
      await store.save(record(runId, 't1'), a);
    }

    await store.delete(ref);

    expect(await store.load(ref)).toBeNull();
    expect(await store.renew(ref, a, 100)).toBe(false);
    expect((await store.list()).map((run) => run.runId)).toEqual(['r2']);
    await store.delete({ runId: 'r2', threadId: 't1' });
    expect(await store.list()).toEqual([]);
  });
});

describe('durable run store in thread metadata', () => {
  it('leaves nothing behind in the thread once its runs are gone', async () => {
    const memory = new InMemoryAdapter({ provider: 'memory' });
    await memory.connect();
    const store = new ThreadDurableRunStore(memory);
    for (let round = 0; round < 20; round++) {
      const ref = { runId: `r${round}`, threadId: 't1' };
      await store.acquire(ref, a, 1_000);
      await store.save(record(ref.runId, 't1'), a);
      await store.delete(ref, a);
    }
    const thread = await memory.getThread('t1');
    if (!thread.success) throw new Error(thread.error);
    const keys = Object.entries(thread.data?.metadata ?? {}).filter(
      ([key, value]) => key.toLowerCase().includes('durable') && value !== null && value !== false
    );
    expect(keys).toEqual([]);
    expect(Object.keys(thread.data?.metadata ?? {}).length).toBeLessThan(5);
  });
});
