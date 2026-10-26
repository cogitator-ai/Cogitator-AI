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

describe.each(stores)('durable run store in %s', (_name, make) => {
  it('keeps the base across saves and the journal until the next save', async () => {
    const store = await make(() => 0);
    const base: Message[] = [{ role: 'system', content: 'You help.' }];
    await store.save(record('r1', 't1', base));
    await store.append({ runId: 'r1', threadId: 't1' }, [{ kind: 'started', toolCallId: 'c1' }]);
    await store.append({ runId: 'r1', threadId: 't1' }, [
      { kind: 'finished', toolCallId: 'c1', result: { callId: 'c1', name: 'x', result: 1 } },
    ]);

    const loaded = await store.load({ runId: 'r1', threadId: 't1' });
    expect(loaded?.base).toEqual(base);
    expect(loaded?.journal.map((mark) => mark.kind)).toEqual(['started', 'finished']);

    await store.save(record('r1', 't1'));
    const again = await store.load({ runId: 'r1', threadId: 't1' });
    expect(again?.base).toEqual(base);
    expect(again?.journal).toEqual([]);
  });

  it('lists runs by filter with who holds them', async () => {
    let now = 1_000;
    const store = await make(() => now);
    await store.save(record('r1', 't1'));
    await store.save(record('r2', 't2'));
    expect(await store.acquire({ runId: 'r1', threadId: 't1' }, 'a', 100)).toBe(true);

    const all = await store.list();
    expect(all.map((run) => run.runId).sort()).toEqual(['r1', 'r2']);
    expect(all.find((run) => run.runId === 'r1')).toMatchObject({
      agentName: 'clerk',
      iterations: 2,
      startedAt: 500,
      savedAt: 900,
      lease: { owner: 'a', expiresAt: 1_100 },
    });
    expect((await store.list({ threadId: 't2' })).map((run) => run.runId)).toEqual(['r2']);
    expect(await store.list({ userId: 'nobody' })).toEqual([]);

    now = 1_200;
    expect((await store.list({ runId: 'r1' }))[0].lease).toBeUndefined();
  });

  it('holds a run for one owner until its lease runs out or it lets go', async () => {
    let now = 0;
    const store = await make(() => now);
    const ref = { runId: 'r1', threadId: 't1' };
    await store.save(record('r1', 't1'));

    expect(await store.acquire(ref, 'a', 100)).toBe(true);
    expect(await store.acquire(ref, 'b', 100)).toBe(false);
    expect(await store.renew(ref, 'b', 100)).toBe(false);
    now = 50;
    expect(await store.renew(ref, 'a', 100)).toBe(true);
    now = 140;
    expect(await store.acquire(ref, 'b', 100)).toBe(false);
    now = 151;
    expect(await store.renew(ref, 'a', 100)).toBe(false);
    expect(await store.acquire(ref, 'b', 100)).toBe(true);
    await store.release(ref, 'a');
    expect(await store.acquire(ref, 'a', 100)).toBe(false);
    await store.release(ref, 'b');
    expect(await store.acquire(ref, 'a', 100)).toBe(true);
    await expect(store.acquire(ref, 'a', 0)).rejects.toThrow(RangeError);
  });

  it('forgets a run with its lease, so its holder cannot renew it', async () => {
    const store = await make(() => 0);
    const ref = { runId: 'r1', threadId: 't1' };
    await store.save(record('r1', 't1'));
    await store.save(record('r2', 't1'));
    await store.acquire(ref, 'a', 100);

    await store.delete(ref);

    expect(await store.load(ref)).toBeNull();
    expect(await store.renew(ref, 'a', 100)).toBe(false);
    expect((await store.list()).map((run) => run.runId)).toEqual(['r2']);
    await store.delete({ runId: 'r2', threadId: 't1' });
    expect(await store.list()).toEqual([]);
  });
});
