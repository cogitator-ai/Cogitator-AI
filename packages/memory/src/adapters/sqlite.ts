import type {
  ListThreadsOptions,
  Thread,
  ThreadPage,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  SQLiteAdapterConfig,
  MemoryProvider,
  NewMemoryEntry,
} from '@cogitator-ai/types';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BaseMemoryAdapter } from './base';
import type { SqliteDatabase } from './sqlite-driver';
import { threadListing, threadPage, type ThreadListing } from './thread-listing';

/** Whether `path` names a database file on disk rather than an in-memory or temporary database. */
function isFileDatabase(path: string): boolean {
  return path !== '' && path !== ':memory:' && !path.startsWith('file::memory:');
}

/** The SQL condition and its parameters that hold when a thread's metadata has `value` under `key`. */
function metadataCondition(key: string, value: string | number | boolean): [string, unknown[]] {
  const path = `$."${key}"`;
  if (typeof value === 'boolean') {
    return ['json_type(metadata, ?) = ?', [path, value ? 'true' : 'false']];
  }
  const types = typeof value === 'number' ? "('integer', 'real')" : "('text')";
  return [
    `(json_type(metadata, ?) IN ${types} AND json_extract(metadata, ?) = ?)`,
    [path, path, value],
  ];
}

interface ThreadRow {
  id: string;
  agent_id: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export class SQLiteAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'sqlite';

  private db: SqliteDatabase | null = null;
  private path: string;
  private walMode: boolean;

  constructor(config: SQLiteAdapterConfig) {
    super();
    this.path = config.path;
    this.walMode = config.walMode ?? true;
  }

  async connect(): Promise<MemoryResult<void>> {
    if (this.db) {
      return this.success(undefined);
    }

    let Database: typeof import('better-sqlite3');
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      return this.failure('better-sqlite3 not installed. Run: pnpm add better-sqlite3');
    }

    let db: InstanceType<typeof Database> | undefined;
    try {
      if (isFileDatabase(this.path)) {
        await mkdir(dirname(this.path), { recursive: true });
      }
      db = new Database(this.path);

      db.pragma('foreign_keys = ON');
      if (this.walMode && this.path !== ':memory:') {
        db.pragma('journal_mode = WAL');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          message TEXT NOT NULL,
          tool_calls TEXT,
          tool_results TEXT,
          token_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          metadata TEXT,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_entries_thread ON entries(thread_id);
        CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
        CREATE INDEX IF NOT EXISTS idx_threads_agent ON threads(agent_id);
        CREATE INDEX IF NOT EXISTS idx_threads_agent_updated ON threads(agent_id, updated_at, id);
        CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at, id);
      `);

      this.db = db;
      return this.success(undefined);
    } catch (err) {
      if (db?.open) db.close();
      return this.failure((err as Error).message);
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.db) {
      try {
        this.db.close();
        return this.success(undefined);
      } catch (err) {
        return this.failure((err as Error).message);
      } finally {
        this.db = null;
      }
    }
    return this.success(undefined);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');

    const id = threadId ?? this.generateId('thread');
    const now = new Date().toISOString();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO threads (id, agent_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          agent_id = excluded.agent_id,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
        RETURNING *
      `);
      const row = stmt.get(id, agentId, JSON.stringify(metadata), now, now) as
        ThreadRow | undefined;
      if (!row) return this.failure(`Failed to create thread: ${id}`);
      return this.success(this.rowToThread(row));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const stmt = this.db.prepare('SELECT * FROM threads WHERE id = ?');
      const row = stmt.get(threadId) as ThreadRow | undefined;

      if (!row) return this.success(null);
      return this.success(this.rowToThread(row));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>> {
    if (!this.db) return this.failure('Not connected');
    const listing = threadListing(options);
    if (typeof listing === 'string') return this.failure(listing);

    try {
      const [where, params] = this.listingConditions(listing);
      const direction = listing.order === 'asc' ? 'ASC' : 'DESC';
      const rows = this.db
        .prepare(
          `SELECT * FROM threads ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY updated_at ${direction}, id ${direction} LIMIT ?`
        )
        .all(...params, listing.limit + 1) as ThreadRow[];
      return this.success(
        threadPage(
          rows.map((row) => this.rowToThread(row)),
          listing
        )
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * The WHERE conditions of `listing` with their parameters. Times are stored as ISO strings of
   * one length, so they compare as text in time order.
   */
  private listingConditions(listing: ThreadListing): [string[], unknown[]] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (listing.agentId !== undefined) {
      where.push('agent_id = ?');
      params.push(listing.agentId);
    }
    for (const [key, value] of listing.metadata) {
      const [condition, values] = metadataCondition(key, value);
      where.push(condition);
      params.push(...values);
    }
    if (listing.updatedAfter) {
      where.push('updated_at >= ?');
      params.push(listing.updatedAfter.toISOString());
    }
    if (listing.cursor) {
      const after = listing.order === 'asc' ? '>' : '<';
      const time = new Date(listing.cursor.updatedAt).toISOString();
      where.push(`(updated_at ${after} ? OR (updated_at = ? AND id ${after} ?))`);
      params.push(time, time, listing.cursor.id);
    }
    return [where, params];
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');
    const db = this.db;

    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as
          ThreadRow | undefined;
        if (!row) {
          db.exec('ROLLBACK');
          return this.failure(`Thread not found: ${threadId}`);
        }
        const existing = this.rowToThread(row);
        const updated: Thread = {
          ...existing,
          metadata: { ...existing.metadata, ...metadata },
          updatedAt: new Date(),
        };
        db.prepare('UPDATE threads SET metadata = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(updated.metadata),
          updated.updatedAt.toISOString(),
          threadId
        );
        db.exec('COMMIT');
        return this.success(updated);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');

    const full: MemoryEntry = {
      ...entry,
      id: this.generateId('entry'),
      createdAt: this.entryTimestamp(entry),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO entries (id, thread_id, message, tool_calls, tool_results, token_count, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        full.id,
        full.threadId,
        JSON.stringify(full.message),
        full.toolCalls ? JSON.stringify(full.toolCalls) : null,
        full.toolResults ? JSON.stringify(full.toolResults) : null,
        full.tokenCount,
        full.createdAt.toISOString(),
        full.metadata ? JSON.stringify(full.metadata) : null
      );
      return this.success(full);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.db) return this.failure('Not connected');
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);

    try {
      const conditions = ['thread_id = ?'];
      const params: unknown[] = [options.threadId];

      if (options.before) {
        conditions.push('created_at < ?');
        params.push(options.before.toISOString());
      }
      if (options.after) {
        conditions.push('created_at > ?');
        params.push(options.after.toISOString());
      }

      let sql = `SELECT * FROM entries WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, rowid ASC`;
      if (options.limit) {
        sql = `SELECT * FROM (
          SELECT *, rowid AS entry_order FROM entries WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        ) ORDER BY created_at ASC, entry_order ASC`;
        params.push(options.limit);
      }

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Array<{
        id: string;
        thread_id: string;
        message: string;
        tool_calls: string | null;
        tool_results: string | null;
        token_count: number;
        created_at: string;
        metadata: string | null;
      }>;

      const entries: MemoryEntry[] = rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        message: JSON.parse(row.message),
        toolCalls:
          options.includeToolCalls && row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        toolResults:
          options.includeToolCalls && row.tool_results ? JSON.parse(row.tool_results) : undefined,
        tokenCount: row.token_count,
        createdAt: new Date(row.created_at),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      }));

      return this.success(entries);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const stmt = this.db.prepare('SELECT * FROM entries WHERE id = ?');
      const row = stmt.get(entryId) as
        | {
            id: string;
            thread_id: string;
            message: string;
            tool_calls: string | null;
            tool_results: string | null;
            token_count: number;
            created_at: string;
            metadata: string | null;
          }
        | undefined;

      if (!row) return this.success(null);

      return this.success({
        id: row.id,
        threadId: row.thread_id,
        message: JSON.parse(row.message),
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        toolResults: row.tool_results ? JSON.parse(row.tool_results) : undefined,
        tokenCount: row.token_count,
        createdAt: new Date(row.created_at),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      this.db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      this.db.prepare('DELETE FROM entries WHERE thread_id = ?').run(threadId);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  private rowToThread(row: ThreadRow): Thread {
    return {
      id: row.id,
      agentId: row.agent_id,
      metadata: JSON.parse(row.metadata),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
