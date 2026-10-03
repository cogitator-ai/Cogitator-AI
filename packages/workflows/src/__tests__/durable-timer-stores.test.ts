import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TimerEntry, TimerStore } from '@cogitator-ai/types';
import {
  PostgresTimerStore,
  RedisTimerStore,
  type TimerStorePgClient,
  type TimerStoreRedisClient,
} from '../timers/durable-timer-stores';
import { InMemoryTimerStore } from '../timers/timer-store';
import { TimerManager } from '../timers/timer-manager';

const NOW = 1_700_000_000_000;

/** Enough of Redis for the store: strings and sorted sets, empty sets removed. */
function fakeRedis(): TimerStoreRedisClient & { keys(): string[] } {
  const strings = new Map<string, string>();
  const sets = new Map<string, Map<string, number>>();
  const sorted = (key: string) =>
    [...(sets.get(key) ?? new Map<string, number>()).entries()].sort(([ma, a], [mb, b]) =>
      a === b ? ma.localeCompare(mb) : a - b
    );
  const inRange = (score: number, min: number | string, max: number | string) => {
    const bound = (value: number | string): [number, boolean] => {
      if (typeof value === 'number') return [value, false];
      if (value === '-inf') return [-Infinity, false];
      if (value === '+inf') return [Infinity, false];
      return value.startsWith('(') ? [Number(value.slice(1)), true] : [Number(value), false];
    };
    const [low, lowExclusive] = bound(min);
    const [high, highExclusive] = bound(max);
    return (
      (lowExclusive ? score > low : score >= low) && (highExclusive ? score < high : score <= high)
    );
  };
  return {
    keys: () => [...strings.keys(), ...sets.keys()],
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value) => {
      strings.set(key, value);
      return 'OK';
    },
    del: async (...keys) =>
      keys.filter((key) => [strings.delete(key), sets.delete(key)].some(Boolean)).length,
    zadd: async (key, score, member) => {
      const set = sets.get(key) ?? new Map<string, number>();
      const added = set.has(member) ? 0 : 1;
      set.set(member, score);
      sets.set(key, set);
      return added;
    },
    zrange: async (key, start, stop) =>
      sorted(key)
        .slice(start, stop === -1 ? undefined : stop + 1)
        .map(([member]) => member),
    zrangebyscore: async (key, min, max) =>
      sorted(key)
        .filter(([, score]) => inRange(score, min, max))
        .map(([member]) => member),
    zrem: async (key, ...members) => {
      const set = sets.get(key);
      const removed = members.filter((member) => set?.delete(member)).length;
      if (set?.size === 0) sets.delete(key);
      return removed;
    },
  };
}

interface Statement {
  sql: string;
  values: unknown[];
}

/** Records the SQL the store sends and answers with whatever rows `respond` gives. */
function fakePostgres(
  respond: (sql: string, values: unknown[]) => Array<Record<string, unknown>> = () => []
): TimerStorePgClient & { statements: Statement[]; last(): Statement } {
  const statements: Statement[] = [];
  return {
    statements,
    last: () => statements[statements.length - 1],
    query: async (text, values = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      statements.push({ sql, values });
      return { rows: respond(sql, values) };
    },
  };
}

const timer = (overrides: Partial<TimerEntry> = {}) => ({
  workflowId: 'wf-1',
  runId: 'run-1',
  nodeId: 'wait',
  firesAt: NOW + 1_000,
  type: 'fixed' as const,
  ...overrides,
});

const ids = (timers: TimerEntry[]) => timers.map((t) => t.id);

describe.each<[string, () => TimerStore]>([
  ['InMemoryTimerStore', () => new InMemoryTimerStore()],
  ['RedisTimerStore', () => new RedisTimerStore({ client: fakeRedis() })],
])('%s contract', (_name, createStore) => {
  let store: TimerStore;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    store = createStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a pending timer and reads it back', async () => {
    const id = await store.schedule(timer({ metadata: { reason: 'sla' }, name: 'reminder' }));

    expect(id).toMatch(/^timer_/);
    expect(await store.get(id)).toEqual({
      ...timer({ metadata: { reason: 'sla' }, name: 'reminder' }),
      id,
      cancelled: false,
      fired: false,
      createdAt: NOW,
    });
    expect(await store.get('timer_missing')).toBeNull();
  });

  it('lists by workflow and by run, sorted by firesAt, finished timers included', async () => {
    const late = await store.schedule(timer({ firesAt: NOW + 3_000 }));
    const early = await store.schedule(timer({ firesAt: NOW + 1_000, runId: 'run-2' }));
    const other = await store.schedule(timer({ workflowId: 'wf-2', firesAt: NOW + 2_000 }));
    await store.markFired(early);

    expect(ids(await store.getByWorkflow('wf-1'))).toEqual([early, late]);
    expect(ids(await store.getByWorkflow('wf-2'))).toEqual([other]);
    expect(ids(await store.getByRun('run-1'))).toEqual([other, late]);
    expect(ids(await store.getByRun('run-2'))).toEqual([early]);
    expect(await store.getByWorkflow('nope')).toEqual([]);
  });

  it('keeps fired and cancelled timers out of pending and overdue', async () => {
    const due = await store.schedule(timer({ firesAt: NOW - 500 }));
    const dueNow = await store.schedule(timer({ firesAt: NOW }));
    const older = await store.schedule(timer({ firesAt: NOW - 900 }));
    const future = await store.schedule(timer({ firesAt: NOW + 500 }));
    const fired = await store.schedule(timer({ firesAt: NOW - 300 }));
    const cancelled = await store.schedule(timer({ firesAt: NOW - 200 }));
    await store.markFired(fired);
    await store.cancel(cancelled);

    expect(ids(await store.getPending())).toEqual([older, due, dueNow, future]);
    expect(ids(await store.getOverdue())).toEqual([older, due, dueNow]);
  });

  it('cancels only pending timers', async () => {
    const pending = await store.schedule(timer());
    const fired = await store.schedule(timer());
    await store.markFired(fired);

    await store.cancel(pending);
    await store.cancel(fired);
    await store.cancel('timer_missing');

    expect(await store.get(pending)).toMatchObject({ cancelled: true, fired: false });
    expect(await store.get(fired)).toMatchObject({ cancelled: false, fired: true });
  });

  it('fires onFire listeners once per timer, isolating failing listeners', async () => {
    const seen: TimerEntry[] = [];
    store.onFire(() => {
      throw new Error('listener broke');
    });
    const unsubscribe = store.onFire((entry) => seen.push(entry));
    const id = await store.schedule(timer({ firesAt: NOW - 1 }));
    const cancelled = await store.schedule(timer());
    await store.cancel(cancelled);

    await store.markFired(id);
    await store.markFired(id);
    await store.markFired(cancelled);
    await store.markFired('timer_missing');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, fired: true });
    expect(await store.get(id)).toMatchObject({ fired: true });

    unsubscribe();
    const next = await store.schedule(timer());
    await store.markFired(next);
    expect(seen).toHaveLength(1);
  });

  it('cleans up finished timers created before the cutoff and counts them', async () => {
    const oldFired = await store.schedule(timer());
    const oldCancelled = await store.schedule(timer());
    const oldPending = await store.schedule(timer());
    await store.markFired(oldFired);
    await store.cancel(oldCancelled);
    vi.setSystemTime(NOW + 10_000);
    const recentFired = await store.schedule(timer({ firesAt: NOW + 2_000 }));
    await store.markFired(recentFired);

    expect(await store.cleanup(5_000)).toBe(2);
    expect(await store.get(oldFired)).toBeNull();
    expect(await store.get(oldCancelled)).toBeNull();
    expect(await store.get(oldPending)).not.toBeNull();
    expect(await store.get(recentFired)).not.toBeNull();
    expect(ids(await store.getByWorkflow('wf-1'))).toEqual([oldPending, recentFired]);
    expect(await store.cleanup(5_000)).toBe(0);
  });

  it('patches timers, re-indexing what the patch moves', async () => {
    const id = await store.schedule(timer({ firesAt: NOW + 60_000 }));
    expect(await store.getOverdue()).toEqual([]);

    await store.update(id, {
      firesAt: NOW - 1,
      workflowId: 'wf-2',
      consecutiveErrors: 2,
      lastError: 'boom',
    });
    await store.update('timer_missing', { lastError: 'ignored' });

    expect(await store.get(id)).toMatchObject({
      firesAt: NOW - 1,
      workflowId: 'wf-2',
      consecutiveErrors: 2,
      lastError: 'boom',
    });
    expect(await store.getByWorkflow('wf-1')).toEqual([]);
    expect(ids(await store.getByWorkflow('wf-2'))).toEqual([id]);
    expect(ids(await store.getOverdue())).toEqual([id]);

    await store.update(id, { fired: true });
    expect(await store.getPending()).toEqual([]);
  });

  it('lists all timers, filtered by enabled (default true) and type', async () => {
    const fixed = await store.schedule(timer({ firesAt: NOW + 3 }));
    const disabled = await store.schedule(timer({ firesAt: NOW + 2, enabled: false }));
    const cron = await store.schedule(timer({ firesAt: NOW + 1, type: 'cron', enabled: true }));
    await store.markFired(fixed);

    expect(ids(await store.list())).toEqual([cron, disabled, fixed]);
    expect(ids(await store.list({ enabled: true }))).toEqual([cron, fixed]);
    expect(ids(await store.list({ enabled: false }))).toEqual([disabled]);
    expect(ids(await store.list({ type: 'fixed' }))).toEqual([disabled, fixed]);
    expect(ids(await store.list({ type: 'cron', enabled: true }))).toEqual([cron]);
    expect(ids(await store.list({ type: '' }))).toEqual([cron, disabled, fixed]);
  });
});

describe('RedisTimerStore claims', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const twoWorkers = () => {
    const client = fakeRedis();
    return {
      client,
      first: new RedisTimerStore({ client, keyPrefix: 'app', claimTtl: 1_000 }),
      second: new RedisTimerStore({ client, keyPrefix: 'app', claimTtl: 1_000 }),
    };
  };

  it('hands an overdue timer to one worker until its lease expires', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));

    expect(ids(await first.getOverdue())).toEqual([id]);
    expect(await second.getOverdue()).toEqual([]);
    expect(await first.getOverdue()).toEqual([]);
    expect(ids(await second.getPending())).toEqual([id]);

    vi.setSystemTime(NOW + 999);
    expect(await second.getOverdue()).toEqual([]);

    vi.setSystemTime(NOW + 1_000);
    expect(ids(await second.getOverdue())).toEqual([id]);
    expect(await first.getOverdue()).toEqual([]);
  });

  it('splits concurrent polls so each timer is handed out once', async () => {
    const { first, second } = twoWorkers();
    const scheduled = await Promise.all(
      Array.from({ length: 20 }, (_, i) => first.schedule(timer({ firesAt: NOW - i })))
    );

    const [a, b] = await Promise.all([first.getOverdue(), second.getOverdue()]);

    expect([...ids(a), ...ids(b)].sort()).toEqual([...scheduled].sort());
  });

  it('ends the claim for good once the timer fires or is cancelled', async () => {
    const { client, first, second } = twoWorkers();
    const fired = await first.schedule(timer({ firesAt: NOW - 10 }));
    const cancelled = await first.schedule(timer({ firesAt: NOW - 5 }));
    await first.getOverdue();

    await first.markFired(fired);
    await second.cancel(cancelled);
    vi.setSystemTime(NOW + 60_000);

    expect(await second.getOverdue()).toEqual([]);
    expect(await first.getOverdue()).toEqual([]);
    expect(client.keys().filter((key) => key.includes(':claim:'))).toEqual([]);

    expect(await first.cleanup(0)).toBe(2);
    expect(client.keys()).toEqual([]);
  });

  it('retries a failed timer on another manager after the lease', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));
    const handled: string[] = [];
    const failing = new TimerManager(first, { onError: () => undefined });
    failing.setDefaultHandler(() => {
      throw new Error('handler down');
    });
    const working = new TimerManager(second);
    working.setDefaultHandler((entry) => {
      handled.push(entry.id);
    });

    await failing.processNow();
    expect(await working.processNow()).toBe(0);
    expect(await second.get(id)).toMatchObject({ consecutiveErrors: 1, lastError: 'handler down' });

    vi.setSystemTime(NOW + 1_000);
    expect(await working.processNow()).toBe(1);
    expect(handled).toEqual([id]);
    expect(await first.get(id)).toMatchObject({ fired: true });
  });

  it('refuses a non-positive claimTtl', () => {
    expect(() => new RedisTimerStore({ client: fakeRedis(), claimTtl: 0 })).toThrow(
      'Invalid timer claimTtl'
    );
  });

  it('keeps a renewed timer away from other workers past its first lease', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));
    await first.getOverdue();

    vi.setSystemTime(NOW + 900);
    expect(await first.renew(id)).toBe(true);
    vi.setSystemTime(NOW + 1_899);
    expect(await second.getOverdue()).toEqual([]);

    vi.setSystemTime(NOW + 1_900);
    expect(ids(await second.getOverdue())).toEqual([id]);
  });

  it('refuses to renew a claim another worker took over', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));
    await first.getOverdue();

    vi.setSystemTime(NOW + 1_000);
    expect(ids(await second.getOverdue())).toEqual([id]);
    expect(await first.renew(id)).toBe(false);
    expect(await second.renew(id)).toBe(true);
    expect(await first.renew(id)).toBe(false);
    expect(await first.renew('timer_never_claimed')).toBe(false);
  });

  it('refuses to renew a lease that already ran out', async () => {
    const { first } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));
    await first.getOverdue();

    vi.setSystemTime(NOW + 1_000);
    expect(await first.renew(id)).toBe(false);
    expect(ids(await first.getOverdue())).toEqual([id]);
  });

  it('makes a released timer available at once, ignoring releases by non-owners', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));
    await first.getOverdue();

    await second.release(id);
    expect(await second.getOverdue()).toEqual([]);

    await first.release(id);
    expect(ids(await second.getOverdue())).toEqual([id]);
    expect(await first.renew(id)).toBe(false);
    await first.release(id);
    expect(await first.getOverdue()).toEqual([]);
    expect(await second.renew(id)).toBe(true);
    expect(first.claimTtl).toBe(1_000);
  });
});

describe('TimerManager with a claiming store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const twoWorkers = () => {
    const client = fakeRedis();
    return {
      first: new RedisTimerStore({ client, keyPrefix: 'app', claimTtl: 900 }),
      second: new RedisTimerStore({ client, keyPrefix: 'app', claimTtl: 900 }),
    };
  };

  it('renews the claim while a slow handler runs, so nobody else runs the timer', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ firesAt: NOW - 10 }));
    const renew = vi.spyOn(first, 'renew');
    const handled: string[] = [];
    let finish: () => void = () => undefined;
    const slow = new TimerManager(first);
    slow.setDefaultHandler(async (entry) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      handled.push(`slow:${entry.id}`);
    });
    const other = new TimerManager(second);
    other.setDefaultHandler((entry) => {
      handled.push(`other:${entry.id}`);
    });

    const running = slow.processNow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await other.processNow()).toBe(0);
    expect(renew).toHaveBeenCalledTimes(11);

    finish();
    expect(await running).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(renew).toHaveBeenCalledTimes(11);
    expect(await other.processNow()).toBe(0);
    expect(handled).toEqual([`slow:${id}`]);
    expect(await second.get(id)).toMatchObject({ fired: true });
  });

  it('reports a claim lost while the handler runs and stops renewing it', async () => {
    const { first } = twoWorkers();
    await first.schedule(timer({ firesAt: NOW - 10 }));
    const renew = vi.spyOn(first, 'renew').mockResolvedValueOnce(true).mockResolvedValue(false);
    const lost: string[] = [];
    let finish: () => void = () => undefined;
    const manager = new TimerManager(first, { onClaimLost: (entry) => lost.push(entry.id) });
    manager.setDefaultHandler(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    const running = manager.processNow();
    await vi.advanceTimersByTimeAsync(2_000);
    finish();
    await running;

    expect(renew).toHaveBeenCalledTimes(2);
    expect(lost).toHaveLength(1);
  });

  it('skips a batched timer whose claim another worker took while it waited', async () => {
    const { first, second } = twoWorkers();
    const blocking = await first.schedule(timer({ firesAt: NOW - 20 }));
    const waiting = await first.schedule(timer({ firesAt: NOW - 10 }));
    const handled: string[] = [];
    const lost: string[] = [];
    let finish: () => void = () => undefined;
    const slow = new TimerManager(first, { onClaimLost: (entry) => lost.push(entry.id) });
    slow.setDefaultHandler(async (entry) => {
      if (entry.id === blocking) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      handled.push(`slow:${entry.id}`);
    });
    const other = new TimerManager(second);
    other.setDefaultHandler((entry) => {
      handled.push(`other:${entry.id}`);
    });

    const running = slow.processNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await other.processNow()).toBe(1);
    finish();
    await running;

    expect(handled).toEqual([`other:${waiting}`, `slow:${blocking}`]);
    expect(lost).toEqual([waiting]);
  });

  it('releases a timer it has no handler for, so another manager runs it at once', async () => {
    const { first, second } = twoWorkers();
    const id = await first.schedule(timer({ workflowId: 'billing', firesAt: NOW - 10 }));
    const missed: string[] = [];
    const handled: string[] = [];
    const without = new TimerManager(first, { onTimerMissed: (entry) => missed.push(entry.id) });
    without.registerHandler('orders', () => undefined);
    const withHandler = new TimerManager(second);
    withHandler.registerHandler('billing', (entry) => {
      handled.push(entry.id);
    });

    await without.processNow();
    expect(missed).toEqual([id]);
    expect(await withHandler.processNow()).toBe(1);
    expect(handled).toEqual([id]);
  });

  it('releases the claims a poll takes beyond its batch', async () => {
    const { first, second } = twoWorkers();
    const early = await first.schedule(timer({ firesAt: NOW - 20 }));
    const late = await first.schedule(timer({ firesAt: NOW - 10 }));
    const manager = new TimerManager(first, {
      batchSize: 1,
      pollInterval: 100,
      processOverdueOnStart: false,
      enableCleanup: false,
    });
    manager.setDefaultHandler(() => undefined);

    await manager.start();
    await vi.advanceTimersByTimeAsync(100);
    await manager.stop();

    expect(await first.get(early)).toMatchObject({ fired: true });
    expect(ids(await second.getOverdue())).toEqual([late]);
  });
});

describe('PostgresTimerStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const stored = (overrides: Partial<TimerEntry>): TimerEntry => ({
    ...timer(),
    id: 'timer_a',
    cancelled: false,
    fired: false,
    createdAt: NOW,
    ...overrides,
  });

  it('creates its table and indexes once, before the first query', async () => {
    const client = fakePostgres();
    const store = new PostgresTimerStore({ client, table: 'app.timers' });

    await store.get('timer_a');
    await store.getPending();

    const creates = client.statements.filter((s) => s.sql.startsWith('CREATE'));
    expect(creates).toHaveLength(4);
    expect(creates[0].sql).toContain('CREATE TABLE IF NOT EXISTS app.timers');
    expect(creates[0].sql).toContain('claimed_until TIMESTAMPTZ, claimed_by TEXT');
    expect(client.statements.filter((s) => s.sql.startsWith('ALTER'))).toEqual([
      { sql: 'ALTER TABLE app.timers ADD COLUMN IF NOT EXISTS claimed_by TEXT', values: [] },
    ]);
    expect(creates.slice(1).map((s) => s.sql)).toEqual([
      'CREATE INDEX IF NOT EXISTS app_timers_due_idx ON app.timers (status, fires_at)',
      'CREATE INDEX IF NOT EXISTS app_timers_workflow_idx ON app.timers (workflow_id, fires_at)',
      'CREATE INDEX IF NOT EXISTS app_timers_run_idx ON app.timers (run_id, fires_at)',
    ]);
  });

  it('refuses table names that are not plain identifiers and bad lease lengths', () => {
    expect(
      () => new PostgresTimerStore({ client: fakePostgres(), table: 'x; DROP TABLE y' })
    ).toThrow('Invalid timer table name');
    expect(() => new PostgresTimerStore({ client: fakePostgres(), claimTtl: -1 })).toThrow(
      'Invalid timer claimTtl'
    );
  });

  it('inserts a pending row with its indexed columns and JSON', async () => {
    const client = fakePostgres();
    const store = new PostgresTimerStore({ client });

    const id = await store.schedule(timer({ firesAt: NOW + 5 }));

    const { sql, values } = client.last();
    expect(sql).toMatch(
      /^INSERT INTO cogitator_workflow_timers .* VALUES \(\$1, \$2, \$3, 'pending'/
    );
    expect(values.slice(0, 5)).toEqual([id, 'wf-1', 'run-1', NOW + 5, NOW]);
    expect(JSON.parse(values[5] as string)).toMatchObject({ id, fired: false, cancelled: false });
  });

  it('claims overdue rows with SKIP LOCKED and returns them sorted', async () => {
    const client = fakePostgres((sql) =>
      sql.startsWith('UPDATE')
        ? [
            { data: JSON.stringify(stored({ id: 'timer_b', firesAt: NOW - 1 })) },
            { data: stored({ id: 'timer_a', firesAt: NOW - 9 }) },
          ]
        : []
    );
    const store = new PostgresTimerStore({ client, claimTtl: 5_000 });

    expect(ids(await store.getOverdue())).toEqual(['timer_a', 'timer_b']);

    const { sql, values } = client.last();
    expect(sql).toContain(
      "SET claimed_until = now() + $2::double precision * interval '1 millisecond', claimed_by = $3"
    );
    expect(sql).toContain(
      "WHERE status = 'pending' AND fires_at <= $1::double precision AND (claimed_until IS NULL OR claimed_until <= now())"
    );
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('RETURNING data');
    expect(values).toEqual([NOW, 5_000, expect.any(String)]);
  });

  it('renews and releases only the claims this instance holds', async () => {
    let renewed: Array<Record<string, unknown>> = [];
    const client = fakePostgres((sql) =>
      sql.startsWith('UPDATE') && sql.includes('RETURNING id') ? renewed : []
    );
    const store = new PostgresTimerStore({ client, claimTtl: 5_000 });
    const other = new PostgresTimerStore({ client, claimTtl: 5_000 });
    await store.getOverdue();
    const owner = client.last().values[2];
    await other.getOverdue();
    expect(client.last().values[2]).not.toBe(owner);

    expect(await store.renew('timer_a')).toBe(false);
    expect(client.last()).toEqual({
      sql: "UPDATE cogitator_workflow_timers SET claimed_until = now() + $3::double precision * interval '1 millisecond' WHERE id = $1 AND claimed_by = $2 AND status = 'pending' AND claimed_until > now() RETURNING id",
      values: ['timer_a', owner, 5_000],
    });
    renewed = [{ id: 'timer_a' }];
    expect(await store.renew('timer_a')).toBe(true);

    await store.release('timer_a');
    expect(client.last()).toEqual({
      sql: "UPDATE cogitator_workflow_timers SET claimed_until = NULL, claimed_by = NULL WHERE id = $1 AND claimed_by = $2 AND status = 'pending'",
      values: ['timer_a', owner],
    });
    expect(store.claimTtl).toBe(5_000);
  });

  it('fires listeners only when markFired moved a pending row', async () => {
    let firedRows: Array<Record<string, unknown>> = [];
    const client = fakePostgres((sql) => (sql.startsWith('UPDATE') ? firedRows : []));
    const store = new PostgresTimerStore({ client });
    const seen: string[] = [];
    store.onFire((entry) => seen.push(entry.id));

    await store.markFired('timer_a');
    expect(seen).toEqual([]);
    expect(client.last().sql).toContain(
      "SET status = $2::text, claimed_until = NULL, claimed_by = NULL, data = jsonb_set(data, ARRAY[$2::text], 'true') WHERE id = $1 AND status = 'pending'"
    );
    expect(client.last().values).toEqual(['timer_a', 'fired']);

    firedRows = [{ data: stored({ fired: true }) }];
    await store.markFired('timer_a');
    expect(seen).toEqual(['timer_a']);

    await store.cancel('timer_b');
    expect(client.last().values).toEqual(['timer_b', 'cancelled']);
    expect(seen).toEqual(['timer_a']);
  });

  it('patches the JSON in one statement, dropping undefined keys and the id', async () => {
    const client = fakePostgres();
    const store = new PostgresTimerStore({ client });

    await store.update('timer_a', {
      id: 'timer_other',
      consecutiveErrors: 3,
      lastError: undefined,
      fired: true,
    });

    const { sql, values } = client.last();
    expect(sql).toContain('SET data = ((data || $2::jsonb) - $3::text[])');
    expect(sql).toContain('claimed_until = CASE WHEN CASE WHEN (((data || $2::jsonb)');
    expect(sql).toMatch(/WHERE id = \$1$/);
    expect(values).toEqual([
      'timer_a',
      JSON.stringify({ consecutiveErrors: 3, fired: true }),
      ['lastError'],
    ]);
  });

  it('deletes finished rows older than the cutoff and counts them', async () => {
    const client = fakePostgres((sql) =>
      sql.startsWith('DELETE') ? [{ id: 'a' }, { id: 'b' }] : []
    );
    const store = new PostgresTimerStore({ client });

    expect(await store.cleanup(5_000)).toBe(2);
    expect(client.last().sql).toBe(
      "DELETE FROM cogitator_workflow_timers WHERE status <> 'pending' AND created_at < $1 RETURNING id"
    );
    expect(client.last().values).toEqual([NOW - 5_000]);
  });

  it('selects by workflow, run, status and list filters with parameters', async () => {
    const client = fakePostgres((sql) =>
      sql.startsWith('SELECT') ? [{ data: JSON.stringify(stored({})) }] : []
    );
    const store = new PostgresTimerStore({ client });
    const order = 'ORDER BY fires_at, created_at';

    expect(ids(await store.getByWorkflow('wf-1'))).toEqual(['timer_a']);
    expect(client.last()).toEqual({
      sql: `SELECT data FROM cogitator_workflow_timers WHERE workflow_id = $1 ${order}`,
      values: ['wf-1'],
    });

    await store.getByRun('run-1');
    expect(client.last().sql).toContain('WHERE run_id = $1');

    await store.getPending();
    expect(client.last().sql).toContain("WHERE status = 'pending'");

    await store.list();
    expect(client.last()).toMatchObject({ sql: expect.stringContaining('WHERE TRUE'), values: [] });

    await store.list({ enabled: false, type: 'cron' });
    expect(client.last()).toEqual({
      sql: `SELECT data FROM cogitator_workflow_timers WHERE COALESCE((data->>'enabled')::boolean, true) = $1 AND data->>'type' = $2 ${order}`,
      values: [false, 'cron'],
    });
  });
});
