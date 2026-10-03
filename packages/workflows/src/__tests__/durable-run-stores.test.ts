import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RunStore, WorkflowRun } from '@cogitator-ai/types';
import { InMemoryRunStore } from '../manager/run-store';
import {
  PostgresRunStore,
  RedisRunStore,
  type RunStorePgClient,
  type RunStoreRedisClient,
} from '../manager/durable-run-stores';

/** Enough of Redis for the store: strings and sorted sets. */
function fakeRedis(): RunStoreRedisClient & { keys(): string[] } {
  const strings = new Map<string, string>();
  const sets = new Map<string, Map<string, number>>();
  const sorted = (key: string) =>
    [...(sets.get(key) ?? new Map<string, number>()).entries()].sort(
      ([a, sa], [b, sb]) => sa - sb || (a < b ? -1 : a > b ? 1 : 0)
    );
  const bound = (value: number | string) =>
    value === '-inf' ? -Infinity : value === '+inf' ? Infinity : Number(value);
  return {
    keys: () => [
      ...strings.keys(),
      ...[...sets.entries()].filter(([, s]) => s.size > 0).map(([k]) => k),
    ],
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value) => {
      strings.set(key, value);
      return 'OK';
    },
    del: async (...keys) => keys.filter((key) => strings.delete(key)).length,
    zadd: async (key, score, member) => {
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sets.set(key, set);
      return 1;
    },
    zrange: async (key) => sorted(key).map(([member]) => member),
    zrangebyscore: async (key, min, max) =>
      sorted(key)
        .filter(([, score]) => score >= bound(min) && score <= bound(max))
        .map(([member]) => member),
    zrem: async (key, ...members) => {
      for (const member of members) sets.get(key)?.delete(member);
      return members.length;
    },
  };
}

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

runStoreContract('InMemoryRunStore', () => new InMemoryRunStore());
runStoreContract('RedisRunStore', () => new RedisRunStore({ client: fakeRedis() }));

describe('RedisRunStore', () => {
  it('keeps every key under its prefix and leaves none behind once runs are gone', async () => {
    const client = fakeRedis();
    const store = new RedisRunStore({ client, keyPrefix: 'app:runs' });
    for (const run of fixtures()) await store.save(run);

    expect(client.keys().every((key) => key.startsWith('app:runs:'))).toBe(true);
    expect(client.keys()).toContain('app:runs:run:r1');

    for (const run of fixtures()) await store.delete(run.id);
    expect(client.keys()).toEqual([]);
  });

  it('prunes index entries whose run document is gone', async () => {
    const client = fakeRedis();
    const store = new RedisRunStore({ client });
    await store.save(makeRun('r1', { tags: ['eu'] }));
    await client.del('cogitator:workflow-runs:run:r1');

    expect(await store.list({ tags: ['eu'] })).toEqual([]);
    expect(await client.zrange('cogitator:workflow-runs:index:tag:eu', 0, -1)).toEqual([]);
    expect(await client.zrange('cogitator:workflow-runs:index:all', 0, -1)).toEqual([]);
  });

  it('does not trust a stale index entry', async () => {
    const client = fakeRedis();
    const store = new RedisRunStore({ client });
    await store.save(makeRun('r1', { status: 'running' }));
    await client.zadd('cogitator:workflow-runs:index:status:failed', 0, 'r1');

    expect(await store.list({ status: 'failed' })).toEqual([]);
    expect(await store.count({ status: 'failed' })).toBe(0);
  });
});

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

/** Records the SQL it receives and answers with rows queued per statement prefix. */
function fakePostgres(): RunStorePgClient & {
  queries: RecordedQuery[];
  answer(prefix: string, rows: Array<Record<string, unknown>>): void;
  sent(prefix: string): RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const answers: Array<{ prefix: string; rows: Array<Record<string, unknown>> }> = [];
  return {
    queries,
    answer: (prefix, rows) => answers.push({ prefix, rows }),
    sent: (prefix) => queries.filter((query) => query.sql.startsWith(prefix)),
    query: async (text, values = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      queries.push({ sql, values });
      const index = answers.findIndex((answer) => sql.startsWith(answer.prefix));
      if (index === -1) return { rows: [] };
      const [answer] = answers.splice(index, 1);
      return { rows: answer.rows };
    },
  };
}

describe('PostgresRunStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates its table and indexes once, before the first query', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client, table: 'app.runs' });

    await store.get('r1');
    await store.count();

    const creates = client.sent('CREATE');
    expect(creates).toHaveLength(8);
    expect(creates[0].sql).toContain('CREATE TABLE IF NOT EXISTS app.runs (');
    expect(creates[0].sql).toContain('data JSONB NOT NULL');
    expect(creates.slice(1).map((query) => query.sql)).toEqual([
      'CREATE INDEX IF NOT EXISTS app_runs_workflow_idx ON app.runs (workflow_name, (COALESCE(started_at, 0)), id)',
      'CREATE INDEX IF NOT EXISTS app_runs_started_idx ON app.runs ((COALESCE(started_at, 0)), id)',
      'CREATE INDEX IF NOT EXISTS app_runs_status_idx ON app.runs (status)',
      'CREATE INDEX IF NOT EXISTS app_runs_completed_idx ON app.runs (completed_at)',
      'CREATE INDEX IF NOT EXISTS app_runs_tags_idx ON app.runs USING GIN (tags)',
      'CREATE INDEX IF NOT EXISTS app_runs_trigger_idx ON app.runs (trigger_id) WHERE trigger_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS app_runs_parent_idx ON app.runs (parent_run_id) WHERE parent_run_id IS NOT NULL',
    ]);
    expect(client.queries.findIndex((query) => !query.sql.startsWith('CREATE'))).toBe(8);
  });

  it('retries table creation after a failure', async () => {
    const client = fakePostgres();
    const query = client.query;
    let failures = 1;
    client.query = async (text, values) => {
      if (text.includes('CREATE TABLE') && failures-- > 0) throw new Error('connection reset');
      return query(text, values);
    };
    const store = new PostgresRunStore({ client });

    await expect(store.get('r1')).rejects.toThrow('connection reset');
    await expect(store.get('r1')).resolves.toBeNull();
  });

  it('refuses table names that are not plain identifiers', () => {
    expect(
      () => new PostgresRunStore({ client: fakePostgres(), table: 'x; DROP TABLE y' })
    ).toThrow('Invalid run table name');
  });

  it('upserts the run as JSONB and derives the indexed columns from it', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });
    const run = fixtures()[1];

    await store.save(run);

    const [insert] = client.sent('INSERT');
    expect(insert.sql).toContain(
      'INSERT INTO cogitator_workflow_runs (id, workflow_name, status, started_at, completed_at, priority, tags, trigger_id, parent_run_id, has_error, data)'
    );
    expect(insert.sql).toContain("SELECT $1::text, doc->>'workflowName', doc->>'status'");
    expect(insert.sql).toContain("ARRAY(SELECT jsonb_array_elements_text(doc->'tags'))");
    expect(insert.sql).toContain('FROM (SELECT $2::jsonb AS doc) AS run');
    expect(insert.sql).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(insert.values[0]).toBe('r2');
    expect(JSON.parse(String(insert.values[1]))).toEqual(run);
  });

  it('loads a run whether the driver returns JSONB parsed or as text', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });
    const run = fixtures()[0];
    client.answer('SELECT data', [{ data: run }]);
    client.answer('SELECT data', [{ data: JSON.stringify(run) }]);

    expect(await store.get('r1')).toEqual(run);
    expect(await store.get('r1')).toEqual(run);
    expect(await store.get('missing')).toBeNull();
    expect(client.sent('SELECT data').map((query) => query.sql)).toEqual(
      Array(3).fill('SELECT data FROM cogitator_workflow_runs WHERE id = $1')
    );
    expect(client.sent('SELECT data')[2].values).toEqual(['missing']);
  });

  it('lists newest first without a WHERE clause when nothing filters', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });
    client.answer('SELECT data', [{ data: fixtures()[3] }, { data: fixtures()[2] }]);

    expect(ids(await store.list())).toEqual(['r4', 'r3']);
    await store.list({ workflowName: '', tags: [], startedAfter: 0, completedBefore: 0 });

    for (const query of client.sent('SELECT data')) {
      expect(query.sql).toBe(
        'SELECT data FROM cogitator_workflow_runs ORDER BY COALESCE(started_at, 0) DESC, id DESC'
      );
      expect(query.values).toEqual([]);
    }
  });

  it('turns every filter, the order and the page into parameterised SQL', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });

    await store.list({
      status: ['completed', 'failed'],
      workflowName: 'orders',
      tags: ['eu', 'vip'],
      triggerId: 'cron',
      parentRunId: 'r0',
      startedAfter: 100,
      startedBefore: 200,
      completedAfter: 300,
      completedBefore: 400,
      hasError: false,
      orderBy: 'priority',
      orderDirection: 'asc',
      limit: 10,
      offset: 20,
    });

    const [query] = client.sent('SELECT data');
    expect(query.sql).toBe(
      'SELECT data FROM cogitator_workflow_runs WHERE status = ANY($1::text[]) AND workflow_name = $2 ' +
        'AND tags && $3::text[] AND trigger_id = $4 AND parent_run_id = $5 ' +
        'AND started_at <> 0 AND started_at >= $6 AND started_at <= $7 ' +
        'AND completed_at <> 0 AND completed_at >= $8 AND completed_at <= $9 AND has_error = $10 ' +
        'ORDER BY COALESCE(priority, 0) ASC, id ASC LIMIT $11 OFFSET $12'
    );
    expect(query.values).toEqual([
      ['completed', 'failed'],
      'orders',
      ['eu', 'vip'],
      'cron',
      'r0',
      100,
      200,
      300,
      400,
      false,
      10,
      20,
    ]);
  });

  it('passes a single status as an array and sorts by completion time', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });

    await store.list({ status: 'running', orderBy: 'completedAt', limit: 0 });

    const [query] = client.sent('SELECT data');
    expect(query.sql).toBe(
      'SELECT data FROM cogitator_workflow_runs WHERE status = ANY($1::text[]) ' +
        'ORDER BY COALESCE(completed_at, 0) DESC, id DESC LIMIT $2'
    );
    expect(query.values).toEqual([['running'], 0]);
  });

  it('counts with the same filters and no page', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });
    client.answer('SELECT COUNT', [{ count: 3 }]);

    expect(await store.count({ workflowName: 'orders', hasError: true, limit: 1, offset: 2 })).toBe(
      3
    );
    expect(await store.count()).toBe(0);

    const [filtered, all] = client.sent('SELECT COUNT');
    expect(filtered.sql).toBe(
      'SELECT COUNT(*)::int AS count FROM cogitator_workflow_runs WHERE workflow_name = $1 AND has_error = $2'
    );
    expect(filtered.values).toEqual(['orders', true]);
    expect(all.sql).toBe('SELECT COUNT(*)::int AS count FROM cogitator_workflow_runs');
  });

  it('merges updates into the stored document in one statement, keeping the id', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });

    await store.update('r1', {
      id: 'other',
      status: 'completed',
      output: { ok: true },
      error: undefined,
    });

    const [update] = client.sent('UPDATE');
    expect(update.sql).toContain(
      'UPDATE cogitator_workflow_runs SET (workflow_name, status, started_at, completed_at, priority, tags, trigger_id, parent_run_id, has_error, data) = ( SELECT'
    );
    expect(update.sql).toContain('FROM (SELECT (data || $2::jsonb) - $3::text[] AS doc) AS run');
    expect(update.sql).toMatch(/WHERE id = \$1$/);
    expect(update.values[0]).toBe('r1');
    expect(JSON.parse(String(update.values[1]))).toEqual({
      status: 'completed',
      output: { ok: true },
    });
    expect(update.values[2]).toEqual(['error']);
  });

  it('deletes by id', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });

    await store.delete('r1');

    expect(client.sent('DELETE')).toEqual([
      { sql: 'DELETE FROM cogitator_workflow_runs WHERE id = $1', values: ['r1'] },
    ]);
  });

  it('aggregates statistics per status in SQL', async () => {
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });
    client.answer('SELECT status', [
      { status: 'completed', runs: 3, duration_total: 900, duration_count: 3 },
      { status: 'failed', runs: 1, duration_total: '100', duration_count: 1 },
      { status: 'running', runs: 2, duration_total: 0, duration_count: 0 },
      { status: 'archived', runs: 1, duration_total: 0, duration_count: 0 },
    ]);

    const stats = await store.getStats('orders');
    await store.getStats();

    expect(stats.total).toBe(7);
    expect(stats.byStatus).toMatchObject({ completed: 3, failed: 1, running: 2, timeout: 0 });
    expect(stats.avgDuration).toBe(250);
    expect(stats.successRate).toBe(0.75);
    expect(stats.failureRate).toBe(0.25);

    const [one, all] = client.sent('SELECT status');
    expect(one.sql).toContain(
      'COALESCE(SUM(completed_at - started_at) FILTER (WHERE started_at <> 0 AND completed_at <> 0), 0) AS duration_total'
    );
    expect(one.sql).toContain(
      'FROM cogitator_workflow_runs WHERE workflow_name = $1 GROUP BY status'
    );
    expect(one.values).toEqual(['orders']);
    expect(all.sql).toContain('FROM cogitator_workflow_runs GROUP BY status');
    expect(all.values).toEqual([]);
  });

  it('cleans up finished runs older than the cutoff and returns the count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const client = fakePostgres();
    const store = new PostgresRunStore({ client });
    client.answer('WITH removed', [{ count: 4 }]);

    expect(await store.cleanup(60_000)).toBe(4);

    const [cleanup] = client.sent('WITH removed');
    expect(cleanup.sql).toBe(
      'WITH removed AS ( DELETE FROM cogitator_workflow_runs ' +
        'WHERE status = ANY($1::text[]) AND COALESCE(completed_at, started_at, 0) < $2 RETURNING 1 ) ' +
        'SELECT COUNT(*)::int AS count FROM removed'
    );
    expect(cleanup.values).toEqual([
      ['completed', 'failed', 'cancelled', 'timeout'],
      BASE - 60_000,
    ]);
  });
});
