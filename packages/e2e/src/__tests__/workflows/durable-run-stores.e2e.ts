import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Cogitator } from '@cogitator-ai/core';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import {
  PostgresRunStore,
  RedisRunStore,
  WorkflowBuilder,
  createWorkflowManager,
} from '@cogitator-ai/workflows';
import type { RunStore, WorkflowRun } from '@cogitator-ai/types';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;
const describePostgres = process.env.TEST_POSTGRES_URL ? describe : describe.skip;

const BASE = 1_700_000_000_000;

function makeRun(id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowName: 'orders',
    status: 'completed',
    state: { step: id, attempts: 2, nested: { ratio: 0.25 } },
    input: { amount: 42.5 },
    currentNodes: [],
    completedNodes: ['charge'],
    failedNodes: [],
    priority: 0,
    tags: [],
    ...overrides,
  };
}

const failure = { name: 'Error', message: 'boom', nodeId: 'ship' };

const fixtures = (): WorkflowRun[] => [
  makeRun('r1', {
    startedAt: BASE + 1000,
    completedAt: BASE + 1500,
    priority: 1,
    tags: ['eu', 'vip'],
    triggerId: 'cron',
  }),
  makeRun('r2', {
    status: 'failed',
    startedAt: BASE + 2000,
    completedAt: BASE + 2600,
    priority: 5,
    tags: ['us'],
    triggerId: 'cron',
    error: failure,
    failedNodes: ['ship'],
  }),
  makeRun('r3', {
    workflowName: 'billing',
    status: 'running',
    startedAt: BASE + 3000,
    priority: 3,
    tags: ['eu'],
    parentRunId: 'r1',
    currentNodes: ['invoice'],
  }),
  makeRun('r4', {
    workflowName: 'billing',
    status: 'timeout',
    startedAt: BASE + 4000,
    completedAt: BASE + 4900,
    priority: 2,
    parentRunId: 'r1',
    error: { name: 'TimeoutError', message: 'too slow' },
  }),
  makeRun('r5', {
    status: 'pending',
    priority: 4,
    tags: ['vip'],
    scheduledFor: BASE + 9000,
  }),
];

const ids = (runs: WorkflowRun[]) => runs.map((run) => run.id);

/**
 * The behaviour every RunStore shares, as `InMemoryRunStore` defines it. Ties in
 * the sort order are avoided: stores may break them differently.
 */
function runStoreContract(name: string, createStore: () => RunStore | Promise<RunStore>): void {
  describe(`${name} (RunStore contract)`, () => {
    let store: RunStore;

    beforeEach(async () => {
      store = await createStore();
      for (const run of fixtures()) await store.save(run);
    });

    it('returns a saved run intact and null for an unknown id', async () => {
      const [, r2] = fixtures();
      const loaded = await store.get('r2');

      expect(loaded).toEqual(r2);
      expect(loaded?.startedAt).toBe(BASE + 2000);
      expect(loaded?.state).toEqual({ step: 'r2', attempts: 2, nested: { ratio: 0.25 } });
      expect(await store.get('missing')).toBeNull();
    });

    it('overwrites a run saved again under the same id', async () => {
      await store.save(
        makeRun('r1', { workflowName: 'refunds', status: 'cancelled', tags: ['x'] })
      );

      expect((await store.get('r1'))?.workflowName).toBe('refunds');
      expect(ids(await store.list({ workflowName: 'orders' }))).toEqual(['r2', 'r5']);
      expect(ids(await store.list({ workflowName: 'refunds' }))).toEqual(['r1']);
      expect(ids(await store.list({ tags: ['vip'] }))).toEqual(['r5']);
      expect(await store.count()).toBe(5);
    });

    it('lists every run, newest start first by default', async () => {
      expect(ids(await store.list()).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
      expect(ids(await store.list({}))).toEqual(['r4', 'r3', 'r2', 'r1', 'r5']);
    });

    it('filters by status, one or several', async () => {
      expect(ids(await store.list({ status: 'failed' }))).toEqual(['r2']);
      expect(ids(await store.list({ status: ['running', 'pending'] }))).toEqual(['r3', 'r5']);
      expect(await store.list({ status: [] })).toEqual([]);
    });

    it('filters by workflow, trigger and parent run', async () => {
      expect(ids(await store.list({ workflowName: 'billing' }))).toEqual(['r4', 'r3']);
      expect(ids(await store.list({ triggerId: 'cron' }))).toEqual(['r2', 'r1']);
      expect(ids(await store.list({ parentRunId: 'r1' }))).toEqual(['r4', 'r3']);
      expect(await store.list({ workflowName: 'unknown' })).toEqual([]);
    });

    it('filters by any of the tags', async () => {
      expect(ids(await store.list({ tags: ['vip', 'us'] }))).toEqual(['r2', 'r1', 'r5']);
      expect(ids(await store.list({ tags: ['eu'] }))).toEqual(['r3', 'r1']);
      expect(ids(await store.list({ tags: [] }))).toHaveLength(5);
    });

    it('filters by start and completion time, bounds included', async () => {
      expect(ids(await store.list({ startedAfter: BASE + 2000 }))).toEqual(['r4', 'r3', 'r2']);
      expect(ids(await store.list({ startedBefore: BASE + 2000 }))).toEqual(['r2', 'r1']);
      expect(
        ids(await store.list({ startedAfter: BASE + 1500, startedBefore: BASE + 3500 }))
      ).toEqual(['r3', 'r2']);
      expect(ids(await store.list({ completedAfter: BASE + 2600 }))).toEqual(['r4', 'r2']);
      expect(ids(await store.list({ completedBefore: BASE + 2600 }))).toEqual(['r2', 'r1']);
    });

    it('filters by whether the run failed with an error', async () => {
      expect(ids(await store.list({ hasError: true }))).toEqual(['r4', 'r2']);
      expect(ids(await store.list({ hasError: false }))).toEqual(['r3', 'r1', 'r5']);
    });

    it('combines filters', async () => {
      expect(
        ids(
          await store.list({
            workflowName: 'orders',
            status: ['completed', 'failed'],
            tags: ['eu', 'us'],
            hasError: false,
          })
        )
      ).toEqual(['r1']);
      expect(
        ids(await store.list({ workflowName: 'billing', hasError: true, startedAfter: BASE }))
      ).toEqual(['r4']);
    });

    it('sorts by start, completion time or priority in either direction', async () => {
      expect(ids(await store.list({ orderDirection: 'asc' }))).toEqual([
        'r5',
        'r1',
        'r2',
        'r3',
        'r4',
      ]);
      expect(ids(await store.list({ orderBy: 'priority' }))).toEqual([
        'r2',
        'r5',
        'r3',
        'r4',
        'r1',
      ]);
      expect(ids(await store.list({ orderBy: 'priority', orderDirection: 'asc' }))).toEqual([
        'r1',
        'r4',
        'r3',
        'r5',
        'r2',
      ]);
      expect(
        ids(
          await store.list({ orderBy: 'completedAt', status: ['completed', 'failed', 'timeout'] })
        )
      ).toEqual(['r4', 'r2', 'r1']);
      expect(
        ids(
          await store.list({
            orderBy: 'completedAt',
            orderDirection: 'asc',
            status: ['completed', 'failed', 'timeout'],
          })
        )
      ).toEqual(['r1', 'r2', 'r4']);
    });

    it('pages with limit and offset after sorting', async () => {
      expect(ids(await store.list({ limit: 2 }))).toEqual(['r4', 'r3']);
      expect(ids(await store.list({ limit: 2, offset: 2 }))).toEqual(['r2', 'r1']);
      expect(ids(await store.list({ offset: 4 }))).toEqual(['r5']);
      expect(ids(await store.list({ offset: 10 }))).toEqual([]);
      expect(await store.list({ limit: 0 })).toEqual([]);
      expect(ids(await store.list({ workflowName: 'orders', limit: 1, offset: 1 }))).toEqual([
        'r1',
      ]);
    });

    it('counts matching runs, ignoring limit and offset', async () => {
      expect(await store.count()).toBe(5);
      expect(await store.count({ workflowName: 'orders', limit: 1, offset: 1 })).toBe(3);
      expect(await store.count({ hasError: true })).toBe(2);
      expect(await store.count({ tags: ['vip'], status: 'pending' })).toBe(1);
      expect(await store.count({ status: 'paused' })).toBe(0);
    });

    it('merges updates into the stored run and re-indexes it', async () => {
      await store.update('r3', {
        status: 'completed',
        completedAt: BASE + 3700,
        output: { invoice: 'inv-1' },
        tags: ['apac'],
        currentNodes: [],
      });

      expect(await store.get('r3')).toEqual({
        ...fixtures()[2],
        status: 'completed',
        completedAt: BASE + 3700,
        output: { invoice: 'inv-1' },
        tags: ['apac'],
        currentNodes: [],
      });
      expect(await store.list({ status: 'running' })).toEqual([]);
      expect(ids(await store.list({ status: 'completed' }))).toEqual(['r3', 'r1']);
      expect(ids(await store.list({ tags: ['eu'] }))).toEqual(['r1']);
      expect(ids(await store.list({ tags: ['apac'] }))).toEqual(['r3']);
      expect(ids(await store.list({ completedAfter: BASE + 3000 }))).toEqual(['r4', 'r3']);
    });

    it('drops fields updated to undefined', async () => {
      await store.update('r2', { error: undefined, status: 'completed' });

      expect((await store.get('r2'))?.error).toBeUndefined();
      expect(ids(await store.list({ hasError: true }))).toEqual(['r4']);
      expect(ids(await store.list({ hasError: false, workflowName: 'orders' }))).toEqual([
        'r2',
        'r1',
        'r5',
      ]);
    });

    it('ignores updates to an unknown run', async () => {
      await store.update('missing', { status: 'failed' });

      expect(await store.get('missing')).toBeNull();
      expect(await store.count()).toBe(5);
    });

    it('aggregates statistics over all runs or one workflow', async () => {
      const all = await store.getStats();
      expect(all.total).toBe(5);
      expect(all.byStatus).toEqual({
        pending: 1,
        scheduled: 0,
        running: 1,
        paused: 0,
        waiting: 0,
        completed: 1,
        failed: 1,
        cancelled: 0,
        timeout: 1,
      });
      expect(all.avgDuration).toBeCloseTo((500 + 600 + 900) / 3, 6);
      expect(all.successRate).toBeCloseTo(1 / 3, 6);
      expect(all.failureRate).toBeCloseTo(2 / 3, 6);

      const orders = await store.getStats('orders');
      expect(orders.total).toBe(3);
      expect(orders.byStatus.pending).toBe(1);
      expect(orders.avgDuration).toBe(550);
      expect(orders.successRate).toBe(0.5);
      expect(orders.failureRate).toBe(0.5);

      const none = await store.getStats('unknown');
      expect(none).toMatchObject({ total: 0, avgDuration: 0, successRate: 0, failureRate: 0 });
    });

    it('deletes a run from the store and every filter', async () => {
      await store.delete('r2');
      await store.delete('missing');

      expect(await store.get('r2')).toBeNull();
      expect(ids(await store.list({}))).toEqual(['r4', 'r3', 'r1', 'r5']);
      expect(await store.list({ tags: ['us'] })).toEqual([]);
      expect(ids(await store.list({ triggerId: 'cron' }))).toEqual(['r1']);
      expect(await store.count()).toBe(4);
      expect((await store.getStats()).byStatus.failed).toBe(0);
    });

    it('cleans up finished runs older than the cutoff and reports how many', async () => {
      for (const run of fixtures()) await store.delete(run.id);
      const now = Date.now();
      const old = now - 60_000;
      await store.save(makeRun('done-old', { startedAt: old - 500, completedAt: old }));
      await store.save(makeRun('failed-old', { status: 'failed', startedAt: old }));
      await store.save(makeRun('cancelled-untimed', { status: 'cancelled' }));
      await store.save(makeRun('timeout-old', { status: 'timeout', completedAt: old }));
      await store.save(makeRun('running-old', { status: 'running', startedAt: old }));
      await store.save(makeRun('paused-untimed', { status: 'paused' }));
      await store.save(makeRun('done-recent', { startedAt: now - 1000, completedAt: now - 100 }));
      await store.save(
        makeRun('done-late', { status: 'completed', startedAt: old, completedAt: now - 100 })
      );

      expect(await store.cleanup(30_000)).toBe(4);
      expect(ids(await store.list()).sort()).toEqual([
        'done-late',
        'done-recent',
        'paused-untimed',
        'running-old',
      ]);
      expect(await store.get('done-old')).toBeNull();
      expect(await store.count({ status: ['completed', 'failed', 'cancelled', 'timeout'] })).toBe(
        2
      );
      expect(await store.cleanup(30_000)).toBe(0);
    });
  });
}

/** A run executed by one manager is read back, with its stats, through a fresh store. */
async function recordsManagerRuns(createStore: () => RunStore, name: string) {
  const cogitator = new Cogitator();
  const workflow = new WorkflowBuilder<{ total?: number }>(name)
    .initialState({})
    .addNode('sum', async () => ({ state: { total: 42 } }))
    .build();
  const manager = createWorkflowManager({ cogitator, runStore: createStore() });

  await manager.execute(workflow, undefined, { tags: ['e2e'] });
  manager.dispose();

  const store = createStore();
  const [run] = await store.list({ workflowName: name, tags: ['e2e'] });
  expect(run.status).toBe('completed');
  expect(run.state).toMatchObject({ total: 42 });
  expect(run.completedAt).toBeGreaterThanOrEqual(run.startedAt ?? Infinity);
  expect((await store.getStats(name)).successRate).toBe(1);
  await cogitator.close();
}

describeRedis('Workflows: runs in Redis', () => {
  let client: RedisClient;
  const prefix = `e2e:wf-runs:${Date.now()}`;
  let stores = 0;

  beforeAll(async () => {
    client = await createRedisClient({ url: 'redis://localhost:6379' });
  });

  afterAll(async () => {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  runStoreContract('RedisRunStore', () => {
    stores++;
    return new RedisRunStore({ client, keyPrefix: `${prefix}:${stores}` });
  });

  it('records the runs of a workflow manager', async () => {
    await recordsManagerRuns(
      () => new RedisRunStore({ client, keyPrefix: `${prefix}:manager` }),
      `orders-redis-${Date.now()}`
    );
  });
});

describePostgres('Workflows: runs in Postgres', () => {
  let pool: pg.Pool;
  const tables: string[] = [];
  const newTable = () => {
    const table = `wf_runs_${Date.now()}_${tables.length}`;
    tables.push(table);
    return table;
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL });
  });

  afterAll(async () => {
    for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  runStoreContract(
    'PostgresRunStore',
    () => new PostgresRunStore({ client: pool, table: newTable() })
  );

  it('records the runs of a workflow manager', async () => {
    const table = newTable();
    await recordsManagerRuns(
      () => new PostgresRunStore({ client: pool, table }),
      `orders-pg-${Date.now()}`
    );
  });
});
