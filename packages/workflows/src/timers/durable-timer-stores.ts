/**
 * Durable workflow timer stores: Redis and Postgres.
 *
 * Several workers may run a `TimerManager` against one durable store, so
 * `getOverdue()` claims what it returns: each overdue timer is leased to the
 * store instance that returned it for `claimTtl` ms and skipped by every
 * other `getOverdue()` until `markFired`/`cancel` ends the claim, the owner
 * gives it up with `release`, or the lease runs out (a crashed worker's
 * timers come back after that). The owner keeps a long-running timer with
 * `renew`; a timer whose handler failed stays claimed, so it is retried once
 * its lease expires.
 */

import type { TimerEntry, TimerStore } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { createIfMissing, fromJson, TABLE_NAME } from '../postgres-schema';

type FireCallback = (entry: TimerEntry) => void;
type NewTimer = Omit<TimerEntry, 'id' | 'cancelled' | 'fired' | 'createdAt'>;

const DEFAULT_CLAIM_TTL = 60_000;

function createTimer(entry: NewTimer): TimerEntry {
  return {
    ...entry,
    id: `timer_${nanoid(12)}`,
    cancelled: false,
    fired: false,
    createdAt: Date.now(),
  };
}

function isPending(timer: TimerEntry): boolean {
  return !timer.cancelled && !timer.fired;
}

function byFiresAt(a: TimerEntry, b: TimerEntry): number {
  return a.firesAt - b.firesAt;
}

function matchesFilter(timer: TimerEntry, filter?: { enabled?: boolean; type?: string }): boolean {
  if (filter?.enabled !== undefined && (timer.enabled ?? true) !== filter.enabled) return false;
  return !filter?.type || timer.type === filter.type;
}

function claimTtlOf(claimTtl: number | undefined): number {
  const ttl = claimTtl ?? DEFAULT_CLAIM_TTL;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`Invalid timer claimTtl: ${ttl}`);
  }
  return ttl;
}

class FireListeners {
  private readonly callbacks: FireCallback[] = [];

  add(callback: FireCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx !== -1) this.callbacks.splice(idx, 1);
    };
  }

  emit(entry: TimerEntry): void {
    for (const callback of this.callbacks) {
      try {
        callback(entry);
      } catch {}
    }
  }
}

/**
 * The Redis commands the store uses; `@cogitator-ai/redis` clients and
 * ioredis both provide them. Every command touches a single key, so it also
 * works on Redis Cluster.
 */
export interface TimerStoreRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  /** Resolves to the number of members added (0 when the member existed). */
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

export interface RedisTimerStoreOptions {
  client: TimerStoreRedisClient;
  /** Prefix of every key (default `cogitator:workflow-timers`) */
  keyPrefix?: string;
  /** How long a timer handed out by `getOverdue()` stays claimed, in ms (default 60 000) */
  claimTtl?: number;
}

/**
 * Timers in Redis: each as JSON under its id, indexed by sorted sets scored
 * by `firesAt` (all timers, pending timers, per workflow, per run) and a
 * sorted set of finished timers scored by `createdAt` for `cleanup`.
 *
 * A claim is a per-timer sorted set of lease generations scored by their
 * expiry. Claiming adds the next generation; only the caller whose `ZADD`
 * creates it owns the lease, and it backs off if another generation is still
 * live afterwards, so concurrent workers never share one. Each store
 * instance remembers the generations it holds, which is what `renew` and
 * `release` act on. Leases are measured on the workers' clocks, so keep
 * them in sync.
 *
 * `cancel`, `markFired` and `update` read, change and write a timer, so
 * concurrent writes to one timer are last-writer-wins. `onFire` callbacks run
 * in the process that calls `markFired`.
 */
export class RedisTimerStore implements TimerStore {
  readonly claimTtl: number;
  private readonly client: TimerStoreRedisClient;
  private readonly prefix: string;
  private readonly listeners = new FireListeners();
  private readonly held = new Map<string, string>();

  constructor(options: RedisTimerStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:workflow-timers';
    this.claimTtl = claimTtlOf(options.claimTtl);
  }

  async schedule(entry: NewTimer): Promise<string> {
    const timer = createTimer(entry);
    await this.write(timer, null);
    return timer.id;
  }

  async get(id: string): Promise<TimerEntry | null> {
    const raw = await this.client.get(this.timerKey(id));
    return raw ? (JSON.parse(raw) as TimerEntry) : null;
  }

  async cancel(id: string): Promise<void> {
    const timer = await this.get(id);
    if (!timer || !isPending(timer)) return;
    await this.write({ ...timer, cancelled: true }, timer);
  }

  /** Extends this instance's live claim on a timer; `false` when it no longer holds one. */
  async renew(id: string): Promise<boolean> {
    const generation = this.held.get(id);
    if (generation === undefined) return false;
    const key = this.claimKey(id);
    const now = Date.now();
    const live = await this.client.zrangebyscore(key, `(${now}`, '+inf');
    if (!live.includes(generation)) {
      this.held.delete(id);
      return false;
    }
    await this.client.zadd(key, now + this.claimTtl, generation);
    const contenders = await this.client.zrangebyscore(key, `(${now}`, '+inf');
    if (contenders.some((other) => other !== generation)) {
      await this.client.zadd(key, 0, generation);
      this.held.delete(id);
      return false;
    }
    return true;
  }

  /** Expires this instance's claim on a timer so any worker can take it now. */
  async release(id: string): Promise<void> {
    const generation = this.held.get(id);
    if (generation === undefined) return;
    this.held.delete(id);
    const key = this.claimKey(id);
    const live = await this.client.zrangebyscore(key, `(${Date.now()}`, '+inf');
    if (live.includes(generation)) await this.client.zadd(key, 0, generation);
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    const timers = await this.loadIndex(this.workflowKey(workflowId));
    return timers.filter((timer) => timer.workflowId === workflowId);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    const timers = await this.loadIndex(this.runKey(runId));
    return timers.filter((timer) => timer.runId === runId);
  }

  async getPending(): Promise<TimerEntry[]> {
    const timers = await this.loadIndex(this.pendingKey());
    return timers.filter(isPending);
  }

  /**
   * Overdue pending timers, oldest first, each claimed for `claimTtl` ms:
   * timers claimed by another caller are left out until their lease expires.
   */
  async getOverdue(): Promise<TimerEntry[]> {
    const now = Date.now();
    const ids = await this.client.zrangebyscore(this.pendingKey(), '-inf', now);
    const claimed = await Promise.all(ids.map((id) => this.claimIfDue(id, now)));
    return claimed.filter((timer): timer is TimerEntry => timer !== null).sort(byFiresAt);
  }

  async markFired(id: string): Promise<void> {
    const timer = await this.get(id);
    if (!timer || !isPending(timer)) return;
    const fired = { ...timer, fired: true };
    await this.write(fired, timer);
    this.listeners.emit(fired);
  }

  async cleanup(olderThan: number): Promise<number> {
    const cutoff = Date.now() - olderThan;
    const ids = await this.client.zrangebyscore(this.doneKey(), '-inf', `(${cutoff}`);
    let count = 0;
    for (const id of ids) {
      const timer = await this.get(id);
      if (!timer) {
        await this.client.zrem(this.doneKey(), id);
        await this.client.zrem(this.allKey(), id);
        continue;
      }
      if (isPending(timer)) {
        await this.client.zrem(this.doneKey(), id);
        continue;
      }
      if (timer.createdAt >= cutoff) continue;
      await this.client.del(this.timerKey(id));
      await this.unindex(timer);
      count++;
    }
    return count;
  }

  onFire(callback: FireCallback): () => void {
    return this.listeners.add(callback);
  }

  /** Patches a timer; it keeps its id, and a patch that finishes it ends its claim. */
  async update(id: string, patch: Partial<TimerEntry>): Promise<void> {
    const timer = await this.get(id);
    if (!timer) return;
    await this.write({ ...timer, ...patch, id }, timer);
  }

  async list(filter?: { enabled?: boolean; type?: string }): Promise<TimerEntry[]> {
    const timers = await this.loadIndex(this.allKey());
    return timers.filter((timer) => matchesFilter(timer, filter));
  }

  private async claimIfDue(id: string, now: number): Promise<TimerEntry | null> {
    const generation = await this.claim(id, now);
    if (generation === null) return null;
    const timer = await this.get(id);
    if (timer && isPending(timer)) {
      if (timer.firesAt <= now) {
        this.held.set(id, generation);
        return timer;
      }
      await this.client.zadd(this.claimKey(id), 0, generation);
      return null;
    }
    await this.client.zrem(this.pendingKey(), id);
    await this.client.del(this.claimKey(id));
    return null;
  }

  /**
   * Takes the lease on a timer unless a live one exists, returning the lease
   * generation it now owns. Generations only grow while the claim key lives,
   * and releasing a lease expires its generation in place, so two callers can
   * only contend for the same generation and `ZADD` picks one of them; a
   * winner that finds an older generation renewed meanwhile backs off.
   */
  private async claim(id: string, now: number): Promise<string | null> {
    const key = this.claimKey(id);
    const generations = await this.client.zrange(key, 0, -1);
    const live = await this.client.zrangebyscore(key, `(${now}`, '+inf');
    if (live.length > 0) return null;
    const latest = generations.reduce((max, generation) => Math.max(max, Number(generation)), -1);
    const next = String(latest + 1);
    const added = await this.client.zadd(key, now + this.claimTtl, next);
    if (added !== 1) return null;
    const contenders = await this.client.zrangebyscore(key, `(${now}`, '+inf');
    if (contenders.some((other) => other !== next)) {
      await this.client.zadd(key, 0, next);
      return null;
    }
    return next;
  }

  private async write(timer: TimerEntry, previous: TimerEntry | null): Promise<void> {
    await this.client.set(this.timerKey(timer.id), JSON.stringify(timer));
    if (previous && previous.workflowId !== timer.workflowId) {
      await this.client.zrem(this.workflowKey(previous.workflowId), timer.id);
    }
    if (previous && previous.runId !== timer.runId) {
      await this.client.zrem(this.runKey(previous.runId), timer.id);
    }
    await this.client.zadd(this.allKey(), timer.firesAt, timer.id);
    await this.client.zadd(this.workflowKey(timer.workflowId), timer.firesAt, timer.id);
    await this.client.zadd(this.runKey(timer.runId), timer.firesAt, timer.id);
    if (isPending(timer)) {
      await this.client.zadd(this.pendingKey(), timer.firesAt, timer.id);
      await this.client.zrem(this.doneKey(), timer.id);
    } else {
      await this.client.zadd(this.doneKey(), timer.createdAt, timer.id);
      await this.client.zrem(this.pendingKey(), timer.id);
      await this.client.del(this.claimKey(timer.id));
      this.held.delete(timer.id);
    }
  }

  private async unindex(timer: TimerEntry): Promise<void> {
    await this.client.zrem(this.allKey(), timer.id);
    await this.client.zrem(this.pendingKey(), timer.id);
    await this.client.zrem(this.doneKey(), timer.id);
    await this.client.zrem(this.workflowKey(timer.workflowId), timer.id);
    await this.client.zrem(this.runKey(timer.runId), timer.id);
    await this.client.del(this.claimKey(timer.id));
  }

  private async loadIndex(key: string): Promise<TimerEntry[]> {
    const ids = await this.client.zrange(key, 0, -1);
    const loaded = await Promise.all(ids.map((id) => this.get(id)));
    const missing = ids.filter((_, i) => loaded[i] === null);
    if (missing.length > 0) await this.client.zrem(key, ...missing);
    return loaded.filter((timer): timer is TimerEntry => timer !== null).sort(byFiresAt);
  }

  private timerKey(id: string): string {
    return `${this.prefix}:timer:${id}`;
  }

  private claimKey(id: string): string {
    return `${this.prefix}:claim:${id}`;
  }

  private allKey(): string {
    return `${this.prefix}:all`;
  }

  private pendingKey(): string {
    return `${this.prefix}:pending`;
  }

  private doneKey(): string {
    return `${this.prefix}:done`;
  }

  private workflowKey(workflowId: string): string {
    return `${this.prefix}:workflow:${workflowId}`;
  }

  private runKey(runId: string): string {
    return `${this.prefix}:run:${runId}`;
  }
}

/** The query method of a `pg` Pool or Client. */
export interface TimerStorePgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresTimerStoreOptions {
  client: TimerStorePgClient;
  /** Table name (default `cogitator_workflow_timers`); created on first use */
  table?: string;
  /** How long a timer handed out by `getOverdue()` stays claimed, in ms (default 60 000) */
  claimTtl?: number;
}

const statusOf = (data: string) =>
  `CASE WHEN (${data}->>'fired')::boolean THEN 'fired'
        WHEN (${data}->>'cancelled')::boolean THEN 'cancelled'
        ELSE 'pending' END`;

/**
 * Timers in a Postgres table, as JSONB rows with indexed `status`,
 * `fires_at`, `workflow_id` and `run_id` columns.
 *
 * `getOverdue()` claims rows with `UPDATE … SET claimed_until, claimed_by`
 * over a `SELECT … FOR UPDATE SKIP LOCKED`, so concurrent workers split the
 * overdue timers between them; `claimed_by` is a random id per store
 * instance, which `renew` and `release` check. Leases are measured on the
 * database clock. `cancel`,
 * `markFired` and `update` are single statements, so concurrent writers never
 * lose each other's changes and `onFire` callbacks run once, in the process
 * whose `markFired` fired the timer.
 */
export class PostgresTimerStore implements TimerStore {
  readonly claimTtl: number;
  private readonly client: TimerStorePgClient;
  private readonly table: string;
  private readonly owner = nanoid();
  private readonly listeners = new FireListeners();
  private ready?: Promise<void>;

  constructor(options: PostgresTimerStoreOptions) {
    const table = options.table ?? 'cogitator_workflow_timers';
    if (!TABLE_NAME.test(table)) {
      throw new Error(`Invalid timer table name: ${table}`);
    }
    this.client = options.client;
    this.table = table;
    this.claimTtl = claimTtlOf(options.claimTtl);
  }

  async schedule(entry: NewTimer): Promise<string> {
    await this.ensureTable();
    const timer = createTimer(entry);
    await this.client.query(
      `INSERT INTO ${this.table} (id, workflow_id, run_id, status, fires_at, created_at, data)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
      [
        timer.id,
        timer.workflowId,
        timer.runId,
        timer.firesAt,
        timer.createdAt,
        JSON.stringify(timer),
      ]
    );
    return timer.id;
  }

  async get(id: string): Promise<TimerEntry | null> {
    await this.ensureTable();
    const { rows } = await this.client.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? toTimer(rows[0].data) : null;
  }

  async cancel(id: string): Promise<void> {
    await this.finish(id, 'cancelled');
  }

  /** Extends this instance's live claim on a timer; `false` when it no longer holds one. */
  async renew(id: string): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $3::double precision * interval '1 millisecond'
        WHERE id = $1 AND claimed_by = $2 AND status = 'pending' AND claimed_until > now()
        RETURNING id`,
      [id, this.owner, this.claimTtl]
    );
    return rows.length > 0;
  }

  /** Clears this instance's claim on a timer so any worker can take it now. */
  async release(id: string): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `UPDATE ${this.table} SET claimed_until = NULL, claimed_by = NULL
        WHERE id = $1 AND claimed_by = $2 AND status = 'pending'`,
      [id, this.owner]
    );
  }

  async getByWorkflow(workflowId: string): Promise<TimerEntry[]> {
    return this.select('workflow_id = $1', [workflowId]);
  }

  async getByRun(runId: string): Promise<TimerEntry[]> {
    return this.select('run_id = $1', [runId]);
  }

  async getPending(): Promise<TimerEntry[]> {
    return this.select(`status = 'pending'`, []);
  }

  /**
   * Overdue pending timers, oldest first, each claimed for `claimTtl` ms:
   * timers claimed by another caller are left out until their lease expires.
   */
  async getOverdue(): Promise<TimerEntry[]> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $2::double precision * interval '1 millisecond',
              claimed_by = $3
        WHERE id IN (
          SELECT id FROM ${this.table}
           WHERE status = 'pending' AND fires_at <= $1::double precision
             AND (claimed_until IS NULL OR claimed_until <= now())
           ORDER BY fires_at
           FOR UPDATE SKIP LOCKED
        )
        RETURNING data`,
      [Date.now(), this.claimTtl, this.owner]
    );
    return rows.map((row) => toTimer(row.data)).sort(byFiresAt);
  }

  async markFired(id: string): Promise<void> {
    const fired = await this.finish(id, 'fired');
    if (fired) this.listeners.emit(fired);
  }

  async cleanup(olderThan: number): Promise<number> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `DELETE FROM ${this.table} WHERE status <> 'pending' AND created_at < $1 RETURNING id`,
      [Date.now() - olderThan]
    );
    return rows.length;
  }

  onFire(callback: FireCallback): () => void {
    return this.listeners.add(callback);
  }

  /**
   * Patches a timer in one statement (top-level keys, like `Object.assign`;
   * `undefined` removes a key); it keeps its id, and a patch that finishes it
   * ends its claim.
   */
  async update(id: string, patch: Partial<TimerEntry>): Promise<void> {
    await this.ensureTable();
    const set: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id') continue;
      if (value === undefined) removed.push(key);
      else set[key] = value;
    }
    const next = `((data || $2::jsonb) - $3::text[])`;
    await this.client.query(
      `UPDATE ${this.table}
          SET data = ${next},
              workflow_id = COALESCE(${next}->>'workflowId', workflow_id),
              run_id = COALESCE(${next}->>'runId', run_id),
              fires_at = COALESCE((${next}->>'firesAt')::double precision, fires_at),
              created_at = COALESCE((${next}->>'createdAt')::double precision, created_at),
              status = ${statusOf(next)},
              claimed_until = CASE WHEN ${statusOf(next)} = 'pending' THEN claimed_until END,
              claimed_by = CASE WHEN ${statusOf(next)} = 'pending' THEN claimed_by END
        WHERE id = $1`,
      [id, JSON.stringify(set), removed]
    );
  }

  async list(filter?: { enabled?: boolean; type?: string }): Promise<TimerEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter?.enabled !== undefined) {
      values.push(filter.enabled);
      conditions.push(`COALESCE((data->>'enabled')::boolean, true) = $${values.length}`);
    }
    if (filter?.type) {
      values.push(filter.type);
      conditions.push(`data->>'type' = $${values.length}`);
    }
    return this.select(conditions.join(' AND ') || 'TRUE', values);
  }

  private async finish(id: string, status: 'fired' | 'cancelled'): Promise<TimerEntry | null> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET status = $2::text, claimed_until = NULL, claimed_by = NULL,
              data = jsonb_set(data, ARRAY[$2::text], 'true')
        WHERE id = $1 AND status = 'pending'
        RETURNING data`,
      [id, status]
    );
    return rows[0] ? toTimer(rows[0].data) : null;
  }

  private async select(where: string, values: unknown[]): Promise<TimerEntry[]> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table} WHERE ${where} ORDER BY fires_at, created_at`,
      values
    );
    return rows.map((row) => toTimer(row.data));
  }

  private ensureTable(): Promise<void> {
    this.ready ??= this.createTable().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async createTable(): Promise<void> {
    const base = this.table.replace('.', '_');
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id TEXT PRIMARY KEY,
         workflow_id TEXT NOT NULL,
         run_id TEXT NOT NULL,
         status TEXT NOT NULL,
         fires_at DOUBLE PRECISION NOT NULL,
         created_at DOUBLE PRECISION NOT NULL,
         claimed_until TIMESTAMPTZ,
         claimed_by TEXT,
         data JSONB NOT NULL
       )`
    );
    await createIfMissing(
      this.client,
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS claimed_by TEXT`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${base}_due_idx ON ${this.table} (status, fires_at)`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${base}_workflow_idx ON ${this.table} (workflow_id, fires_at)`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${base}_run_idx ON ${this.table} (run_id, fires_at)`
    );
  }
}

function toTimer(data: unknown): TimerEntry {
  return fromJson<TimerEntry>(data);
}
