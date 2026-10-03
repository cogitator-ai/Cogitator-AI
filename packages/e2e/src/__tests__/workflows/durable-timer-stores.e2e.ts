import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import pg from 'pg';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import { PostgresTimerStore, RedisTimerStore, TimerManager } from '@cogitator-ai/workflows';
import type { TimerEntry, TimerStore } from '@cogitator-ai/types';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;
const describePostgres = process.env.TEST_POSTGRES_URL ? describe : describe.skip;

const NOW = 1_700_000_000_000;

const timer = (overrides: Partial<TimerEntry> = {}) => ({
  workflowId: 'wf-1',
  runId: 'run-1',
  nodeId: 'wait',
  firesAt: NOW + 1_000,
  type: 'fixed' as const,
  ...overrides,
});

const ids = (timers: TimerEntry[]) => timers.map((t) => t.id);

/** The behaviour every TimerStore shares, against a fresh, empty store per test. */
function timerStoreContract(createStore: () => TimerStore) {
  afterEach(() => {
    vi.useRealTimers();
  });

  const start = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    return createStore();
  };

  it('schedules, reads and lists timers by workflow and run in firesAt order', async () => {
    const store = start();
    const late = await store.schedule(timer({ firesAt: NOW + 3_000, metadata: { n: 1 } }));
    const early = await store.schedule(timer({ firesAt: NOW + 1_000, runId: 'run-2' }));
    const other = await store.schedule(timer({ workflowId: 'wf-2', firesAt: NOW + 2_000 }));
    await store.markFired(early);

    expect(await store.get(late)).toEqual({
      ...timer({ firesAt: NOW + 3_000, metadata: { n: 1 } }),
      id: late,
      cancelled: false,
      fired: false,
      createdAt: NOW,
    });
    expect(await store.get('timer_missing')).toBeNull();
    expect(ids(await store.getByWorkflow('wf-1'))).toEqual([early, late]);
    expect(ids(await store.getByRun('run-1'))).toEqual([other, late]);
  });

  it('hands out only due pending timers, oldest first', async () => {
    const store = start();
    const due = await store.schedule(timer({ firesAt: NOW - 500 }));
    const dueNow = await store.schedule(timer({ firesAt: NOW }));
    const older = await store.schedule(timer({ firesAt: NOW - 900 }));
    const future = await store.schedule(timer({ firesAt: NOW + 500 }));
    const fired = await store.schedule(timer({ firesAt: NOW - 300 }));
    const cancelled = await store.schedule(timer({ firesAt: NOW - 200 }));
    await store.markFired(fired);
    await store.cancel(cancelled);
    await store.cancel(fired);

    expect(await store.get(fired)).toMatchObject({ fired: true, cancelled: false });
    expect(ids(await store.getPending())).toEqual([older, due, dueNow, future]);
    expect(ids(await store.getOverdue())).toEqual([older, due, dueNow]);
  });

  it('fires onFire listeners once, isolating failing listeners', async () => {
    const store = start();
    const seen: string[] = [];
    store.onFire(() => {
      throw new Error('listener broke');
    });
    const unsubscribe = store.onFire((entry) => seen.push(entry.id));
    const id = await store.schedule(timer());

    await store.markFired(id);
    await store.markFired(id);
    unsubscribe();
    await store.markFired(await store.schedule(timer()));

    expect(seen).toEqual([id]);
  });

  it('cleans up finished timers created before the cutoff', async () => {
    const store = start();
    const oldFired = await store.schedule(timer());
    const oldCancelled = await store.schedule(timer({ firesAt: NOW + 1_500 }));
    const oldPending = await store.schedule(timer({ firesAt: NOW + 2_000 }));
    await store.markFired(oldFired);
    await store.cancel(oldCancelled);
    vi.setSystemTime(NOW + 10_000);
    const recentFired = await store.schedule(timer({ firesAt: NOW + 3_000 }));
    await store.markFired(recentFired);

    expect(await store.cleanup(5_000)).toBe(2);
    expect(ids(await store.getByWorkflow('wf-1'))).toEqual([oldPending, recentFired]);
    expect(await store.cleanup(5_000)).toBe(0);
  });

  it('patches timers and re-indexes what moved', async () => {
    const store = start();
    const id = await store.schedule(timer({ firesAt: NOW + 60_000, lastError: 'old' }));
    expect(await store.getOverdue()).toEqual([]);

    await store.update(id, { firesAt: NOW - 1, workflowId: 'wf-2', consecutiveErrors: 2 });

    expect(await store.get(id)).toMatchObject({ firesAt: NOW - 1, consecutiveErrors: 2 });
    expect(await store.getByWorkflow('wf-1')).toEqual([]);
    expect(ids(await store.getByWorkflow('wf-2'))).toEqual([id]);
    expect(ids(await store.getOverdue())).toEqual([id]);

    await store.update(id, { cancelled: true });
    expect(await store.getPending()).toEqual([]);
  });

  it('lists timers filtered by enabled (default true) and type', async () => {
    const store = start();
    const fixed = await store.schedule(timer({ firesAt: NOW + 3 }));
    const disabled = await store.schedule(timer({ firesAt: NOW + 2, enabled: false }));
    const cron = await store.schedule(timer({ firesAt: NOW + 1, type: 'cron' }));

    expect(ids(await store.list())).toEqual([cron, disabled, fixed]);
    expect(ids(await store.list({ enabled: true }))).toEqual([cron, fixed]);
    expect(ids(await store.list({ enabled: false, type: 'fixed' }))).toEqual([disabled]);
  });
}

/** Two workers polling one backend handle each overdue timer exactly once. */
function twoWorkerClaims(createPair: (claimTtl: number) => [TimerStore, TimerStore]) {
  it('splits overdue timers between two managers, each handled once', async () => {
    const [first, second] = createPair(30_000);
    const scheduled = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        first.schedule(timer({ firesAt: Date.now() - 1_000 - i, nodeId: `n${i}` }))
      )
    );
    const handled = new Map<string, string[]>();
    const managers = [first, second].map((store, worker) => {
      const manager = new TimerManager(store, { enableCleanup: false });
      manager.setDefaultHandler(async (entry) => {
        handled.set(entry.id, [...(handled.get(entry.id) ?? []), `worker-${worker}`]);
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
      return manager;
    });

    const counts = await Promise.all(managers.map((manager) => manager.processNow()));

    expect(counts[0] + counts[1]).toBe(25);
    expect([...handled.keys()].sort()).toEqual([...scheduled].sort());
    expect([...handled.values()].every((workers) => workers.length === 1)).toBe(true);
    expect(await first.getPending()).toEqual([]);
    expect(await Promise.all(managers.map((manager) => manager.processNow()))).toEqual([0, 0]);
  });

  it('gives the claims of a crashed worker to another worker after the lease', async () => {
    const [crashed, survivor] = createPair(400);
    const id = await crashed.schedule(timer({ firesAt: Date.now() - 10 }));

    expect(ids(await crashed.getOverdue())).toEqual([id]);
    expect(await survivor.getOverdue()).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const handled: string[] = [];
    const manager = new TimerManager(survivor, { enableCleanup: false });
    manager.setDefaultHandler((entry) => {
      handled.push(entry.id);
    });

    expect(await manager.processNow()).toBe(1);
    expect(handled).toEqual([id]);
    expect(await survivor.get(id)).toMatchObject({ fired: true });
    expect(await crashed.getOverdue()).toEqual([]);
  });
}

describeRedis('Workflows: timer stores in Redis', () => {
  let client: RedisClient;
  const root = `e2e:timers:${Date.now()}`;
  let stores = 0;

  beforeAll(async () => {
    client = await createRedisClient({ url: 'redis://localhost:6379' });
  });

  afterAll(async () => {
    const keys = await client.keys(`${root}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  describe('contract', () => {
    timerStoreContract(() => new RedisTimerStore({ client, keyPrefix: `${root}:${++stores}` }));
  });

  describe('claims', () => {
    twoWorkerClaims((claimTtl) => {
      const keyPrefix = `${root}:${++stores}`;
      return [
        new RedisTimerStore({ client, keyPrefix, claimTtl }),
        new RedisTimerStore({ client, keyPrefix, claimTtl }),
      ];
    });
  });
});

describePostgres('Workflows: timer stores in Postgres', () => {
  let pool: pg.Pool;
  const root = `wf_timers_${Date.now()}`;
  const tables: string[] = [];

  const table = (name: string) => {
    const full = `${root}_${name}`;
    if (!tables.includes(full)) tables.push(full);
    return full;
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  });

  afterAll(async () => {
    for (const name of tables) await pool.query(`DROP TABLE IF EXISTS ${name}`);
    await pool.end();
  });

  describe('contract', () => {
    let stores = 0;
    timerStoreContract(
      () => new PostgresTimerStore({ client: pool, table: table(`c${++stores}`) })
    );
  });

  describe('claims', () => {
    let pairs = 0;
    twoWorkerClaims((claimTtl) => {
      const name = table(`w${++pairs}`);
      return [
        new PostgresTimerStore({ client: pool, table: name, claimTtl }),
        new PostgresTimerStore({ client: pool, table: name, claimTtl }),
      ];
    });
  });
});
