/**
 * Stores of routines made at run time, trigger state, history and the claims that make a firing
 * start once: in memory, a JSON file, Redis and Postgres
 */

import type {
  ActiveRoutineRun,
  RoutineDefinition,
  RoutineRunRecord,
  RoutineStore,
  TriggerState,
  TriggerStatePatch,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { SharedJsonFile } from './json-file';
import { createIfMissing, fromJson, tablePrefix, type TriggerStorePgClient } from './pg';
import { MAX_RUN_HISTORY, storableProblem } from './routines';

function checkStorable(routine: RoutineDefinition): void {
  const problem = storableProblem(routine);
  if (problem) throw new CogitatorError({ message: problem, code: ErrorCode.VALIDATION_ERROR });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** A trigger's state with `patch` applied: its fields replace, `fireCountDelta` adds */
export function patchedTriggerState(
  current: TriggerState | null | undefined,
  id: string,
  routineId: string,
  patch: TriggerStatePatch
): TriggerState {
  const { fireCountDelta, ...fields } = patch;
  const base: TriggerState = current ?? { id, routineId, fireCount: 0 };
  return {
    ...base,
    ...fields,
    id,
    routineId,
    fireCount: (base.fireCount ?? 0) + (fireCountDelta ?? 0),
  };
}

function newestFirst(a: RoutineRunRecord, b: RoutineRunRecord): number {
  return b.at - a.at;
}

/** Keeps the latest `MAX_RUN_HISTORY` records of each routine */
function trimHistory(runs: RoutineRunRecord[]): RoutineRunRecord[] {
  const counts = new Map<string, number>();
  return [...runs].sort(newestFirst).filter((run) => {
    const count = (counts.get(run.routineId) ?? 0) + 1;
    counts.set(run.routineId, count);
    return count <= MAX_RUN_HISTORY;
  });
}

function upsertRun(runs: RoutineRunRecord[], record: RoutineRunRecord): RoutineRunRecord[] {
  return trimHistory([...runs.filter((run) => run.id !== record.id), clone(record)]);
}

function selectRuns(
  runs: readonly RoutineRunRecord[],
  filter: { routineId?: string; limit?: number } | undefined
): RoutineRunRecord[] {
  return runs
    .filter((run) => filter?.routineId === undefined || run.routineId === filter.routineId)
    .sort(newestFirst)
    .slice(0, filter?.limit ?? 50)
    .map(clone);
}

/** Experimental. A routine store in memory, for one process */
export class experimental_InMemoryRoutineStore implements RoutineStore {
  private readonly routines = new Map<string, RoutineDefinition>();
  private readonly states = new Map<string, TriggerState>();
  private readonly keys = new Map<string, number>();
  private readonly active = new Map<string, ActiveRoutineRun>();
  private runs: RoutineRunRecord[] = [];

  async listRoutines(): Promise<RoutineDefinition[]> {
    return [...this.routines.values()].map(clone);
  }

  async getRoutine(id: string): Promise<RoutineDefinition | null> {
    const routine = this.routines.get(id);
    return routine ? clone(routine) : null;
  }

  async saveRoutine(routine: RoutineDefinition): Promise<void> {
    checkStorable(routine);
    this.routines.set(routine.id, clone(routine));
  }

  async deleteRoutine(id: string): Promise<void> {
    this.routines.delete(id);
  }

  async getTriggerState(id: string): Promise<TriggerState | null> {
    const state = this.states.get(id);
    return state ? clone(state) : null;
  }

  async listTriggerStates(routineId?: string): Promise<TriggerState[]> {
    return [...this.states.values()]
      .filter((state) => routineId === undefined || state.routineId === routineId)
      .map(clone);
  }

  async saveTriggerState(state: TriggerState): Promise<void> {
    this.states.set(state.id, clone(state));
  }

  async patchTriggerState(
    id: string,
    routineId: string,
    patch: TriggerStatePatch
  ): Promise<TriggerState> {
    const next = patchedTriggerState(this.states.get(id), id, routineId, patch);
    this.states.set(id, next);
    return clone(next);
  }

  async deleteTriggerState(id: string): Promise<void> {
    this.states.delete(id);
  }

  async claimKey(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const until = this.keys.get(key);
    if (until !== undefined && until > now) return false;
    this.keys.set(key, now + ttlMs);
    if (this.keys.size > 10_000) {
      for (const [stored, expires] of this.keys) if (expires <= now) this.keys.delete(stored);
    }
    return true;
  }

  async releaseKey(key: string): Promise<void> {
    this.keys.delete(key);
  }

  async recordRun(record: RoutineRunRecord): Promise<void> {
    this.runs = upsertRun(this.runs, record);
  }

  async listRuns(filter?: { routineId?: string; limit?: number }): Promise<RoutineRunRecord[]> {
    return selectRuns(this.runs, filter);
  }

  async saveActiveRun(run: ActiveRoutineRun): Promise<void> {
    this.active.set(run.runId, clone(run));
  }

  async getActiveRun(runId: string): Promise<ActiveRoutineRun | null> {
    const run = this.active.get(runId);
    return run ? clone(run) : null;
  }

  async listActiveRuns(): Promise<ActiveRoutineRun[]> {
    return [...this.active.values()].map(clone);
  }

  async deleteActiveRun(runId: string): Promise<void> {
    this.active.delete(runId);
  }
}

interface RoutineFile {
  version: 1;
  routines: Record<string, RoutineDefinition>;
  triggers: Record<string, TriggerState>;
  keys: Record<string, number>;
  runs: RoutineRunRecord[];
  active: Record<string, ActiveRoutineRun>;
}

function emptyFile(): RoutineFile {
  return { version: 1, routines: {}, triggers: {}, keys: {}, runs: [], active: {} };
}

function parseFile(value: unknown): RoutineFile {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error('A routine store file has version 1');
  }
  const file = value as Partial<RoutineFile>;
  return {
    version: 1,
    routines: file.routines ?? {},
    triggers: file.triggers ?? {},
    keys: file.keys ?? {},
    runs: file.runs ?? [],
    active: file.active ?? {},
  };
}

/**
 * Experimental. A routine store in a JSON file (mode 0600). Changes lock the file, so the CLI and
 * a runtime can share it, and claims are checked under the lock. For several runtimes, use the
 * Redis or Postgres store
 */
export class experimental_FileRoutineStore implements RoutineStore {
  private readonly file: SharedJsonFile<RoutineFile>;

  constructor(path: string) {
    this.file = new SharedJsonFile(path, { empty: emptyFile, parse: parseFile });
  }

  get path(): string {
    return this.file.path;
  }

  async listRoutines(): Promise<RoutineDefinition[]> {
    return Object.values((await this.file.read()).routines).map(clone);
  }

  async getRoutine(id: string): Promise<RoutineDefinition | null> {
    const routine = (await this.file.read()).routines[id];
    return routine ? clone(routine) : null;
  }

  async saveRoutine(routine: RoutineDefinition): Promise<void> {
    checkStorable(routine);
    await this.file.update((data) => {
      data.routines[routine.id] = clone(routine);
    });
  }

  async deleteRoutine(id: string): Promise<void> {
    await this.file.update((data) => {
      delete data.routines[id];
    });
  }

  async getTriggerState(id: string): Promise<TriggerState | null> {
    const state = (await this.file.read()).triggers[id];
    return state ? clone(state) : null;
  }

  async listTriggerStates(routineId?: string): Promise<TriggerState[]> {
    return Object.values((await this.file.read()).triggers)
      .filter((state) => routineId === undefined || state.routineId === routineId)
      .map(clone);
  }

  async saveTriggerState(state: TriggerState): Promise<void> {
    await this.file.update((data) => {
      data.triggers[state.id] = clone(state);
    });
  }

  patchTriggerState(
    id: string,
    routineId: string,
    patch: TriggerStatePatch
  ): Promise<TriggerState> {
    return this.file.update((data) => {
      const next = patchedTriggerState(data.triggers[id], id, routineId, patch);
      data.triggers[id] = next;
      return clone(next);
    });
  }

  async deleteTriggerState(id: string): Promise<void> {
    await this.file.update((data) => {
      delete data.triggers[id];
    });
  }

  claimKey(key: string, ttlMs: number): Promise<boolean> {
    return this.file.update((data) => {
      const now = Date.now();
      for (const [stored, expires] of Object.entries(data.keys)) {
        if (expires <= now) delete data.keys[stored];
      }
      if (data.keys[key] !== undefined) return false;
      data.keys[key] = now + ttlMs;
      return true;
    });
  }

  async releaseKey(key: string): Promise<void> {
    await this.file.update((data) => {
      delete data.keys[key];
    });
  }

  async recordRun(record: RoutineRunRecord): Promise<void> {
    await this.file.update((data) => {
      data.runs = upsertRun(data.runs, record);
    });
  }

  async listRuns(filter?: { routineId?: string; limit?: number }): Promise<RoutineRunRecord[]> {
    return selectRuns((await this.file.read()).runs, filter);
  }

  async saveActiveRun(run: ActiveRoutineRun): Promise<void> {
    await this.file.update((data) => {
      data.active[run.runId] = clone(run);
    });
  }

  async getActiveRun(runId: string): Promise<ActiveRoutineRun | null> {
    const run = (await this.file.read()).active[runId];
    return run ? clone(run) : null;
  }

  async listActiveRuns(): Promise<ActiveRoutineRun[]> {
    return Object.values((await this.file.read()).active).map(clone);
  }

  async deleteActiveRun(runId: string): Promise<void> {
    await this.file.update((data) => {
      delete data.active[runId];
    });
  }
}

/** The Redis commands the routine and inbox stores use: `@cogitator-ai/redis` clients and ioredis both have them */
export interface TriggerStoreRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const CLAIM_SCRIPT = `return redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX') and 1 or 0`;

/**
 * Applies a patch to a trigger's state in one step: KEYS[1] the state, KEYS[2] the index of
 * states, ARGV the id, the routine id, the fields as JSON, what to add to `fireCount`, the score
 */
export const PATCH_TRIGGER_STATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local state
if raw then state = cjson.decode(raw) else state = { id = ARGV[1], routineId = ARGV[2], fireCount = 0 } end
for key, value in pairs(cjson.decode(ARGV[3])) do state[key] = value end
state.id = ARGV[1]
state.routineId = ARGV[2]
state.fireCount = (tonumber(state.fireCount) or 0) + tonumber(ARGV[4])
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
return encoded`;

export interface RedisRoutineStoreOptions {
  client: TriggerStoreRedisClient;
  /** Prefix of every key (default `cogitator:routines`) */
  keyPrefix?: string;
}

/**
 * Experimental. A routine store in Redis: JSON under each id, sorted sets of ids, claims with
 * `SET NX PX` in one script, so runtimes that share it start each firing once
 */
export class experimental_RedisRoutineStore implements RoutineStore {
  private readonly client: TriggerStoreRedisClient;
  private readonly prefix: string;

  constructor(options: RedisRoutineStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:routines';
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  private async readMany<T>(index: string, kind: 'routine' | 'trigger' | 'active'): Promise<T[]> {
    const ids = await this.client.zrange(index, 0, -1);
    if (ids.length === 0) return [];
    const values = await this.client.mget(...ids.map((id) => this.key(kind, id)));
    return values
      .filter((value): value is string => value !== null)
      .map((value) => JSON.parse(value) as T);
  }

  listRoutines(): Promise<RoutineDefinition[]> {
    return this.readMany<RoutineDefinition>(this.key('routines'), 'routine');
  }

  async getRoutine(id: string): Promise<RoutineDefinition | null> {
    const raw = await this.client.get(this.key('routine', id));
    return raw ? (JSON.parse(raw) as RoutineDefinition) : null;
  }

  async saveRoutine(routine: RoutineDefinition): Promise<void> {
    checkStorable(routine);
    await this.client.set(this.key('routine', routine.id), JSON.stringify(routine));
    await this.client.zadd(this.key('routines'), Date.now(), routine.id);
  }

  async deleteRoutine(id: string): Promise<void> {
    await this.client.del(this.key('routine', id));
    await this.client.zrem(this.key('routines'), id);
  }

  async getTriggerState(id: string): Promise<TriggerState | null> {
    const raw = await this.client.get(this.key('trigger', id));
    return raw ? (JSON.parse(raw) as TriggerState) : null;
  }

  async listTriggerStates(routineId?: string): Promise<TriggerState[]> {
    const states = await this.readMany<TriggerState>(this.key('triggers'), 'trigger');
    return states.filter((state) => routineId === undefined || state.routineId === routineId);
  }

  async saveTriggerState(state: TriggerState): Promise<void> {
    await this.client.set(this.key('trigger', state.id), JSON.stringify(state));
    await this.client.zadd(this.key('triggers'), Date.now(), state.id);
  }

  async patchTriggerState(
    id: string,
    routineId: string,
    patch: TriggerStatePatch
  ): Promise<TriggerState> {
    const { fireCountDelta, ...fields } = patch;
    const encoded = await this.client.eval(
      PATCH_TRIGGER_STATE_SCRIPT,
      2,
      this.key('trigger', id),
      this.key('triggers'),
      id,
      routineId,
      JSON.stringify(fields),
      fireCountDelta ?? 0,
      Date.now()
    );
    return JSON.parse(String(encoded)) as TriggerState;
  }

  async deleteTriggerState(id: string): Promise<void> {
    await this.client.del(this.key('trigger', id));
    await this.client.zrem(this.key('triggers'), id);
  }

  async claimKey(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.eval(
      CLAIM_SCRIPT,
      1,
      this.key('claim', key),
      Math.max(1, Math.ceil(ttlMs))
    );
    return Number(result) === 1;
  }

  async releaseKey(key: string): Promise<void> {
    await this.client.del(this.key('claim', key));
  }

  async recordRun(record: RoutineRunRecord): Promise<void> {
    await this.client.set(this.key('run', record.id), JSON.stringify(record));
    const index = this.key('runs', record.routineId);
    await this.client.zadd(index, record.at, record.id);
    await this.client.zadd(this.key('runs'), record.at, record.id);
    const ids = await this.client.zrange(index, 0, -1);
    const dropped = ids.slice(0, Math.max(0, ids.length - MAX_RUN_HISTORY));
    if (dropped.length > 0) {
      await this.client.zrem(index, ...dropped);
      await this.client.zrem(this.key('runs'), ...dropped);
      await this.client.del(...dropped.map((id) => this.key('run', id)));
    }
  }

  async listRuns(filter?: { routineId?: string; limit?: number }): Promise<RoutineRunRecord[]> {
    const limit = filter?.limit ?? 50;
    const index =
      filter?.routineId === undefined ? this.key('runs') : this.key('runs', filter.routineId);
    const ids = (await this.client.zrange(index, -limit, -1)).reverse();
    if (ids.length === 0) return [];
    const values = await this.client.mget(...ids.map((id) => this.key('run', id)));
    return values
      .filter((value): value is string => value !== null)
      .map((value) => JSON.parse(value) as RoutineRunRecord)
      .sort(newestFirst);
  }

  async saveActiveRun(run: ActiveRoutineRun): Promise<void> {
    await this.client.set(this.key('active', run.runId), JSON.stringify(run));
    await this.client.zadd(this.key('actives'), run.at, run.runId);
  }

  async getActiveRun(runId: string): Promise<ActiveRoutineRun | null> {
    const raw = await this.client.get(this.key('active', runId));
    return raw ? (JSON.parse(raw) as ActiveRoutineRun) : null;
  }

  listActiveRuns(): Promise<ActiveRoutineRun[]> {
    return this.readMany<ActiveRoutineRun>(this.key('actives'), 'active');
  }

  async deleteActiveRun(runId: string): Promise<void> {
    await this.client.del(this.key('active', runId));
    await this.client.zrem(this.key('actives'), runId);
  }
}

const CLAIM_SWEEP_INTERVAL_MS = 60_000;
const CLAIM_SWEEP_BATCH = 500;

export interface PostgresRoutineStoreOptions {
  client: TriggerStorePgClient;
  /** Prefix of the tables (default `cogitator_routines`), created on first use */
  tablePrefix?: string;
}

/**
 * Experimental. A routine store in Postgres: routines, trigger state and history as JSONB, claims
 * as rows with an expiry taken by one insert, so runtimes that share it start each firing once
 */
export class experimental_PostgresRoutineStore implements RoutineStore {
  private readonly client: TriggerStorePgClient;
  private readonly prefix: string;
  private ready?: Promise<void>;
  private lastSweepAt = 0;

  constructor(options: PostgresRoutineStoreOptions) {
    this.client = options.client;
    this.prefix = tablePrefix(options.tablePrefix ?? 'cogitator_routines', 'routine');
  }

  private table(name: string): string {
    return `${this.prefix}_${name}`;
  }

  private ensure(): Promise<void> {
    this.ready ??= this.create().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async create(): Promise<void> {
    const index = this.prefix.replace('.', '_');
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table('defs')} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`
    );
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table('triggers')} (
         id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, data JSONB NOT NULL)`
    );
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table('claims')} (
         key TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)`
    );
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table('runs')} (
         id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, at DOUBLE PRECISION NOT NULL, data JSONB NOT NULL)`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${index}_runs_idx ON ${this.table('runs')} (routine_id, at)`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${index}_claims_expiry_idx ON ${this.table('claims')} (expires_at)`
    );
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table('active')} (
         run_id TEXT PRIMARY KEY, data JSONB NOT NULL)`
    );
  }

  async listRoutines(): Promise<RoutineDefinition[]> {
    await this.ensure();
    const { rows } = await this.client.query(`SELECT data FROM ${this.table('defs')} ORDER BY id`);
    return rows.map((row) => fromJson<RoutineDefinition>(row.data));
  }

  async getRoutine(id: string): Promise<RoutineDefinition | null> {
    await this.ensure();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table('defs')} WHERE id = $1`,
      [id]
    );
    return rows[0] ? fromJson<RoutineDefinition>(rows[0].data) : null;
  }

  async saveRoutine(routine: RoutineDefinition): Promise<void> {
    checkStorable(routine);
    await this.ensure();
    await this.client.query(
      `INSERT INTO ${this.table('defs')} (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [routine.id, JSON.stringify(routine)]
    );
  }

  async deleteRoutine(id: string): Promise<void> {
    await this.ensure();
    await this.client.query(`DELETE FROM ${this.table('defs')} WHERE id = $1`, [id]);
  }

  async getTriggerState(id: string): Promise<TriggerState | null> {
    await this.ensure();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table('triggers')} WHERE id = $1`,
      [id]
    );
    return rows[0] ? fromJson<TriggerState>(rows[0].data) : null;
  }

  async listTriggerStates(routineId?: string): Promise<TriggerState[]> {
    await this.ensure();
    const { rows } =
      routineId === undefined
        ? await this.client.query(`SELECT data FROM ${this.table('triggers')} ORDER BY id`)
        : await this.client.query(
            `SELECT data FROM ${this.table('triggers')} WHERE routine_id = $1 ORDER BY id`,
            [routineId]
          );
    return rows.map((row) => fromJson<TriggerState>(row.data));
  }

  async saveTriggerState(state: TriggerState): Promise<void> {
    await this.ensure();
    await this.client.query(
      `INSERT INTO ${this.table('triggers')} (id, routine_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET routine_id = EXCLUDED.routine_id, data = EXCLUDED.data`,
      [state.id, state.routineId, JSON.stringify(state)]
    );
  }

  async patchTriggerState(
    id: string,
    routineId: string,
    patch: TriggerStatePatch
  ): Promise<TriggerState> {
    await this.ensure();
    const { fireCountDelta, ...fields } = patch;
    const table = this.table('triggers');
    const delta = fireCountDelta ?? 0;
    const { rows } = await this.client.query(
      `INSERT INTO ${table} (id, routine_id, data)
       VALUES ($1, $2, jsonb_build_object('id', $1::text, 'routineId', $2::text, 'fireCount', 0)
         || $3::jsonb || jsonb_build_object('fireCount', $4::bigint))
       ON CONFLICT (id) DO UPDATE SET data = ${table}.data || $3::jsonb
         || jsonb_build_object('id', $1::text, 'routineId', $2::text,
              'fireCount', COALESCE((${table}.data->>'fireCount')::bigint, 0) + $4::bigint)
       RETURNING data`,
      [id, routineId, JSON.stringify(fields), delta]
    );
    return fromJson<TriggerState>(rows[0]?.data);
  }

  async deleteTriggerState(id: string): Promise<void> {
    await this.ensure();
    await this.client.query(`DELETE FROM ${this.table('triggers')} WHERE id = $1`, [id]);
  }

  /**
   * Removes a bounded batch of expired claims, at most once a minute: every firing leaves a
   * `run:` claim and every delivery a `dedup:` one, keys that are never claimed again
   */
  private async sweepClaims(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < CLAIM_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    const table = this.table('claims');
    await this.client.query(
      `DELETE FROM ${table} WHERE key IN (
         SELECT key FROM ${table} WHERE expires_at <= now() LIMIT ${CLAIM_SWEEP_BATCH})`
    );
  }

  async claimKey(key: string, ttlMs: number): Promise<boolean> {
    await this.ensure();
    try {
      await this.sweepClaims();
    } catch {
      this.lastSweepAt = 0;
    }
    const table = this.table('claims');
    const { rows } = await this.client.query(
      `INSERT INTO ${table} (key, expires_at)
       VALUES ($1, now() + $2::double precision * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE ${table}.expires_at <= now()
       RETURNING key`,
      [key, Math.max(1, Math.ceil(ttlMs))]
    );
    return rows.length === 1;
  }

  async releaseKey(key: string): Promise<void> {
    await this.ensure();
    await this.client.query(`DELETE FROM ${this.table('claims')} WHERE key = $1`, [key]);
  }

  async recordRun(record: RoutineRunRecord): Promise<void> {
    await this.ensure();
    const table = this.table('runs');
    await this.client.query(
      `INSERT INTO ${table} (id, routine_id, at, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET routine_id = EXCLUDED.routine_id, at = EXCLUDED.at, data = EXCLUDED.data`,
      [record.id, record.routineId, record.at, JSON.stringify(record)]
    );
    await this.client.query(
      `DELETE FROM ${table} WHERE routine_id = $1 AND id NOT IN (
         SELECT id FROM ${table} WHERE routine_id = $1 ORDER BY at DESC LIMIT $2)`,
      [record.routineId, MAX_RUN_HISTORY]
    );
  }

  async listRuns(filter?: { routineId?: string; limit?: number }): Promise<RoutineRunRecord[]> {
    await this.ensure();
    const limit = filter?.limit ?? 50;
    const { rows } =
      filter?.routineId === undefined
        ? await this.client.query(
            `SELECT data FROM ${this.table('runs')} ORDER BY at DESC LIMIT $1`,
            [limit]
          )
        : await this.client.query(
            `SELECT data FROM ${this.table('runs')} WHERE routine_id = $1 ORDER BY at DESC LIMIT $2`,
            [filter.routineId, limit]
          );
    return rows.map((row) => fromJson<RoutineRunRecord>(row.data));
  }

  async saveActiveRun(run: ActiveRoutineRun): Promise<void> {
    await this.ensure();
    await this.client.query(
      `INSERT INTO ${this.table('active')} (run_id, data) VALUES ($1, $2)
       ON CONFLICT (run_id) DO UPDATE SET data = EXCLUDED.data`,
      [run.runId, JSON.stringify(run)]
    );
  }

  async getActiveRun(runId: string): Promise<ActiveRoutineRun | null> {
    await this.ensure();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table('active')} WHERE run_id = $1`,
      [runId]
    );
    return rows[0] ? fromJson<ActiveRoutineRun>(rows[0].data) : null;
  }

  async listActiveRuns(): Promise<ActiveRoutineRun[]> {
    await this.ensure();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table('active')} ORDER BY run_id`
    );
    return rows.map((row) => fromJson<ActiveRoutineRun>(row.data));
  }

  async deleteActiveRun(runId: string): Promise<void> {
    await this.ensure();
    await this.client.query(`DELETE FROM ${this.table('active')} WHERE run_id = $1`, [runId]);
  }
}
