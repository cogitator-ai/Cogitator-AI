import type {
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  SQLiteAdapterConfig,
  MemoryProvider,
} from '@cogitator-ai/types';
import { BaseMemoryAdapter } from './base';

interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  pragma(pragma: string): unknown;
}

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export class SQLiteAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'sqlite';

  private db: Database | null = null;
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

    let Database: new (path: string) => Database;
    try {
      const betterSqlite = await import('better-sqlite3');
      Database = betterSqlite.default as unknown as new (path: string) => Database;
    } catch {
      return this.failure('better-sqlite3 not installed. Run: pnpm add better-sqlite3');
    }

    try {
      this.db = new Database(this.path);

      this.db.pragma('foreign_keys = ON');
      if (this.walMode && this.path !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }

      this.db.exec(`
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
      `);

      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return this.success(undefined);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');

    const thread: Thread = {
      id: threadId ?? this.generateId('thread'),
      agentId,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO threads (id, agent_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        thread.id,
        thread.agentId,
        JSON.stringify(thread.metadata),
        thread.createdAt.toISOString(),
        thread.updatedAt.toISOString()
      );
      return this.success(thread);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const stmt = this.db.prepare('SELECT * FROM threads WHERE id = ?');
      const row = stmt.get(threadId) as
        | {
            id: string;
            agent_id: string;
            metadata: string;
            created_at: string;
            updated_at: string;
          }
        | undefined;

      if (!row) return this.success(null);

      return this.success({
        id: row.id,
        agentId: row.agent_id,
        metadata: JSON.parse(row.metadata),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');

    const existing = await this.getThread(threadId);
    if (!existing.success) return existing;
    if (!existing.data) return this.failure(`Thread not found: ${threadId}`);

    const updated: Thread = {
      ...existing.data,
      metadata: { ...existing.data.metadata, ...metadata },
      updatedAt: new Date(),
    };

    try {
      const stmt = this.db.prepare(`
        UPDATE threads SET metadata = ?, updated_at = ? WHERE id = ?
      `);
      stmt.run(JSON.stringify(updated.metadata), updated.updatedAt.toISOString(), threadId);
      return this.success(updated);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      this.db.prepare('DELETE FROM entries WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');

    const full: MemoryEntry = {
      ...entry,
      id: this.generateId('entry'),
      createdAt: new Date(),
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

      let sql = `SELECT * FROM entries WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`;
      if (options.limit) {
        sql = `SELECT * FROM (
          SELECT * FROM entries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?
        ) ORDER BY created_at ASC`;
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
}
