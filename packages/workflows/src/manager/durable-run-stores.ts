/**
 * Durable workflow run stores: Redis and Postgres.
 */

import type {
  RunStore,
  WorkflowRun,
  WorkflowRunFilters,
  WorkflowRunStats,
  WorkflowRunStatus,
} from '@cogitator-ai/types';
import { createIfMissing, fromJson, TABLE_NAME } from '../postgres-schema';

type RunOrderField = NonNullable<WorkflowRunFilters['orderBy']>;

const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'scheduled',
  'running',
  'paused',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'timeout',
];

const TERMINAL_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
];

interface StatusAggregate {
  status: string;
  runs: number;
  durationTotal: number;
  durationCount: number;
}

interface Page {
  offset: number;
  limit?: number;
}

/**
 * The Redis commands the store uses; `@cogitator-ai/redis` clients and
 * ioredis both provide them.
 */
export interface RunStoreRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

export interface RedisRunStoreOptions {
  client: RunStoreRedisClient;
  /** Prefix of every key (default `cogitator:workflow-runs`) */
  keyPrefix?: string;
}

/**
 * Workflow runs in Redis: each as JSON under its id, with sorted sets indexing
 * them by workflow, status, tag, trigger and parent run, and by start and
 * completion time, so listing never scans the keyspace. Runs read through an
 * index are checked against the filters again, so a stale entry left by a
 * concurrent write never leaks into results. Ties in the sort order are broken
 * by run id.
 */
export class RedisRunStore implements RunStore {
  private readonly client: RunStoreRedisClient;
  private readonly prefix: string;

  constructor(options: RedisRunStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:workflow-runs';
  }

  async save(run: WorkflowRun): Promise<void> {
    await this.write(run, await this.get(run.id));
  }

  async get(id: string): Promise<WorkflowRun | null> {
    const raw = await this.client.get(this.runKey(id));
    return raw ? (JSON.parse(raw) as WorkflowRun) : null;
  }

  async list(filters: WorkflowRunFilters = {}): Promise<WorkflowRun[]> {
    const runs = await this.find(filters);
    return paginate(runs.sort(runComparator(filters)), pageOf(filters));
  }

  async count(filters: WorkflowRunFilters = {}): Promise<number> {
    return (await this.find(filters)).length;
  }

  async update(id: string, updates: Partial<WorkflowRun>): Promise<void> {
    const run = await this.get(id);
    if (run) await this.write({ ...run, ...updates, id }, run);
  }

  async delete(id: string): Promise<void> {
    const run = await this.get(id);
    await this.client.del(this.runKey(id));
    const keys = run ? this.indexEntries(run).map(([key]) => key) : [this.allKey()];
    await Promise.all(keys.map((key) => this.client.zrem(key, id)));
  }

  async getStats(workflowName?: string): Promise<WorkflowRunStats> {
    const key = workflowName ? this.indexKey('workflow', workflowName) : this.allKey();
    const runs = await this.load(await this.client.zrange(key, 0, -1), [key]);
    return summarizeStats(
      aggregateByStatus(runs.filter((run) => !workflowName || run.workflowName === workflowName))
    );
  }

  async cleanup(olderThan: number): Promise<number> {
    const threshold = Date.now() - olderThan;
    const keys = TERMINAL_STATUSES.map((status) => this.indexKey('status', status));
    const ids = await this.union(keys);
    const expired = (await this.load(ids, keys)).filter(
      (run) => isTerminal(run.status) && cleanupTimestamp(run) < threshold
    );
    for (const run of expired) {
      await this.client.del(this.runKey(run.id));
      await Promise.all(this.indexEntries(run).map(([key]) => this.client.zrem(key, run.id)));
    }
    return expired.length;
  }

  private async write(run: WorkflowRun, previous: WorkflowRun | null): Promise<void> {
    await this.client.set(this.runKey(run.id), JSON.stringify(run));
    const entries = this.indexEntries(run);
    await Promise.all(entries.map(([key, score]) => this.client.zadd(key, score, run.id)));
    if (!previous) return;
    const current = new Set(entries.map(([key]) => key));
    const stale = this.indexEntries(previous)
      .map(([key]) => key)
      .filter((key) => !current.has(key));
    await Promise.all(stale.map((key) => this.client.zrem(key, run.id)));
  }

  private async find(filters: WorkflowRunFilters): Promise<WorkflowRun[]> {
    const { ids, keys } = await this.candidates(filters);
    const runs = await this.load(ids, keys);
    return runs.filter((run) => matchesFilters(run, filters));
  }

  private async candidates(
    filters: WorkflowRunFilters
  ): Promise<{ ids: string[]; keys: string[] }> {
    const keys: string[] = [];
    const lookups: Array<Promise<string[]>> = [];
    const unionOf = (indexKeys: string[]) => {
      keys.push(...indexKeys);
      lookups.push(this.union(indexKeys));
    };

    const statuses = statusList(filters.status);
    if (statuses) unionOf(statuses.map((status) => this.indexKey('status', status)));
    if (filters.workflowName) unionOf([this.indexKey('workflow', filters.workflowName)]);
    if (filters.tags && filters.tags.length > 0) {
      unionOf(filters.tags.map((tag) => this.indexKey('tag', tag)));
    }
    if (filters.triggerId) unionOf([this.indexKey('trigger', filters.triggerId)]);
    if (filters.parentRunId) unionOf([this.indexKey('parent', filters.parentRunId)]);
    if (filters.startedAfter || filters.startedBefore) {
      keys.push(this.timeKey('started'));
      lookups.push(
        this.client.zrangebyscore(
          this.timeKey('started'),
          filters.startedAfter || '-inf',
          filters.startedBefore || '+inf'
        )
      );
    }
    if (filters.completedAfter || filters.completedBefore) {
      keys.push(this.timeKey('completed'));
      lookups.push(
        this.client.zrangebyscore(
          this.timeKey('completed'),
          filters.completedAfter || '-inf',
          filters.completedBefore || '+inf'
        )
      );
    }

    if (lookups.length === 0) {
      return { ids: await this.client.zrange(this.allKey(), 0, -1), keys: [this.allKey()] };
    }

    const [smallest, ...others] = (await Promise.all(lookups)).sort((a, b) => a.length - b.length);
    const ids = others.reduce((acc, other) => {
      const members = new Set(other);
      return acc.filter((id) => members.has(id));
    }, smallest);
    return { ids, keys };
  }

  private async union(keys: string[]): Promise<string[]> {
    const members = await Promise.all(keys.map((key) => this.client.zrange(key, 0, -1)));
    return [...new Set(members.flat())];
  }

  private async load(ids: string[], indexKeys: string[]): Promise<WorkflowRun[]> {
    const raws = await Promise.all(ids.map((id) => this.client.get(this.runKey(id))));
    const runs: WorkflowRun[] = [];
    const missing: string[] = [];
    raws.forEach((raw, i) => {
      if (raw) runs.push(JSON.parse(raw) as WorkflowRun);
      else missing.push(ids[i]);
    });
    if (missing.length > 0) {
      const keys = new Set([this.allKey(), ...indexKeys]);
      await Promise.all([...keys].map((key) => this.client.zrem(key, ...missing)));
    }
    return runs;
  }

  private indexEntries(run: WorkflowRun): Array<[string, number]> {
    const entries: Array<[string, number]> = [
      [this.allKey(), 0],
      [this.indexKey('workflow', run.workflowName), 0],
      [this.indexKey('status', run.status), 0],
    ];
    for (const tag of new Set(run.tags)) entries.push([this.indexKey('tag', tag), 0]);
    if (run.triggerId) entries.push([this.indexKey('trigger', run.triggerId), 0]);
    if (run.parentRunId) entries.push([this.indexKey('parent', run.parentRunId), 0]);
    if (run.startedAt) entries.push([this.timeKey('started'), run.startedAt]);
    if (run.completedAt) entries.push([this.timeKey('completed'), run.completedAt]);
    return entries;
  }

  private runKey(id: string): string {
    return `${this.prefix}:run:${id}`;
  }

  private allKey(): string {
    return `${this.prefix}:index:all`;
  }

  private indexKey(
    field: 'workflow' | 'status' | 'tag' | 'trigger' | 'parent',
    value: string
  ): string {
    return `${this.prefix}:index:${field}:${value}`;
  }

  private timeKey(field: 'started' | 'completed'): string {
    return `${this.prefix}:index:${field}-at`;
  }
}

/** The query method of a `pg` Pool or Client. */
export interface RunStorePgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresRunStoreOptions {
  client: RunStorePgClient;
  /** Table name (default `cogitator_workflow_runs`); created on first use */
  table?: string;
}

const STORED_COLUMNS =
  'workflow_name, status, started_at, completed_at, priority, tags, trigger_id, parent_run_id, has_error, data';

const ORDER_EXPRESSIONS: Record<RunOrderField, string> = {
  startedAt: 'COALESCE(started_at, 0)',
  completedAt: 'COALESCE(completed_at, 0)',
  priority: 'COALESCE(priority, 0)',
};

/** The stored columns, derived in SQL from the run document `doc`. */
function derivedColumns(doc: string): string {
  return [
    `${doc}->>'workflowName'`,
    `${doc}->>'status'`,
    `(${doc}->>'startedAt')::double precision`,
    `(${doc}->>'completedAt')::double precision`,
    `(${doc}->>'priority')::double precision`,
    `ARRAY(SELECT jsonb_array_elements_text(${doc}->'tags'))`,
    `${doc}->>'triggerId'`,
    `${doc}->>'parentRunId'`,
    `COALESCE(${doc}->'error' NOT IN ('null', 'false', '0', '""'), false)`,
    doc,
  ].join(', ');
}

/**
 * Workflow runs in a Postgres table: the run as JSONB next to indexed columns
 * for every filterable field, kept in step with the document by SQL. Filters,
 * sorting, pagination, counts and statistics run in the database, and updates
 * merge into the stored document in a single statement. Ties in the sort order
 * are broken by run id.
 */
export class PostgresRunStore implements RunStore {
  private readonly client: RunStorePgClient;
  private readonly table: string;
  private ready?: Promise<void>;

  constructor(options: PostgresRunStoreOptions) {
    const table = options.table ?? 'cogitator_workflow_runs';
    if (!TABLE_NAME.test(table)) {
      throw new Error(`Invalid run table name: ${table}`);
    }
    this.client = options.client;
    this.table = table;
  }

  async save(run: WorkflowRun): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `INSERT INTO ${this.table} (id, ${STORED_COLUMNS})
       SELECT $1::text, ${derivedColumns('doc')} FROM (SELECT $2::jsonb AS doc) AS run
       ON CONFLICT (id) DO UPDATE SET (${STORED_COLUMNS}) = (
         EXCLUDED.workflow_name, EXCLUDED.status, EXCLUDED.started_at, EXCLUDED.completed_at,
         EXCLUDED.priority, EXCLUDED.tags, EXCLUDED.trigger_id, EXCLUDED.parent_run_id,
         EXCLUDED.has_error, EXCLUDED.data
       )`,
      [run.id, JSON.stringify(run)]
    );
  }

  async get(id: string): Promise<WorkflowRun | null> {
    await this.ensureTable();
    const { rows } = await this.client.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? toRun(rows[0].data) : null;
  }

  async list(filters: WorkflowRunFilters = {}): Promise<WorkflowRun[]> {
    await this.ensureTable();
    const { where, values } = whereClause(filters);
    const direction = filters.orderDirection === 'asc' ? 'ASC' : 'DESC';
    const order = ORDER_EXPRESSIONS[filters.orderBy ?? 'startedAt'];
    const page = pageOf(filters);
    let sql = `SELECT data FROM ${this.table}${where} ORDER BY ${order} ${direction}, id ${direction}`;
    if (page.limit !== undefined) {
      values.push(page.limit);
      sql += ` LIMIT $${values.length}`;
    }
    if (page.offset > 0) {
      values.push(page.offset);
      sql += ` OFFSET $${values.length}`;
    }
    const { rows } = await this.client.query(sql, values);
    return rows.map((row) => toRun(row.data));
  }

  async count(filters: WorkflowRunFilters = {}): Promise<number> {
    await this.ensureTable();
    const { where, values } = whereClause(filters);
    const { rows } = await this.client.query(
      `SELECT COUNT(*)::int AS count FROM ${this.table}${where}`,
      values
    );
    return Number(rows[0]?.count ?? 0);
  }

  async update(id: string, updates: Partial<WorkflowRun>): Promise<void> {
    await this.ensureTable();
    const patch: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id') continue;
      if (value === undefined) removed.push(key);
      else patch[key] = value;
    }
    await this.client.query(
      `UPDATE ${this.table} SET (${STORED_COLUMNS}) = (
         SELECT ${derivedColumns('doc')} FROM (SELECT (data || $2::jsonb) - $3::text[] AS doc) AS run
       )
       WHERE id = $1`,
      [id, JSON.stringify(patch), removed]
    );
  }

  async delete(id: string): Promise<void> {
    await this.ensureTable();
    await this.client.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async getStats(workflowName?: string): Promise<WorkflowRunStats> {
    await this.ensureTable();
    const timed = 'started_at <> 0 AND completed_at <> 0';
    const { rows } = await this.client.query(
      `SELECT status,
         COUNT(*)::int AS runs,
         COALESCE(SUM(completed_at - started_at) FILTER (WHERE ${timed}), 0) AS duration_total,
         (COUNT(*) FILTER (WHERE ${timed}))::int AS duration_count
       FROM ${this.table}${workflowName ? ' WHERE workflow_name = $1' : ''}
       GROUP BY status`,
      workflowName ? [workflowName] : []
    );
    return summarizeStats(
      rows.map((row) => ({
        status: String(row.status),
        runs: Number(row.runs),
        durationTotal: Number(row.duration_total),
        durationCount: Number(row.duration_count),
      }))
    );
  }

  async cleanup(olderThan: number): Promise<number> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `WITH removed AS (
         DELETE FROM ${this.table}
         WHERE status = ANY($1::text[]) AND COALESCE(completed_at, started_at, 0) < $2
         RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM removed`,
      [[...TERMINAL_STATUSES], Date.now() - olderThan]
    );
    return Number(rows[0]?.count ?? 0);
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
         workflow_name TEXT NOT NULL,
         status TEXT NOT NULL,
         started_at DOUBLE PRECISION,
         completed_at DOUBLE PRECISION,
         priority DOUBLE PRECISION,
         tags TEXT[] NOT NULL,
         trigger_id TEXT,
         parent_run_id TEXT,
         has_error BOOLEAN NOT NULL,
         data JSONB NOT NULL
       )`
    );
    const indexes = [
      `${base}_workflow_idx ON ${this.table} (workflow_name, (COALESCE(started_at, 0)), id)`,
      `${base}_started_idx ON ${this.table} ((COALESCE(started_at, 0)), id)`,
      `${base}_status_idx ON ${this.table} (status)`,
      `${base}_completed_idx ON ${this.table} (completed_at)`,
      `${base}_tags_idx ON ${this.table} USING GIN (tags)`,
      `${base}_trigger_idx ON ${this.table} (trigger_id) WHERE trigger_id IS NOT NULL`,
      `${base}_parent_idx ON ${this.table} (parent_run_id) WHERE parent_run_id IS NOT NULL`,
    ];
    for (const index of indexes) {
      await createIfMissing(this.client, `CREATE INDEX IF NOT EXISTS ${index}`);
    }
  }
}

/** The WHERE clause for `filters`, with every value passed as a parameter. */
function whereClause(filters: WorkflowRunFilters): { where: string; values: unknown[] } {
  const values: unknown[] = [];
  const conditions: string[] = [];
  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const range = (column: string, after?: number, before?: number) => {
    if (!after && !before) return;
    conditions.push(`${column} <> 0`);
    if (after) conditions.push(`${column} >= ${param(after)}`);
    if (before) conditions.push(`${column} <= ${param(before)}`);
  };

  const statuses = statusList(filters.status);
  if (statuses) conditions.push(`status = ANY(${param(statuses)}::text[])`);
  if (filters.workflowName) conditions.push(`workflow_name = ${param(filters.workflowName)}`);
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(`tags && ${param(filters.tags)}::text[]`);
  }
  if (filters.triggerId) conditions.push(`trigger_id = ${param(filters.triggerId)}`);
  if (filters.parentRunId) conditions.push(`parent_run_id = ${param(filters.parentRunId)}`);
  range('started_at', filters.startedAfter, filters.startedBefore);
  range('completed_at', filters.completedAfter, filters.completedBefore);
  if (filters.hasError !== undefined) conditions.push(`has_error = ${param(filters.hasError)}`);

  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', values };
}

function toRun(data: unknown): WorkflowRun {
  return fromJson<WorkflowRun>(data);
}

function statusList(status: WorkflowRunFilters['status']): WorkflowRunStatus[] | undefined {
  if (!status) return undefined;
  return Array.isArray(status) ? status : [status];
}

function matchesFilters(run: WorkflowRun, filters: WorkflowRunFilters): boolean {
  const statuses = statusList(filters.status);
  if (statuses && !statuses.includes(run.status)) return false;
  if (filters.workflowName && run.workflowName !== filters.workflowName) return false;
  if (filters.tags && filters.tags.length > 0 && !filters.tags.some((t) => run.tags.includes(t))) {
    return false;
  }
  if (filters.triggerId && run.triggerId !== filters.triggerId) return false;
  if (filters.parentRunId && run.parentRunId !== filters.parentRunId) return false;
  if (!withinRange(run.startedAt, filters.startedAfter, filters.startedBefore)) return false;
  if (!withinRange(run.completedAt, filters.completedAfter, filters.completedBefore)) return false;
  return filters.hasError === undefined || Boolean(run.error) === filters.hasError;
}

function withinRange(value: number | undefined, after?: number, before?: number): boolean {
  if (!after && !before) return true;
  if (!value) return false;
  return (!after || value >= after) && (!before || value <= before);
}

function runComparator(filters: WorkflowRunFilters): (a: WorkflowRun, b: WorkflowRun) => number {
  const field = filters.orderBy ?? 'startedAt';
  const sign = filters.orderDirection === 'asc' ? 1 : -1;
  return (a, b) => {
    const byField = (a[field] ?? 0) - (b[field] ?? 0);
    if (byField !== 0) return sign * byField;
    return a.id === b.id ? 0 : sign * (a.id < b.id ? -1 : 1);
  };
}

/** Offset and limit as non-negative integers; a missing or infinite limit means all. */
function pageOf(filters: WorkflowRunFilters): Page {
  const bound = (value: number | undefined): number | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.trunc(value));
  return { offset: bound(filters.offset) ?? 0, limit: bound(filters.limit) };
}

function paginate<T>(items: T[], page: Page): T[] {
  return items.slice(page.offset, page.limit === undefined ? undefined : page.offset + page.limit);
}

function isTerminal(status: WorkflowRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function cleanupTimestamp(run: WorkflowRun): number {
  return run.completedAt ?? run.startedAt ?? 0;
}

function isRunStatus(status: string): status is WorkflowRunStatus {
  return (RUN_STATUSES as readonly string[]).includes(status);
}

function aggregateByStatus(runs: WorkflowRun[]): StatusAggregate[] {
  const byStatus = new Map<string, StatusAggregate>();
  for (const run of runs) {
    const aggregate = byStatus.get(run.status) ?? {
      status: run.status,
      runs: 0,
      durationTotal: 0,
      durationCount: 0,
    };
    aggregate.runs++;
    if (run.startedAt && run.completedAt) {
      aggregate.durationTotal += run.completedAt - run.startedAt;
      aggregate.durationCount++;
    }
    byStatus.set(run.status, aggregate);
  }
  return [...byStatus.values()];
}

function summarizeStats(aggregates: StatusAggregate[]): WorkflowRunStats {
  const byStatus: Record<WorkflowRunStatus, number> = {
    pending: 0,
    scheduled: 0,
    running: 0,
    paused: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timeout: 0,
  };
  let total = 0;
  let durationTotal = 0;
  let durationCount = 0;
  for (const aggregate of aggregates) {
    total += aggregate.runs;
    durationTotal += aggregate.durationTotal;
    durationCount += aggregate.durationCount;
    if (isRunStatus(aggregate.status)) byStatus[aggregate.status] += aggregate.runs;
  }

  const successCount = byStatus.completed;
  const failureCount = byStatus.failed + byStatus.timeout;
  const terminalCount = successCount + failureCount;

  return {
    total,
    byStatus,
    avgDuration: durationCount > 0 ? durationTotal / durationCount : 0,
    successRate: terminalCount > 0 ? successCount / terminalCount : 0,
    failureRate: terminalCount > 0 ? failureCount / terminalCount : 0,
  };
}
