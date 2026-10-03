/**
 * Durable approval stores: Redis and Postgres.
 *
 * A human node often waits in one process (a worker) while the answer is
 * submitted from another (a web server), so `onResponse` both reacts to
 * responses submitted through the same store instance and polls the backend
 * for responses written elsewhere.
 */

import type { ApprovalRequest, ApprovalResponse, ApprovalStore } from '@cogitator-ai/types';
import { createIfMissing, fromJson, TABLE_NAME } from '../postgres-schema';

const DEFAULT_POLL_INTERVAL = 1000;

/** Options shared by the durable approval stores. */
export interface DurableApprovalStoreOptions {
  /** How often, in ms, a request someone waits on is checked for a response from another process (default 1000) */
  pollInterval?: number;
  /** Called when checking for a response fails; polling continues */
  onPollError?: (error: unknown, requestId: string) => void;
}

/**
 * The Redis commands the store uses; `@cogitator-ai/redis` clients and
 * ioredis both provide them.
 */
export interface ApprovalStoreRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

export interface RedisApprovalStoreOptions extends DurableApprovalStoreOptions {
  client: ApprovalStoreRedisClient;
  /** Prefix of every key (default `cogitator:workflow-approvals`); in cluster mode include a hash tag, e.g. `{approvals}` */
  keyPrefix?: string;
}

/**
 * Approvals in Redis: requests and responses as JSON under their id, with
 * sorted sets (scored by creation time) of pending request ids overall, per
 * workflow and per assignee, so pending lookups never scan the keyspace.
 */
export class RedisApprovalStore implements ApprovalStore {
  private readonly client: ApprovalStoreRedisClient;
  private readonly prefix: string;
  private readonly watcher: ResponseWatcher;

  constructor(options: RedisApprovalStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:workflow-approvals';
    this.watcher = new ResponseWatcher((requestId) => this.getResponse(requestId), options);
  }

  async createRequest(request: ApprovalRequest): Promise<void> {
    const [previous, answered] = await Promise.all([
      this.getRequest(request.id),
      this.client.get(this.responseKey(request.id)),
    ]);
    await this.client.set(this.requestKey(request.id), JSON.stringify(request));

    const indexes = answered === null ? this.pendingIndexes(request) : [];
    if (previous) {
      const outdated = this.pendingIndexes(previous).filter((key) => !indexes.includes(key));
      await Promise.all(outdated.map((key) => this.client.zrem(key, request.id)));
    }
    await Promise.all(indexes.map((key) => this.client.zadd(key, request.createdAt, request.id)));
  }

  async getRequest(id: string): Promise<ApprovalRequest | null> {
    const raw = await this.client.get(this.requestKey(id));
    return raw ? (JSON.parse(raw) as ApprovalRequest) : null;
  }

  async getPendingRequests(workflowId?: string): Promise<ApprovalRequest[]> {
    if (workflowId) {
      return this.readPending(
        this.workflowIndexKey(workflowId),
        (request) => request.workflowId === workflowId
      );
    }
    return this.readPending(this.pendingKey(), () => true);
  }

  async getPendingForAssignee(assignee: string): Promise<ApprovalRequest[]> {
    return this.readPending(this.assigneeIndexKey(assignee), (request) =>
      isAssignedTo(request, assignee)
    );
  }

  async submitResponse(response: ApprovalResponse): Promise<void> {
    await this.client.set(this.responseKey(response.requestId), JSON.stringify(response));
    const request = await this.getRequest(response.requestId);
    if (request) {
      await Promise.all(
        this.pendingIndexes(request).map((key) => this.client.zrem(key, request.id))
      );
    }
    this.watcher.deliver(response);
  }

  async getResponse(requestId: string): Promise<ApprovalResponse | null> {
    const raw = await this.client.get(this.responseKey(requestId));
    return raw ? (JSON.parse(raw) as ApprovalResponse) : null;
  }

  async deleteRequest(id: string): Promise<void> {
    this.watcher.cancel(id);
    const request = await this.getRequest(id);
    await this.client.del(this.requestKey(id), this.responseKey(id));
    if (request) {
      await Promise.all(this.pendingIndexes(request).map((key) => this.client.zrem(key, id)));
    }
  }

  onResponse(requestId: string, callback: (response: ApprovalResponse) => void): () => void {
    return this.watcher.watch(requestId, callback);
  }

  /** Stop polling and drop every registered callback. */
  dispose(): void {
    this.watcher.dispose();
  }

  private async readPending(
    indexKey: string,
    belongs: (request: ApprovalRequest) => boolean
  ): Promise<ApprovalRequest[]> {
    const ids = await this.client.zrange(indexKey, 0, -1);
    if (ids.length === 0) return [];

    const [requests, responses] = await Promise.all([
      this.client.mget(...ids.map((id) => this.requestKey(id))),
      this.client.mget(...ids.map((id) => this.responseKey(id))),
    ]);

    const pending: ApprovalRequest[] = [];
    const stale: string[] = [];
    ids.forEach((id, index) => {
      const raw = requests[index];
      const request = raw ? (JSON.parse(raw) as ApprovalRequest) : null;
      if (request && responses[index] === null && belongs(request)) pending.push(request);
      else stale.push(id);
    });

    if (stale.length > 0) await this.client.zrem(indexKey, ...stale);
    return pending;
  }

  private pendingIndexes(request: ApprovalRequest): string[] {
    const assignees = new Set(request.assigneeGroup ?? []);
    if (request.assignee !== undefined) assignees.add(request.assignee);
    return [
      this.pendingKey(),
      this.workflowIndexKey(request.workflowId),
      ...[...assignees].map((assignee) => this.assigneeIndexKey(assignee)),
    ];
  }

  private requestKey(id: string): string {
    return `${this.prefix}:request:${id}`;
  }

  private responseKey(requestId: string): string {
    return `${this.prefix}:response:${requestId}`;
  }

  private pendingKey(): string {
    return `${this.prefix}:pending`;
  }

  private workflowIndexKey(workflowId: string): string {
    return `${this.prefix}:pending:workflow:${workflowId}`;
  }

  private assigneeIndexKey(assignee: string): string {
    return `${this.prefix}:pending:assignee:${assignee}`;
  }
}

/** The query method of a `pg` Pool or Client. */
export interface ApprovalStorePgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresApprovalStoreOptions extends DurableApprovalStoreOptions {
  client: ApprovalStorePgClient;
  /**
   * Prefix of the two tables, `<prefix>_requests` and `<prefix>_responses`
   * (default `cogitator_workflow_approvals`); created on first use
   */
  tablePrefix?: string;
}

/**
 * Approvals in Postgres: a requests table with the workflow and assignees
 * as indexed columns next to the JSONB request, and a responses table keyed
 * by request id; pending means no matching response row.
 */
export class PostgresApprovalStore implements ApprovalStore {
  private readonly client: ApprovalStorePgClient;
  private readonly requests: string;
  private readonly responses: string;
  private readonly indexPrefix: string;
  private readonly watcher: ResponseWatcher;
  private ready?: Promise<void>;

  constructor(options: PostgresApprovalStoreOptions) {
    const prefix = options.tablePrefix ?? 'cogitator_workflow_approvals';
    if (!TABLE_NAME.test(prefix)) {
      throw new Error(`Invalid approval table prefix: ${prefix}`);
    }
    this.client = options.client;
    this.requests = `${prefix}_requests`;
    this.responses = `${prefix}_responses`;
    this.indexPrefix = prefix.replace('.', '_');
    this.watcher = new ResponseWatcher((requestId) => this.getResponse(requestId), options);
  }

  async createRequest(request: ApprovalRequest): Promise<void> {
    await this.ensureTables();
    await this.client.query(
      `INSERT INTO ${this.requests} (id, workflow_id, assignee, assignee_group, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET workflow_id = EXCLUDED.workflow_id, assignee = EXCLUDED.assignee,
             assignee_group = EXCLUDED.assignee_group, created_at = EXCLUDED.created_at,
             data = EXCLUDED.data`,
      [
        request.id,
        request.workflowId,
        request.assignee ?? null,
        request.assigneeGroup ?? [],
        request.createdAt,
        JSON.stringify(request),
      ]
    );
  }

  async getRequest(id: string): Promise<ApprovalRequest | null> {
    await this.ensureTables();
    const { rows } = await this.client.query(`SELECT data FROM ${this.requests} WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? fromJson<ApprovalRequest>(rows[0].data) : null;
  }

  async getPendingRequests(workflowId?: string): Promise<ApprovalRequest[]> {
    await this.ensureTables();
    const { rows } = workflowId
      ? await this.client.query(
          `SELECT r.data FROM ${this.requests} r
           WHERE r.workflow_id = $1 AND ${this.unanswered()}
           ORDER BY r.created_at, r.id`,
          [workflowId]
        )
      : await this.client.query(
          `SELECT r.data FROM ${this.requests} r
           WHERE ${this.unanswered()}
           ORDER BY r.created_at, r.id`
        );
    return rows.map((row) => fromJson<ApprovalRequest>(row.data));
  }

  async getPendingForAssignee(assignee: string): Promise<ApprovalRequest[]> {
    await this.ensureTables();
    const { rows } = await this.client.query(
      `SELECT r.data FROM ${this.requests} r
       WHERE (r.assignee = $1 OR r.assignee_group @> ARRAY[$1]::text[]) AND ${this.unanswered()}
       ORDER BY r.created_at, r.id`,
      [assignee]
    );
    return rows.map((row) => fromJson<ApprovalRequest>(row.data));
  }

  async submitResponse(response: ApprovalResponse): Promise<void> {
    await this.ensureTables();
    await this.client.query(
      `INSERT INTO ${this.responses} (request_id, data)
       VALUES ($1, $2)
       ON CONFLICT (request_id) DO UPDATE SET data = EXCLUDED.data`,
      [response.requestId, JSON.stringify(response)]
    );
    this.watcher.deliver(response);
  }

  async getResponse(requestId: string): Promise<ApprovalResponse | null> {
    await this.ensureTables();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.responses} WHERE request_id = $1`,
      [requestId]
    );
    return rows[0] ? fromJson<ApprovalResponse>(rows[0].data) : null;
  }

  async deleteRequest(id: string): Promise<void> {
    this.watcher.cancel(id);
    await this.ensureTables();
    await this.client.query(
      `WITH removed AS (DELETE FROM ${this.responses} WHERE request_id = $1)
       DELETE FROM ${this.requests} WHERE id = $1`,
      [id]
    );
  }

  onResponse(requestId: string, callback: (response: ApprovalResponse) => void): () => void {
    return this.watcher.watch(requestId, callback);
  }

  /** Stop polling and drop every registered callback. */
  dispose(): void {
    this.watcher.dispose();
  }

  private unanswered(): string {
    return `NOT EXISTS (SELECT 1 FROM ${this.responses} s WHERE s.request_id = r.id)`;
  }

  private ensureTables(): Promise<void> {
    this.ready ??= this.createTables().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async createTables(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${this.requests} (
         id TEXT PRIMARY KEY,
         workflow_id TEXT NOT NULL,
         assignee TEXT,
         assignee_group TEXT[] NOT NULL DEFAULT '{}',
         created_at BIGINT NOT NULL,
         data JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.responses} (
         request_id TEXT PRIMARY KEY,
         data JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ${this.indexPrefix}_requests_workflow_idx
         ON ${this.requests} (workflow_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS ${this.indexPrefix}_requests_assignee_idx
         ON ${this.requests} (assignee)`,
      `CREATE INDEX IF NOT EXISTS ${this.indexPrefix}_requests_assignee_group_idx
         ON ${this.requests} USING GIN (assignee_group)`,
    ];
    for (const statement of statements) await createIfMissing(this.client, statement);
  }
}

type ResponseCallback = (response: ApprovalResponse) => void;

interface ResponseWatch {
  readonly listeners: Set<{ readonly callback: ResponseCallback }>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Callbacks waiting for responses: delivered at once for responses submitted
 * through the store, and found by polling for responses written elsewhere
 * while at least one callback for the request is registered.
 */
class ResponseWatcher {
  private readonly watches = new Map<string, ResponseWatch>();
  private readonly pollInterval: number;
  private readonly onPollError?: (error: unknown, requestId: string) => void;

  constructor(
    private readonly fetch: (requestId: string) => Promise<ApprovalResponse | null>,
    options: DurableApprovalStoreOptions
  ) {
    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.onPollError = options.onPollError;
  }

  watch(requestId: string, callback: ResponseCallback): () => void {
    let watch = this.watches.get(requestId);
    if (!watch) {
      watch = { listeners: new Set() };
      this.watches.set(requestId, watch);
      this.schedule(requestId, watch);
    }
    const listener = { callback };
    watch.listeners.add(listener);
    void this.check(requestId, watch);

    const subscribed = watch;
    return () => {
      subscribed.listeners.delete(listener);
      if (subscribed.listeners.size === 0) this.stop(requestId, subscribed);
    };
  }

  deliver(response: ApprovalResponse): void {
    const watch = this.watches.get(response.requestId);
    if (!watch) return;
    this.stop(response.requestId, watch);
    const listeners = [...watch.listeners];
    watch.listeners.clear();
    for (const { callback } of listeners) {
      try {
        callback(response);
      } catch {}
    }
  }

  cancel(requestId: string): void {
    const watch = this.watches.get(requestId);
    if (!watch) return;
    this.stop(requestId, watch);
    watch.listeners.clear();
  }

  dispose(): void {
    for (const requestId of [...this.watches.keys()]) this.cancel(requestId);
  }

  private stop(requestId: string, watch: ResponseWatch): void {
    if (watch.timer !== undefined) clearTimeout(watch.timer);
    watch.timer = undefined;
    if (this.watches.get(requestId) === watch) this.watches.delete(requestId);
  }

  private schedule(requestId: string, watch: ResponseWatch): void {
    const timer = setTimeout(() => void this.poll(requestId, watch), this.pollInterval);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    watch.timer = timer;
  }

  private async poll(requestId: string, watch: ResponseWatch): Promise<void> {
    watch.timer = undefined;
    await this.check(requestId, watch);
    if (this.watches.get(requestId) === watch) this.schedule(requestId, watch);
  }

  private async check(requestId: string, watch: ResponseWatch): Promise<void> {
    let response: ApprovalResponse | null;
    try {
      response = await this.fetch(requestId);
    } catch (error) {
      this.onPollError?.(error, requestId);
      return;
    }
    if (response && this.watches.get(requestId) === watch) this.deliver(response);
  }
}

function isAssignedTo(request: ApprovalRequest, assignee: string): boolean {
  return request.assignee === assignee || (request.assigneeGroup?.includes(assignee) ?? false);
}
