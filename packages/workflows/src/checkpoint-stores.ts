/**
 * Durable workflow checkpoint stores: Redis and Postgres.
 */

import type { CheckpointStore, WorkflowCheckpoint } from '@cogitator-ai/types';

/**
 * The Redis commands the store uses; `@cogitator-ai/redis` clients and
 * ioredis both provide them.
 */
export interface CheckpointRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

export interface RedisCheckpointStoreOptions {
  client: CheckpointRedisClient;
  /** Prefix of every key (default `cogitator:workflow-checkpoints`) */
  keyPrefix?: string;
}

/**
 * Checkpoints in Redis: each as JSON under its id, with a sorted set per
 * workflow (scored by timestamp) to list them newest first.
 */
export class RedisCheckpointStore implements CheckpointStore {
  private readonly client: CheckpointRedisClient;
  private readonly prefix: string;

  constructor(options: RedisCheckpointStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:workflow-checkpoints';
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    const previous = await this.load(checkpoint.id);
    if (previous && previous.workflowName !== checkpoint.workflowName) {
      await this.client.zrem(this.indexKey(previous.workflowName), checkpoint.id);
    }
    await this.client.set(this.checkpointKey(checkpoint.id), JSON.stringify(checkpoint));
    await this.client.zadd(
      this.indexKey(checkpoint.workflowName),
      checkpoint.timestamp,
      checkpoint.id
    );
  }

  async load(id: string): Promise<WorkflowCheckpoint | null> {
    const raw = await this.client.get(this.checkpointKey(id));
    return raw ? (JSON.parse(raw) as WorkflowCheckpoint) : null;
  }

  async list(workflowName: string): Promise<WorkflowCheckpoint[]> {
    const ids = await this.client.zrange(this.indexKey(workflowName), 0, -1);
    const checkpoints: WorkflowCheckpoint[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const checkpoint = await this.load(id);
      if (checkpoint) checkpoints.push(checkpoint);
      else missing.push(id);
    }
    if (missing.length > 0) await this.client.zrem(this.indexKey(workflowName), ...missing);
    return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
  }

  async delete(id: string): Promise<void> {
    const checkpoint = await this.load(id);
    await this.client.del(this.checkpointKey(id));
    if (checkpoint) await this.client.zrem(this.indexKey(checkpoint.workflowName), id);
  }

  private checkpointKey(id: string): string {
    return `${this.prefix}:checkpoint:${id}`;
  }

  private indexKey(workflowName: string): string {
    return `${this.prefix}:workflow:${workflowName}`;
  }
}

/** The query method of a `pg` Pool or Client. */
export interface CheckpointPgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresCheckpointStoreOptions {
  client: CheckpointPgClient;
  /** Table name (default `cogitator_workflow_checkpoints`); created on first use */
  table?: string;
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Checkpoints in a Postgres table, as JSONB rows indexed by workflow and time. */
export class PostgresCheckpointStore implements CheckpointStore {
  private readonly client: CheckpointPgClient;
  private readonly table: string;
  private ready?: Promise<void>;

  constructor(options: PostgresCheckpointStoreOptions) {
    const table = options.table ?? 'cogitator_workflow_checkpoints';
    if (!TABLE_NAME.test(table)) {
      throw new Error(`Invalid checkpoint table name: ${table}`);
    }
    this.client = options.client;
    this.table = table;
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `INSERT INTO ${this.table} (id, workflow_name, data, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET workflow_name = EXCLUDED.workflow_name, data = EXCLUDED.data, created_at = EXCLUDED.created_at`,
      [checkpoint.id, checkpoint.workflowName, JSON.stringify(checkpoint), checkpoint.timestamp]
    );
  }

  async load(id: string): Promise<WorkflowCheckpoint | null> {
    await this.ensureTable();
    const { rows } = await this.client.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? toCheckpoint(rows[0].data) : null;
  }

  async list(workflowName: string): Promise<WorkflowCheckpoint[]> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table} WHERE workflow_name = $1 ORDER BY created_at DESC`,
      [workflowName]
    );
    return rows.map((row) => toCheckpoint(row.data));
  }

  async delete(id: string): Promise<void> {
    await this.ensureTable();
    await this.client.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  private ensureTable(): Promise<void> {
    this.ready ??= this.createTable().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async createTable(): Promise<void> {
    const index = `${this.table.replace('.', '_')}_workflow_idx`;
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id TEXT PRIMARY KEY,
         workflow_name TEXT NOT NULL,
         data JSONB NOT NULL,
         created_at BIGINT NOT NULL
       )`
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${index} ON ${this.table} (workflow_name, created_at DESC)`
    );
  }
}

/** `pg` returns JSONB columns parsed; other drivers may return the text. */
function toCheckpoint(data: unknown): WorkflowCheckpoint {
  return (typeof data === 'string' ? JSON.parse(data) : data) as WorkflowCheckpoint;
}
