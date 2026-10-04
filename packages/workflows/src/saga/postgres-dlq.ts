import type { DeadLetterEntry } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { createIfMissing, TABLE_NAME } from '../postgres-schema';
import { BaseDLQ, type DLQFilters } from './dead-letter';

/** The query method of a pg Pool or Client, all the store needs. */
export interface DLQPgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresDLQOptions {
  client: DLQPgClient;
  /** Table name (default `cogitator_workflow_dead_letters`); created on first use */
  table?: string;
  /** How long an entry is kept, default 7 days */
  defaultTTL?: number;
}

/**
 * Dead letter queue in Postgres, so failed nodes survive a restart and every process of an app
 * sees the same queue. Entries are stored whole as JSONB, with the fields filters use in their
 * own columns. Expired entries are never returned and `cleanupExpired()` deletes them.
 */
export class PostgresDLQ extends BaseDLQ {
  private readonly client: DLQPgClient;
  private readonly table: string;
  private readonly defaultTTL: number;
  private ready?: Promise<void>;

  constructor(options: PostgresDLQOptions) {
    super();
    const table = options.table ?? 'cogitator_workflow_dead_letters';
    if (!TABLE_NAME.test(table)) throw new Error(`Invalid dead letter table name: ${table}`);
    this.client = options.client;
    this.table = table;
    this.defaultTTL = options.defaultTTL ?? 7 * 24 * 60 * 60 * 1000;
  }

  async add(entry: DeadLetterEntry): Promise<string> {
    await this.ensureTable();
    const id = `dlq_${nanoid(12)}`;
    const now = Date.now();
    const stored: DeadLetterEntry = {
      ...entry,
      id,
      createdAt: now,
      expiresAt: now + this.defaultTTL,
    };
    await this.client.query(
      `INSERT INTO ${this.table} (id, workflow_id, workflow_name, node_id, attempts, created_at, expires_at, tags, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        id,
        stored.workflowId,
        stored.workflowName,
        stored.nodeId,
        stored.attempts,
        stored.createdAt,
        stored.expiresAt,
        stored.tags ?? [],
        JSON.stringify(stored),
      ]
    );
    return id;
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table} WHERE id = $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [id, Date.now()]
    );
    return rows[0] ? (rows[0].data as DeadLetterEntry) : null;
  }

  async list(filters: DLQFilters = {}): Promise<DeadLetterEntry[]> {
    await this.ensureTable();
    const { where, values } = this.where(filters);
    let sql = `SELECT data FROM ${this.table} ${where} ORDER BY created_at DESC, id`;
    if (filters.limit !== undefined) {
      values.push(filters.limit);
      sql += ` LIMIT $${values.length}`;
    }
    if (filters.offset !== undefined) {
      values.push(filters.offset);
      sql += ` OFFSET $${values.length}`;
    }
    const { rows } = await this.client.query(sql, values);
    return rows.map((row) => row.data as DeadLetterEntry);
  }

  /**
   * Records a retry attempt: `attempts` goes up by one and `lastAttempt` is now. Running the node
   * again is `WorkflowManager.retryDeadLetter`'s job, which calls this.
   */
  async retry(id: string): Promise<boolean> {
    await this.ensureTable();
    const now = Date.now();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
       SET attempts = attempts + 1,
           data = jsonb_set(jsonb_set(data, '{attempts}', to_jsonb(attempts + 1)), '{lastAttempt}', to_jsonb($2::bigint))
       WHERE id = $1 AND (expires_at IS NULL OR expires_at > $2)
       RETURNING id`,
      [id, now]
    );
    return rows.length > 0;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `DELETE FROM ${this.table} WHERE id = $1 RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  async count(filters: DLQFilters = {}): Promise<number> {
    await this.ensureTable();
    const { where, values } = this.where(filters);
    const { rows } = await this.client.query(
      `SELECT count(*)::int AS n FROM ${this.table} ${where}`,
      values
    );
    return Number(rows[0]?.n ?? 0);
  }

  async clear(): Promise<void> {
    await this.ensureTable();
    await this.client.query(`DELETE FROM ${this.table}`);
  }

  /** Deletes expired entries and says how many went. */
  async cleanupExpired(): Promise<number> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= $1 RETURNING id`,
      [Date.now()]
    );
    return rows.length;
  }

  private where(filters: DLQFilters): { where: string; values: unknown[] } {
    const values: unknown[] = [Date.now()];
    const clauses = ['(expires_at IS NULL OR expires_at > $1)'];
    const add = (sql: (n: number) => string, value: unknown) => {
      values.push(value);
      clauses.push(sql(values.length));
    };
    if (filters.workflowId !== undefined) add((n) => `workflow_id = $${n}`, filters.workflowId);
    if (filters.workflowName !== undefined)
      add((n) => `workflow_name = $${n}`, filters.workflowName);
    if (filters.nodeId !== undefined) add((n) => `node_id = $${n}`, filters.nodeId);
    if (filters.minAttempts !== undefined) add((n) => `attempts >= $${n}`, filters.minAttempts);
    if (filters.maxAttempts !== undefined) add((n) => `attempts <= $${n}`, filters.maxAttempts);
    if (filters.createdAfter !== undefined) add((n) => `created_at >= $${n}`, filters.createdAfter);
    if (filters.createdBefore !== undefined)
      add((n) => `created_at <= $${n}`, filters.createdBefore);
    if (filters.tags !== undefined && filters.tags.length > 0)
      add((n) => `tags @> $${n}::text[]`, filters.tags);
    return { where: `WHERE ${clauses.join(' AND ')}`, values };
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
         workflow_name TEXT NOT NULL,
         node_id TEXT NOT NULL,
         attempts INTEGER NOT NULL,
         created_at BIGINT NOT NULL,
         expires_at BIGINT,
         tags TEXT[] NOT NULL,
         data JSONB NOT NULL
       )`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${base}_workflow_idx ON ${this.table} (workflow_id, created_at DESC)`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${base}_created_idx ON ${this.table} (created_at DESC)`
    );
  }
}
