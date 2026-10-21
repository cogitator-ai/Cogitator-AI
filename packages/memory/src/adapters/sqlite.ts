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
  MemoryEntryType,
  PathQueryOptions,
  MemoryEntity,
  MemoryEntityFilter,
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemFilter,
} from '@cogitator-ai/types';
import { CONVERSATION_ENTRY_TYPES, MEMORY_ENTRY_FORMAT } from '@cogitator-ai/types';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BranchingMemoryAdapter, MAX_PATH_DEPTH } from './base';
import type { SqliteDatabase } from './sqlite-driver';
import { sqliteMemoryItems } from './sqlite-memory-items';
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
  active_leaf_id?: string | null;
}

interface EntryRow {
  id: string;
  thread_id: string;
  message: string;
  tool_calls: string | null;
  tool_results: string | null;
  token_count: number;
  created_at: string;
  metadata: string | null;
  type: string | null;
  parent_id: string | null;
  event: string | null;
  format_version: number | null;
  seq: number;
}

/**
 * Layout of the database, kept in `PRAGMA user_version`. 1: entries form trees (`parent_id`,
 * `type`, `event`, `format_version`, a `seq` of their order in the thread) and threads name their
 * active leaf. Entries written before are chained in the order they were added and marked as
 * format 1.
 */
const SCHEMA_VERSION = 1;

/** A SQL condition on an entry's type, `alias` naming the entries table, with its parameters */
function typeCondition(
  types: readonly MemoryEntryType[] | 'all' | undefined,
  alias = ''
): [string, unknown[]] {
  if (types === 'all') return ['1 = 1', []];
  const wanted = types ?? CONVERSATION_ENTRY_TYPES;
  if (wanted.length === 0) return ['1 = 0', []];
  return [
    `COALESCE(${alias}type, 'message') IN (${wanted.map(() => '?').join(', ')})`,
    [...wanted],
  ];
}

function rowToEntry(row: EntryRow, includeToolCalls: boolean): MemoryEntry {
  return {
    id: row.id,
    threadId: row.thread_id,
    message: JSON.parse(row.message),
    ...(includeToolCalls && row.tool_calls && { toolCalls: JSON.parse(row.tool_calls) }),
    ...(includeToolCalls && row.tool_results && { toolResults: JSON.parse(row.tool_results) }),
    tokenCount: row.token_count,
    createdAt: new Date(row.created_at),
    ...(row.metadata && { metadata: JSON.parse(row.metadata) }),
    type: (row.type ?? 'message') as MemoryEntryType,
    parentId: row.parent_id,
    seq: row.seq,
    ...(row.event && { event: JSON.parse(row.event) }),
    formatVersion: row.format_version ?? 1,
  };
}

export class SQLiteAdapter extends BranchingMemoryAdapter implements MemoryItemAdapter {
  readonly provider: MemoryProvider = 'sqlite';

  private db: SqliteDatabase | null = null;
  private items: MemoryItemAdapter | null = null;
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
      this.migrate(db);
      this.items = sqliteMemoryItems(db);

      this.db = db;
      return this.success(undefined);
    } catch (err) {
      if (db?.open) db.close();
      return this.failure((err as Error).message);
    }
  }

  /**
   * Brings the database to {@link SCHEMA_VERSION}, in one transaction that holds the write lock,
   * so processes opening it at once take turns
   */
  private migrate(db: SqliteDatabase): void {
    if (Number(db.pragma('user_version', { simple: true })) >= SCHEMA_VERSION) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (Number(db.pragma('user_version', { simple: true })) < SCHEMA_VERSION) {
        const columns = (table: string) =>
          new Set(
            (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
              (column) => column.name
            )
          );
        const entryColumns = columns('entries');
        for (const [name, type] of [
          ['type', 'TEXT'],
          ['parent_id', 'TEXT'],
          ['event', 'TEXT'],
          ['format_version', 'INTEGER'],
          ['seq', 'INTEGER'],
        ] as const) {
          if (!entryColumns.has(name)) db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${type}`);
        }
        if (!columns('threads').has('active_leaf_id')) {
          db.exec('ALTER TABLE threads ADD COLUMN active_leaf_id TEXT');
        }
        db.exec(`
          UPDATE entries SET seq = rowid WHERE seq IS NULL;
          UPDATE entries SET parent_id = (
            SELECT previous FROM (
              SELECT id, LAG(id) OVER (
                PARTITION BY thread_id ORDER BY created_at, seq
              ) AS previous FROM entries
            ) ordered WHERE ordered.id = entries.id
          ), format_version = 1 WHERE format_version IS NULL;
          UPDATE threads SET active_leaf_id = (
            SELECT id FROM entries WHERE entries.thread_id = threads.id
            ORDER BY created_at DESC, seq DESC LIMIT 1
          ) WHERE active_leaf_id IS NULL;
          CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(thread_id, parent_id);
          CREATE INDEX IF NOT EXISTS idx_entries_seq ON entries(thread_id, seq);
        `);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
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
        this.items = null;
      }
    }
    return this.success(undefined);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    const idProblem = this.threadIdProblem(threadId);
    if (idProblem) return this.failure(idProblem);
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
    return this.reported(await this.dropThread(threadId), () => ({
      type: 'thread-deleted',
      threadId,
    }));
  }

  private async dropThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    return this.reported(await this.storeEntry(entry), (stored) => ({
      type: 'entry-added',
      entry: stored,
    }));
  }

  private async storeEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');
    const db = this.db;
    const { activate, parentId: askedParent, ...fields } = entry;
    const createdAt = this.entryTimestamp(entry);
    const id = this.generateId('entry');
    const type = fields.type ?? (fields.message?.role === 'tool' ? 'tool_result' : 'message');

    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const thread = db
          .prepare('SELECT active_leaf_id FROM threads WHERE id = ?')
          .get(entry.threadId) as { active_leaf_id: string | null } | undefined;
        if (!thread) {
          db.exec('ROLLBACK');
          return this.failure(`Thread not found: ${entry.threadId}`);
        }
        if (askedParent) {
          const parent = db
            .prepare('SELECT 1 FROM entries WHERE id = ? AND thread_id = ?')
            .get(askedParent, entry.threadId);
          if (!parent) {
            db.exec('ROLLBACK');
            return this.failure(`Parent entry ${askedParent} is not in thread ${entry.threadId}`);
          }
        }
        const parentId = askedParent === undefined ? thread.active_leaf_id : askedParent;
        const { seq } = db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM entries WHERE thread_id = ?')
          .get(entry.threadId) as { seq: number };
        db.prepare(
          `INSERT INTO entries (id, thread_id, message, tool_calls, tool_results, token_count,
             created_at, metadata, type, parent_id, event, format_version, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          entry.threadId,
          JSON.stringify(fields.message),
          fields.toolCalls ? JSON.stringify(fields.toolCalls) : null,
          fields.toolResults ? JSON.stringify(fields.toolResults) : null,
          fields.tokenCount,
          createdAt.toISOString(),
          fields.metadata ? JSON.stringify(fields.metadata) : null,
          type,
          parentId,
          fields.event ? JSON.stringify(fields.event) : null,
          MEMORY_ENTRY_FORMAT,
          seq
        );
        if (activate !== false) {
          db.prepare('UPDATE threads SET active_leaf_id = ? WHERE id = ?').run(id, entry.threadId);
        }
        db.exec('COMMIT');
        return this.success({
          ...fields,
          id,
          createdAt,
          type,
          parentId,
          seq,
          formatVersion: MEMORY_ENTRY_FORMAT,
        });
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
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
      const [types, typeParams] = typeCondition(options.types);
      conditions.push(types);
      params.push(...typeParams);

      let sql = `SELECT * FROM entries WHERE ${conditions.join(' AND ')}
                 ORDER BY created_at ASC, seq ASC`;
      if (options.limit) {
        sql = `SELECT * FROM (
          SELECT * FROM entries WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, seq DESC LIMIT ?
        ) ORDER BY created_at ASC, seq ASC`;
        params.push(options.limit);
      }

      const rows = this.db.prepare(sql).all(...params) as EntryRow[];
      return this.success(rows.map((row) => rowToEntry(row, options.includeToolCalls === true)));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * The path walked back from its start in one recursive query, which stops once it holds
   * `limit` entries of the asked types
   */
  override async getPath(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.db) return this.failure('Not connected');
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    const start = await this.pathStart(options);
    if (!start.success) return start;
    if (start.data === null) return this.success([]);

    try {
      const [wanted, wantedParams] = typeCondition(options.types, 'e.');
      const limit = options.limit || Number.MAX_SAFE_INTEGER;
      const rows = this.db
        .prepare(
          `WITH RECURSIVE path(id, parent_id, depth, kept) AS (
             SELECT e.id, e.parent_id, 0, CASE WHEN ${wanted} THEN 1 ELSE 0 END
             FROM entries e WHERE e.id = ? AND e.thread_id = ?
             UNION ALL
             SELECT e.id, e.parent_id, path.depth + 1,
                    path.kept + CASE WHEN ${wanted} THEN 1 ELSE 0 END
             FROM entries e JOIN path ON e.id = path.parent_id
             WHERE path.kept < ? AND e.thread_id = ? AND path.depth < ${MAX_PATH_DEPTH}
           )
           SELECT e.* FROM path JOIN entries e ON e.id = path.id
           WHERE ${wanted} ORDER BY path.depth DESC`
        )
        .all(
          ...wantedParams,
          start.data,
          options.threadId,
          ...wantedParams,
          limit,
          options.threadId,
          ...wantedParams
        ) as EntryRow[];
      const entries = rows.map((row) => rowToEntry(row, options.includeToolCalls === true));
      return this.success(options.limit ? entries.slice(-options.limit) : entries);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');
    try {
      const row = this.db
        .prepare(
          `UPDATE threads SET active_leaf_id = ? WHERE id = ?
             AND (? IS NULL OR EXISTS (SELECT 1 FROM entries WHERE id = ? AND thread_id = ?))
           RETURNING *`
        )
        .get(leafId, threadId, leafId, leafId, threadId) as ThreadRow | undefined;
      if (row) return this.success(this.rowToThread(row));
      const thread = this.db.prepare('SELECT 1 FROM threads WHERE id = ?').get(threadId);
      return this.failure(
        thread ? `Entry ${leafId} is not in thread ${threadId}` : `Thread not found: ${threadId}`
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as
        EntryRow | undefined;
      return this.success(row ? rowToEntry(row, true) : null);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.removeEntry(entryId), () => ({
      type: 'entry-deleted',
      entryId,
    }));
  }

  /** Deletes an entry and splices it out of its branch: its children go after its parent */
  private async removeEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    const db = this.db;

    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const entry = db
          .prepare('SELECT thread_id, parent_id FROM entries WHERE id = ?')
          .get(entryId) as { thread_id: string; parent_id: string | null } | undefined;
        if (entry) {
          db.prepare('UPDATE entries SET parent_id = ? WHERE parent_id = ? AND thread_id = ?').run(
            entry.parent_id,
            entryId,
            entry.thread_id
          );
          db.prepare(
            'UPDATE threads SET active_leaf_id = ? WHERE id = ? AND active_leaf_id = ?'
          ).run(entry.parent_id, entry.thread_id, entryId);
          db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
        }
        db.exec('COMMIT');
        return this.success(undefined);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.emptyThread(threadId), () => ({
      type: 'thread-cleared',
      threadId,
    }));
  }

  private async emptyThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const db = this.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM entries WHERE thread_id = ?').run(threadId);
        db.prepare('UPDATE threads SET active_leaf_id = NULL WHERE id = ?').run(threadId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
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
      ...(row.active_leaf_id && { activeLeafId: row.active_leaf_id }),
    };
  }

  async putItem(item: MemoryItem): Promise<MemoryResult<MemoryItem>> {
    return this.items ? this.items.putItem(item) : this.failure('Not connected');
  }

  async getItem(itemId: string): Promise<MemoryResult<MemoryItem | null>> {
    return this.items ? this.items.getItem(itemId) : this.failure('Not connected');
  }

  async findItems(filter: MemoryItemFilter): Promise<MemoryResult<MemoryItem[]>> {
    return this.items ? this.items.findItems(filter) : this.failure('Not connected');
  }

  async deleteItems(itemIds: string[]): Promise<MemoryResult<void>> {
    return this.items ? this.items.deleteItems(itemIds) : this.failure('Not connected');
  }

  async putEntity(entity: MemoryEntity): Promise<MemoryResult<MemoryEntity>> {
    return this.items ? this.items.putEntity(entity) : this.failure('Not connected');
  }

  async findEntities(filter: MemoryEntityFilter): Promise<MemoryResult<MemoryEntity[]>> {
    return this.items ? this.items.findEntities(filter) : this.failure('Not connected');
  }

  async deleteEntities(entityIds: string[]): Promise<MemoryResult<void>> {
    return this.items ? this.items.deleteEntities(entityIds) : this.failure('Not connected');
  }
}
