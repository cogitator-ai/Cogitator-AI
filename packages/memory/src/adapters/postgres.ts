/**
 * Postgres adapter for long-term memory
 *
 * Supports:
 * - Threads and entries (MemoryAdapter)
 * - Facts (FactAdapter)
 * - Embeddings with pgvector (EmbeddingAdapter)
 */

import type {
  ListThreadsOptions,
  Thread,
  ThreadPage,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  PostgresAdapterConfig,
  MemoryProvider,
  Fact,
  Embedding,
  SemanticSearchOptions,
  FactAdapter,
  EmbeddingAdapter,
  KeywordSearchAdapter,
  KeywordSearchOptions,
  SearchFilter,
  SearchResult,
  NewMemoryEntry,
  EmbeddingDeleteFilter,
  MemoryEntryType,
  PathQueryOptions,
} from '@cogitator-ai/types';
import { CONVERSATION_ENTRY_TYPES, MEMORY_ENTRY_FORMAT } from '@cogitator-ai/types';
import { BranchingMemoryAdapter } from './base';
import { attempt, ensureSchemaVersion, withSetupTransaction } from './schema-version';
import { EMPTY_DELETE_FILTER_ERROR, filterSourceTypes, hasDeleteCondition } from '../search/filter';
import {
  detectVectorSearchTuning,
  ensureHnswCosineIndex,
  hnswSearchSettings,
  MAX_HALFVEC_INDEX_DIMENSIONS,
  MAX_VECTOR_INDEX_DIMENSIONS,
  vectorColumnPlan,
  type SqlQueryable,
  type VectorColumnPlan,
  type VectorSearchTuning,
} from './pgvector';
import { threadListing, threadPage, type ThreadListing } from './thread-listing';

type PoolClient = SqlQueryable & {
  release(destroy?: boolean): void;
};

type Pool = SqlQueryable & {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

const DEFAULT_VECTOR_DIMENSIONS = 768;

/**
 * Whether a Postgres adapter can store and search embeddings, and why not. `tableExists` tells
 * that the `embeddings` table is there (with another vector size), so its rows can still be
 * deleted and searched by keyword.
 */
export type VectorStoreState =
  | { available: true; dimensions: number }
  | { available: false; reason: string; tableExists?: boolean };

/**
 * A thread's update time to the millisecond in UTC, the precision of `Thread.updatedAt` and of
 * `listThreads` cursors. Immutable, so it can be indexed.
 */
const THREAD_TIME = "date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC')";

/**
 * Layout of threads, entries and facts. 1: the tables with `entries.seq` and the listing
 * indexes. 2: entries form trees (`parent_id`, `type`, `event`, `format_version`) and threads
 * name their active leaf; entries written before are chained in the order they were added. A
 * schema from before versions were recorded is brought up to date in place.
 */
const MEMORY_SCHEMA_VERSION = 2;

/** An `embeddings` row as an embedding, its vector read from pgvector's text form when needed */
function rowToEmbedding(row: Record<string, unknown>): Embedding {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    sourceType: row.source_type as Embedding['sourceType'],
    vector:
      typeof row.vector === 'string'
        ? row.vector
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(Number)
        : (row.vector as number[]),
    content: row.content as string,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
  };
}

/** JSON text for a JSONB parameter. node-pg would send a JS array as a Postgres array literal. */
function toJsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export class PostgresAdapter
  extends BranchingMemoryAdapter
  implements FactAdapter, EmbeddingAdapter, KeywordSearchAdapter
{
  readonly provider: MemoryProvider = 'postgres';

  private pool: Pool | null = null;
  private config: PostgresAdapterConfig;
  private schema: string;
  private vectorDimensions = DEFAULT_VECTOR_DIMENSIONS;
  private dimensionsConfigured = false;
  private vectorTuning: VectorSearchTuning = { iterativeScan: false, halfvec: false };
  private vectorPlan: VectorColumnPlan = vectorColumnPlan('vector', 0, { halfvec: false });
  private vectorStore: VectorStoreState = { available: false, reason: 'Not connected' };

  constructor(config: PostgresAdapterConfig) {
    super();
    this.config = config;
    if (config.dimensions !== undefined) this.setVectorDimensions(config.dimensions);
    const schema = config.schema ?? 'cogitator';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      throw new Error(
        `Invalid schema name "${schema}": must be alphanumeric with underscores, starting with a letter or underscore`
      );
    }
    this.schema = schema;
  }

  async connect(): Promise<MemoryResult<void>> {
    if (this.pool) return this.success(undefined);

    let pg: typeof import('pg');
    try {
      pg = await import('pg');
    } catch {
      return this.failure('PostgresAdapter needs the "pg" package. Install it: pnpm add pg');
    }

    let pool: Pool | undefined;
    try {
      const { Pool } = pg.default ?? pg;

      pool = new Pool({
        connectionString: this.config.connectionString,
        max: this.config.poolSize ?? 10,
      }) as Pool;

      const client = await pool.connect();
      client.release();

      await this.initSchema(pool);

      this.pool = pool;
      if (!this.vectorStore.available) {
        console.warn(`PostgresAdapter: ${this.vectorStore.reason}`);
      }
      return this.success(undefined);
    } catch (error) {
      await pool?.end().catch(() => undefined);
      return this.failure(
        `Postgres connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Whether embeddings can be stored and searched: pgvector must be installed, and the
   * `embeddings` table must have the configured vector size. Threads, entries and facts work
   * either way.
   */
  vectorStatus(): VectorStoreState {
    return this.vectorStore;
  }

  /**
   * Sets the schema up in one transaction under a lock on the schema, so processes starting at
   * once take turns instead of racing on the same `CREATE`. Steps that may fail without failing
   * the setup (pgvector, the vector and keyword indexes) run in savepoints.
   */
  private async initSchema(pool: Pool): Promise<void> {
    this.vectorStore = await withSetupTransaction(pool, `${this.schema}.setup`, async (db) => {
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      const extensionError = await attempt(db, () =>
        db.query('CREATE EXTENSION IF NOT EXISTS vector')
      );
      await this.migrate(db);
      return this.prepareVectorStore(db, extensionError?.message);
    });
  }

  /** Adds the tree columns and chains the entries written before them in the order they were added */
  private async migrateToTrees(db: SqlQueryable): Promise<void> {
    const entries = `${this.schema}.entries`;
    await db.query(`
      ALTER TABLE ${entries}
        ADD COLUMN IF NOT EXISTS type TEXT,
        ADD COLUMN IF NOT EXISTS parent_id TEXT,
        ADD COLUMN IF NOT EXISTS event JSONB,
        ADD COLUMN IF NOT EXISTS format_version INTEGER
    `);
    await db.query(
      `ALTER TABLE ${this.schema}.threads ADD COLUMN IF NOT EXISTS active_leaf_id TEXT`
    );
    await db.query(`
      UPDATE ${entries} e SET parent_id = ordered.previous
      FROM (
        SELECT id, LAG(id) OVER (
          PARTITION BY thread_id ORDER BY created_at, seq NULLS FIRST, id
        ) AS previous FROM ${entries}
      ) ordered
      WHERE ordered.id = e.id AND e.format_version IS NULL AND e.parent_id IS NULL
    `);
    await db.query(`
      UPDATE ${this.schema}.threads t SET active_leaf_id = last.id
      FROM (
        SELECT DISTINCT ON (thread_id) thread_id, id FROM ${entries}
        ORDER BY thread_id, created_at DESC, seq DESC NULLS LAST, id DESC
      ) last
      WHERE last.thread_id = t.id AND t.active_leaf_id IS NULL
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_entries_parent ON ${entries}(thread_id, parent_id)`
    );
  }

  /** Brings threads, entries and facts to {@link MEMORY_SCHEMA_VERSION} */
  private async migrate(connection: SqlQueryable): Promise<void> {
    const tables = ['threads', 'entries', 'facts'].map((table) => `${this.schema}.${table}`);
    const present = async (db: SqlQueryable) => {
      const found = await db.query(
        'SELECT count(*)::int AS n FROM unnest($1::text[]) AS t(name) WHERE to_regclass(name) IS NOT NULL',
        [tables]
      );
      return found.rows[0]?.n === tables.length;
    };
    await ensureSchemaVersion(
      connection,
      this.schema,
      'memory',
      MEMORY_SCHEMA_VERSION,
      async (db) => {
        await db.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.threads (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

        await db.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.entries (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES ${this.schema}.threads(id) ON DELETE CASCADE,
          message JSONB NOT NULL,
          tool_calls JSONB,
          tool_results JSONB,
          token_count INTEGER NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

        await db.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.facts (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          content TEXT NOT NULL,
          category TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          source TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ
        )
      `);

        await db.query(`CREATE SEQUENCE IF NOT EXISTS ${this.schema}.entries_seq`);
        await db.query(`ALTER TABLE ${this.schema}.entries ADD COLUMN IF NOT EXISTS seq BIGINT`);
        await db.query(
          `ALTER TABLE ${this.schema}.entries ALTER COLUMN seq SET DEFAULT nextval('${this.schema}.entries_seq')`
        );

        await db.query(`
        CREATE INDEX IF NOT EXISTS idx_entries_thread_id
        ON ${this.schema}.entries(thread_id, created_at)
      `);
        await db.query(`
        CREATE INDEX IF NOT EXISTS idx_threads_agent_updated
        ON ${this.schema}.threads(agent_id, (${THREAD_TIME}), (id COLLATE "C"))
      `);
        await db.query(`
        CREATE INDEX IF NOT EXISTS idx_threads_updated
        ON ${this.schema}.threads((${THREAD_TIME}), (id COLLATE "C"))
      `);
        await db.query(`
        CREATE INDEX IF NOT EXISTS idx_threads_metadata
        ON ${this.schema}.threads USING GIN (metadata jsonb_path_ops)
      `);
        await db.query(`
        CREATE INDEX IF NOT EXISTS idx_facts_agent_id
        ON ${this.schema}.facts(agent_id, category)
      `);
        await this.migrateToTrees(db);
      },
      present
    );
  }

  /**
   * Creates the `embeddings` table, its HNSW index and its full-text column when pgvector is
   * available. An existing table keeps its vector size: an adapter without configured dimensions
   * adopts it, one configured for another size cannot store or search embeddings until the
   * table is migrated.
   */
  private async prepareVectorStore(
    pool: SqlQueryable,
    extensionError: string | undefined
  ): Promise<VectorStoreState> {
    const type = await pool.query("SELECT to_regtype('vector') IS NOT NULL AS available");
    if (type.rows[0]?.available !== true) {
      return {
        available: false,
        reason:
          'pgvector is not installed in this database' +
          (extensionError ? ` (CREATE EXTENSION vector failed: ${extensionError})` : '') +
          ', so embeddings cannot be stored or searched. Threads, entries and facts work. ' +
          'Install pgvector and run CREATE EXTENSION vector with a role allowed to.',
      };
    }

    const existing = await this.embeddingColumnDimensions(pool);
    if (existing === null) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.embeddings (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          vector vector(${this.vectorDimensions}),
          content TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    } else if (existing > 0 && existing !== this.vectorDimensions) {
      if (this.dimensionsConfigured) {
        return {
          available: false,
          tableExists: true,
          reason:
            `${this.schema}.embeddings stores vector(${existing}), but the adapter is set to ` +
            `${this.vectorDimensions} dimensions, so embeddings cannot be stored or searched. ` +
            'Use an embedding model with the same size, or another schema, or migrate the table ' +
            'and re-embed its rows.',
        };
      }
      this.vectorDimensions = existing;
    }

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_embeddings_source ON ${this.schema}.embeddings(source_id)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_embeddings_thread ON ${this.schema}.embeddings((metadata->>'threadId'))`
    );

    this.vectorTuning = await detectVectorSearchTuning(pool);
    this.vectorPlan = vectorColumnPlan('vector', this.vectorDimensions, this.vectorTuning);
    const indexError = await attempt(pool, async () => {
      this.vectorPlan = await ensureHnswCosineIndex(
        pool,
        {
          schema: this.schema,
          table: 'embeddings',
          column: 'vector',
          index: 'idx_embeddings_vector',
          dimensions: this.vectorDimensions,
        },
        this.vectorTuning
      );
    });
    if (indexError) console.warn('Failed to create the HNSW vector index:', indexError.message);
    if (!this.vectorPlan.opclass) {
      console.warn(
        `PostgresAdapter: ${this.vectorDimensions}-dimension embeddings have no vector index ` +
          `(pgvector indexes up to ${MAX_VECTOR_INDEX_DIMENSIONS}, or ` +
          `${MAX_HALFVEC_INDEX_DIMENSIONS} as halfvec from pgvector 0.7), so searches scan ` +
          'every row'
      );
    }

    const keywordError = await attempt(pool, async () => {
      await pool.query(`
        ALTER TABLE ${this.schema}.embeddings
        ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_tsv
        ON ${this.schema}.embeddings USING GIN (content_tsv)
      `);
    });
    if (keywordError) console.warn('Failed to create tsvector column/index:', keywordError.message);

    return { available: true, dimensions: this.vectorDimensions };
  }

  /**
   * The vector size of the existing `embeddings.vector` column: null without the table, 0 for a
   * column declared without a size.
   */
  private async embeddingColumnDimensions(pool: SqlQueryable): Promise<number | null> {
    const result = await pool.query(
      `SELECT a.atttypmod AS dimensions
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = lower($1) AND c.relname = 'embeddings'
         AND a.attname = 'vector' AND NOT a.attisdropped`,
      [this.schema]
    );
    const row = result.rows[0];
    if (!row) return null;
    const dimensions = Number(row.dimensions);
    return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 0;
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (!this.pool) return this.success(undefined);
    try {
      await this.pool.end();
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    } finally {
      this.pool = null;
      this.vectorStore = { available: false, reason: 'Not connected' };
    }
  }

  /** Why embeddings cannot be written or searched by vector, or null when they can. */
  private vectorUnavailable(): MemoryResult<never> | null {
    return this.vectorStore.available ? null : this.failure(this.vectorStore.reason);
  }

  /** Why the `embeddings` table cannot be read or cleaned up, or null when it can. */
  private embeddingTableUnavailable(): MemoryResult<never> | null {
    const state = this.vectorStore;
    return state.available || state.tableExists ? null : this.failure(state.reason);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    const idProblem = this.threadIdProblem(threadId);
    if (idProblem) return this.failure(idProblem);
    if (!this.pool) return this.failure('Not connected');

    const id = threadId ?? this.generateId('thread');
    const now = new Date();

    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.schema}.threads (id, agent_id, metadata, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $4)
         ON CONFLICT (id) DO UPDATE SET agent_id = $2, metadata = $3::jsonb, updated_at = $4
         RETURNING *`,
        [id, agentId, toJsonb(metadata), now]
      );

      const row = result.rows[0];
      if (!row) return this.failure(`Failed to create thread: ${id}`);
      return this.success(this.rowToThread(row));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.pool) return this.failure('Not connected');

    try {
      const result = await this.pool.query(`SELECT * FROM ${this.schema}.threads WHERE id = $1`, [
        threadId,
      ]);

      if (result.rows.length === 0) return this.success(null);
      return this.success(this.rowToThread(result.rows[0]));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>> {
    if (!this.pool) return this.failure('Not connected');
    const listing = threadListing(options);
    if (typeof listing === 'string') return this.failure(listing);

    const [where, params] = this.listingConditions(listing);
    const direction = listing.order === 'asc' ? 'ASC' : 'DESC';
    params.push(listing.limit + 1);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.schema}.threads
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${THREAD_TIME} ${direction}, id COLLATE "C" ${direction}
         LIMIT $${params.length}`,
        params
      );
      return this.success(
        threadPage(
          result.rows.map((row) => this.rowToThread(row)),
          listing
        )
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /** The WHERE conditions of `listing` with their parameters, numbered from `$1`. */
  private listingConditions(listing: ThreadListing): [string[], unknown[]] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (listing.agentId !== undefined) {
      params.push(listing.agentId);
      where.push(`agent_id = $${params.length}`);
    }
    if (listing.metadata.length > 0) {
      params.push(JSON.stringify(Object.fromEntries(listing.metadata)));
      where.push(`metadata @> $${params.length}::jsonb`);
    }
    if (listing.updatedAfter) {
      params.push(listing.updatedAfter.toISOString());
      where.push(`${THREAD_TIME} >= ($${params.length}::timestamptz AT TIME ZONE 'UTC')`);
    }
    if (listing.cursor) {
      const after = listing.order === 'asc' ? '>' : '<';
      params.push(new Date(listing.cursor.updatedAt).toISOString(), listing.cursor.id);
      where.push(
        `(${THREAD_TIME}, id COLLATE "C") ${after} ` +
          `($${params.length - 1}::timestamptz AT TIME ZONE 'UTC', $${params.length})`
      );
    }
    return [where, params];
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.pool) return this.failure('Not connected');

    try {
      const result = await this.pool.query(
        `UPDATE ${this.schema}.threads
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = $3
         WHERE id = $1
         RETURNING *`,
        [threadId, toJsonb(metadata), new Date()]
      );

      if (result.rows.length === 0) {
        return this.failure(`Thread not found: ${threadId}`);
      }

      return this.success(this.rowToThread(result.rows[0]));
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
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.threads WHERE id = $1`, [threadId]);
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
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('entry');
    const now = this.entryTimestamp(entry);
    const { activate, parentId: askedParent, ...fields } = entry;
    const type = fields.type ?? (fields.message?.role === 'tool' ? 'tool_result' : 'message');

    try {
      const stored = await this.inTransaction(async (client) => {
        const thread = await client.query(
          `SELECT active_leaf_id FROM ${this.schema}.threads WHERE id = $1 FOR UPDATE`,
          [entry.threadId]
        );
        if (thread.rows.length === 0) return `Thread not found: ${entry.threadId}`;
        if (askedParent) {
          const parent = await client.query(
            `SELECT 1 FROM ${this.schema}.entries WHERE id = $1 AND thread_id = $2`,
            [askedParent, entry.threadId]
          );
          if (parent.rows.length === 0) {
            return `Parent entry ${askedParent} is not in thread ${entry.threadId}`;
          }
        }
        const parentId =
          askedParent === undefined
            ? ((thread.rows[0]!.active_leaf_id as string | null) ?? null)
            : askedParent;
        const inserted = await client.query(
          `INSERT INTO ${this.schema}.entries
           (id, thread_id, message, tool_calls, tool_results, token_count, metadata, created_at,
            type, parent_id, event, format_version)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12)
           RETURNING seq`,
          [
            id,
            entry.threadId,
            toJsonb(fields.message),
            toJsonb(fields.toolCalls),
            toJsonb(fields.toolResults),
            fields.tokenCount,
            toJsonb(fields.metadata ?? {}),
            now,
            type,
            parentId,
            toJsonb(fields.event),
            MEMORY_ENTRY_FORMAT,
          ]
        );
        if (activate !== false) {
          await client.query(
            `UPDATE ${this.schema}.threads SET active_leaf_id = $1 WHERE id = $2`,
            [id, entry.threadId]
          );
        }
        return {
          ...fields,
          id,
          createdAt: now,
          type,
          parentId,
          seq: Number(inserted.rows[0]!.seq),
          formatVersion: MEMORY_ENTRY_FORMAT,
        } satisfies MemoryEntry;
      });
      return typeof stored === 'string' ? this.failure(stored) : this.success(stored);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * The path walked back from its start in one recursive query, which stops once it holds
   * `limit` entries of the asked types
   */
  override async getPath(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.pool) return this.failure('Not connected');
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    const start = await this.pathStart(options);
    if (!start.success) return start;
    if (start.data === null) return this.success([]);

    const types = options.types === 'all' ? null : [...(options.types ?? CONVERSATION_ENTRY_TYPES)];
    const wanted = (alias: string) =>
      `($3::text[] IS NULL OR COALESCE(${alias}.type, 'message') = ANY($3::text[]))`;
    try {
      const result = await this.pool.query(
        `WITH RECURSIVE path AS (
           SELECT e.*, 0 AS depth, CASE WHEN ${wanted('e')} THEN 1 ELSE 0 END AS kept
           FROM ${this.schema}.entries e WHERE e.id = $1 AND e.thread_id = $2
           UNION ALL
           SELECT e.*, path.depth + 1, path.kept + CASE WHEN ${wanted('e')} THEN 1 ELSE 0 END
           FROM ${this.schema}.entries e JOIN path ON e.id = path.parent_id
           WHERE path.kept < $4::bigint AND e.thread_id = $2
         )
         SELECT * FROM path WHERE ${wanted('path')} ORDER BY depth DESC`,
        [start.data, options.threadId, types, options.limit || Number.MAX_SAFE_INTEGER]
      );
      const entries = result.rows.map((row) =>
        this.rowToEntry(row, options.includeToolCalls ?? false)
      );
      return this.success(options.limit ? entries.slice(-options.limit) : entries);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      const result = await this.pool.query(
        `UPDATE ${this.schema}.threads SET active_leaf_id = $1 WHERE id = $2 RETURNING *`,
        [leafId, threadId]
      );
      const row = result.rows[0];
      return row
        ? this.success(this.rowToThread(row))
        : this.failure(`Thread not found: ${threadId}`);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.pool) return this.failure('Not connected');
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);

    let query = `SELECT * FROM ${this.schema}.entries WHERE thread_id = $1`;
    const params: unknown[] = [options.threadId];
    let paramIndex = 2;

    if (options.before) {
      query += ` AND created_at < $${paramIndex++}`;
      params.push(options.before);
    }
    if (options.after) {
      query += ` AND created_at > $${paramIndex++}`;
      params.push(options.after);
    }
    if (options.types !== 'all') {
      query += ` AND COALESCE(type, 'message') = ANY($${paramIndex++}::text[])`;
      params.push([...(options.types ?? CONVERSATION_ENTRY_TYPES)]);
    }

    if (options.limit) {
      query += ` ORDER BY created_at DESC, seq DESC NULLS LAST LIMIT $${paramIndex}`;
      params.push(options.limit);
      query = `SELECT * FROM (${query}) sub ORDER BY created_at ASC, seq ASC NULLS FIRST`;
    } else {
      query += ' ORDER BY created_at ASC, seq ASC NULLS FIRST';
    }

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(query, params);
    } catch (err) {
      return this.failure((err as Error).message);
    }

    return this.success(
      result.rows.map((row) => this.rowToEntry(row, options.includeToolCalls ?? false))
    );
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    if (!this.pool) return this.failure('Not connected');

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(`SELECT * FROM ${this.schema}.entries WHERE id = $1`, [
        entryId,
      ]);
    } catch (err) {
      return this.failure((err as Error).message);
    }

    if (result.rows.length === 0) return this.success(null);

    return this.success(this.rowToEntry(result.rows[0], true));
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.removeEntry(entryId), () => ({
      type: 'entry-deleted',
      entryId,
    }));
  }

  /** Deletes an entry and splices it out of its branch: its children go after its parent */
  private async removeEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    const entries = `${this.schema}.entries`;
    try {
      await this.inTransaction(async (client) => {
        const found = await client.query(
          `SELECT thread_id, parent_id FROM ${entries} WHERE id = $1 FOR UPDATE`,
          [entryId]
        );
        const entry = found.rows[0];
        if (!entry) return;
        await client.query(`SELECT 1 FROM ${this.schema}.threads WHERE id = $1 FOR UPDATE`, [
          entry.thread_id,
        ]);
        await client.query(
          `UPDATE ${entries} SET parent_id = $1 WHERE parent_id = $2 AND thread_id = $3`,
          [entry.parent_id, entryId, entry.thread_id]
        );
        await client.query(
          `UPDATE ${this.schema}.threads SET active_leaf_id = $1
           WHERE id = $2 AND active_leaf_id = $3`,
          [entry.parent_id, entry.thread_id, entryId]
        );
        await client.query(`DELETE FROM ${entries} WHERE id = $1`, [entryId]);
      });
      return this.success(undefined);
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
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.inTransaction(async (client) => {
        await client.query(`DELETE FROM ${this.schema}.entries WHERE thread_id = $1`, [threadId]);
        await client.query(
          `UPDATE ${this.schema}.threads SET active_leaf_id = NULL WHERE id = $1`,
          [threadId]
        );
      });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('fact');
    const now = new Date();

    try {
      await this.pool.query(
        `INSERT INTO ${this.schema}.facts
         (id, agent_id, content, category, confidence, source, metadata, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)`,
        [
          id,
          fact.agentId,
          fact.content,
          fact.category,
          fact.confidence,
          fact.source,
          toJsonb(fact.metadata ?? {}),
          fact.expiresAt ?? null,
          now,
        ]
      );

      return this.success({ ...fact, id, createdAt: now, updatedAt: now });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>> {
    if (!this.pool) return this.failure('Not connected');

    let query = `SELECT * FROM ${this.schema}.facts WHERE agent_id = $1`;
    const params: unknown[] = [agentId];

    if (category) {
      query += ' AND category = $2';
      params.push(category);
    }

    query += ' AND (expires_at IS NULL OR expires_at > NOW())';
    query += ' ORDER BY confidence DESC, updated_at DESC';

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(query, params);
    } catch (err) {
      return this.failure((err as Error).message);
    }

    return this.success(
      result.rows.map((row) => ({
        id: row.id as string,
        agentId: row.agent_id as string,
        content: row.content as string,
        category: row.category as string,
        confidence: row.confidence as number,
        source: row.source as Fact['source'],
        metadata: row.metadata as Record<string, unknown>,
        createdAt: new Date(row.created_at as string),
        updatedAt: new Date(row.updated_at as string),
        expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
      }))
    );
  }

  async updateFact(
    factId: string,
    updates: Partial<Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt'>>
  ): Promise<MemoryResult<Fact>> {
    if (!this.pool) return this.failure('Not connected');

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.content !== undefined) {
      setClauses.push(`content = $${paramIndex++}`);
      params.push(updates.content);
    }
    if (updates.category !== undefined) {
      setClauses.push(`category = $${paramIndex++}`);
      params.push(updates.category);
    }
    if (updates.confidence !== undefined) {
      setClauses.push(`confidence = $${paramIndex++}`);
      params.push(updates.confidence);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}::jsonb`);
      params.push(toJsonb(updates.metadata));
    }
    if (updates.expiresAt !== undefined) {
      setClauses.push(`expires_at = $${paramIndex++}`);
      params.push(updates.expiresAt);
    }

    params.push(factId);

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(
        `UPDATE ${this.schema}.facts SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }

    if (result.rows.length === 0) {
      return this.failure(`Fact not found: ${factId}`);
    }

    const row = result.rows[0];
    return this.success({
      id: row.id as string,
      agentId: row.agent_id as string,
      content: row.content as string,
      category: row.category as string,
      confidence: row.confidence as number,
      source: row.source as Fact['source'],
      metadata: row.metadata as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
    });
  }

  async deleteFact(factId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.facts WHERE id = $1`, [factId]);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async searchFacts(agentId: string, query: string): Promise<MemoryResult<Fact[]>> {
    if (!this.pool) return this.failure('Not connected');

    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.schema}.facts
         WHERE agent_id = $1 AND content ILIKE $2
         AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY confidence DESC`,
        [agentId, `%${query.replace(/[%_\\]/g, '\\$&')}%`]
      );

      return this.success(
        result.rows.map((row) => ({
          id: row.id as string,
          agentId: row.agent_id as string,
          content: row.content as string,
          category: row.category as string,
          confidence: row.confidence as number,
          source: row.source as Fact['source'],
          metadata: row.metadata as Record<string, unknown>,
          createdAt: new Date(row.created_at as string),
          updatedAt: new Date(row.updated_at as string),
          expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
        }))
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEmbedding(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.vectorUnavailable();
    if (unavailable) return unavailable;

    const id = this.generateId('emb');
    const now = new Date();

    const vectorStr = `[${embedding.vector.join(',')}]`;

    try {
      await this.pool.query(
        `INSERT INTO ${this.schema}.embeddings
         (id, source_id, source_type, vector, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          id,
          embedding.sourceId,
          embedding.sourceType,
          vectorStr,
          embedding.content,
          toJsonb(embedding.metadata ?? {}),
          now,
        ]
      );

      return this.success({ ...embedding, id, createdAt: now });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async replaceBySource(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.vectorUnavailable();
    if (unavailable) return unavailable;

    const id = this.generateId('emb');
    const now = new Date();
    try {
      await this.inTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `${this.schema}.embeddings:${embedding.sourceId}`,
        ]);
        await client.query(`DELETE FROM ${this.schema}.embeddings WHERE source_id = $1`, [
          embedding.sourceId,
        ]);
        await client.query(
          `INSERT INTO ${this.schema}.embeddings
           (id, source_id, source_type, vector, content, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            id,
            embedding.sourceId,
            embedding.sourceType,
            `[${embedding.vector.join(',')}]`,
            embedding.content,
            toJsonb(embedding.metadata ?? {}),
            now,
          ]
        );
      });
      return this.success({ ...embedding, id, createdAt: now });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async search(
    options: SemanticSearchOptions
  ): Promise<MemoryResult<(Embedding & { score: number })[]>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.vectorUnavailable();
    if (unavailable) return unavailable;

    if (!options.vector) {
      return this.failure(
        'search() requires vector. Use EmbeddingService to convert query to vector first.'
      );
    }

    const vectorStr = `[${options.vector.join(',')}]`;
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.7;

    const settings = hnswSearchSettings(limit, this.vectorTuning);
    const params: unknown[] = [vectorStr, threshold];
    const filter = this.embeddingFilterClause(options.filter, params, 3);
    params.push(settings.candidates, limit);
    const candidatesParam = filter.nextIndex;
    const limitParam = filter.nextIndex + 1;
    const distance = this.vectorPlan.distance('$1');
    const query = `
      SELECT * FROM (
        SELECT *, 1 - (${distance}) as score
        FROM ${this.schema}.embeddings
        WHERE 1 - (${distance}) >= $2${filter.sql}
        ORDER BY ${distance}
        LIMIT $${candidatesParam}
      ) nearest
      ORDER BY score DESC, id
      LIMIT $${limitParam}
    `;

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.inTransaction(async (client) => {
        await client.query(settings.sql, settings.params);
        return client.query(query, params);
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }

    return this.success(
      result.rows.map((row) => ({ ...rowToEmbedding(row), score: row.score as number }))
    );
  }

  async getBySources(sourceIds: string[]): Promise<MemoryResult<Embedding[]>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.embeddingTableUnavailable();
    if (unavailable) return unavailable;
    if (sourceIds.length === 0) return this.success([]);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.schema}.embeddings WHERE source_id = ANY($1::text[])`,
        [sourceIds]
      );
      return this.success(result.rows.map(rowToEmbedding));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.embeddingTableUnavailable();
    if (unavailable) return unavailable;
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.embeddings WHERE id = $1`, [embeddingId]);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteBySource(sourceId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.embeddingTableUnavailable();
    if (unavailable) return unavailable;
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.embeddings WHERE source_id = $1`, [
        sourceId,
      ]);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteByFilter(filter: EmbeddingDeleteFilter): Promise<MemoryResult<void>> {
    if (!hasDeleteCondition(filter)) return this.failure(EMPTY_DELETE_FILTER_ERROR);
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.embeddingTableUnavailable();
    if (unavailable) return unavailable;

    const params: unknown[] = [];
    const conditions = this.embeddingFilterClause(filter, params, 1);
    try {
      await this.pool.query(
        `DELETE FROM ${this.schema}.embeddings WHERE TRUE${conditions.sql}`,
        params
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async keywordSearch(options: KeywordSearchOptions): Promise<MemoryResult<SearchResult[]>> {
    if (!this.pool) return this.failure('Not connected');
    const unavailable = this.embeddingTableUnavailable();
    if (unavailable) return unavailable;

    const limit = options.limit ?? 10;
    const params: unknown[] = [options.query];
    let paramIndex = 2;

    const filter = this.embeddingFilterClause(options.filter, params, paramIndex);
    const filterClause = filter.sql;
    paramIndex = filter.nextIndex;

    const limitParam = `$${paramIndex}`;
    params.push(limit);

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(
        `SELECT id, source_id, source_type, content, metadata, created_at,
              ts_rank(content_tsv, plainto_tsquery('english', $1)) as keyword_score
       FROM ${this.schema}.embeddings
       WHERE content_tsv @@ plainto_tsquery('english', $1)${filterClause}
       ORDER BY keyword_score DESC
       LIMIT ${limitParam}`,
        params
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }

    return this.success(
      result.rows.map((row) => ({
        id: row.id as string,
        sourceId: row.source_id as string,
        sourceType: row.source_type as Embedding['sourceType'],
        content: row.content as string,
        score: row.keyword_score as number,
        keywordScore: row.keyword_score as number,
        metadata: row.metadata as Record<string, unknown>,
      }))
    );
  }

  /**
   * SQL conditions for a search filter; agent and thread scoping use `metadata.agentId` /
   * `metadata.threadId`, a user filter also lets through embeddings of no user, and `metadata`
   * conditions are matched by JSONB containment.
   */
  private embeddingFilterClause(
    filter: SearchFilter | undefined,
    params: unknown[],
    startIndex: number
  ): { sql: string; nextIndex: number } {
    let sql = '';
    let index = startIndex;
    const types = filterSourceTypes(filter);
    if (types) {
      sql += ` AND source_type = ANY($${index++}::text[])`;
      params.push(types);
    }
    if (filter?.agentId) {
      sql += ` AND metadata->>'agentId' = $${index++}`;
      params.push(filter.agentId);
    }
    if (filter?.threadId) {
      sql += ` AND metadata->>'threadId' = $${index++}`;
      params.push(filter.threadId);
    }
    if (filter?.userId) {
      sql += ` AND (metadata->>'userId' = $${index++} OR metadata->>'userId' IS NULL)`;
      params.push(filter.userId);
    }
    if (filter?.metadata && Object.keys(filter.metadata).length > 0) {
      sql += ` AND metadata @> $${index++}::jsonb`;
      params.push(toJsonb(filter.metadata));
    }
    return { sql, nextIndex: index };
  }

  /** Runs `work` on one pooled connection inside a transaction, so `SET LOCAL` style settings apply to it only. */
  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Not connected');
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /** An entry row as a `MemoryEntry`, with columns that hold NULL left out. */
  private rowToEntry(row: Record<string, unknown>, withToolCalls: boolean): MemoryEntry {
    const toolCalls = row.tool_calls as MemoryEntry['toolCalls'] | null;
    const toolResults = row.tool_results as MemoryEntry['toolResults'] | null;
    const metadata = row.metadata as Record<string, unknown> | null;
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      message: row.message as MemoryEntry['message'],
      ...(withToolCalls && toolCalls != null && { toolCalls }),
      ...(withToolCalls && toolResults != null && { toolResults }),
      tokenCount: row.token_count as number,
      ...(metadata != null && { metadata }),
      createdAt: new Date(row.created_at as string),
      type: ((row.type as string | null) ?? 'message') as MemoryEntryType,
      parentId: (row.parent_id as string | null) ?? null,
      ...(row.seq != null && { seq: Number(row.seq) }),
      ...(row.event != null && { event: row.event as Record<string, unknown> }),
      formatVersion: (row.format_version as number | null) ?? 1,
    };
  }

  private rowToThread(row: Record<string, unknown>): Thread {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      ...(row.active_leaf_id != null && { activeLeafId: row.active_leaf_id as string }),
    };
  }

  /**
   * The vector size of the embedding model, before `connect()`. The `embeddings` table is
   * created with it, and an existing table of another size is reported by `vectorStatus()`
   * instead of failing each search. Same as `dimensions` in the config.
   */
  setVectorDimensions(dimensions: number): void {
    if (this.pool) {
      throw new Error('Cannot change vector dimensions after connecting');
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error(`Invalid vector dimensions: ${dimensions}. Must be a positive integer`);
    }
    this.vectorDimensions = dimensions;
    this.dimensionsConfigured = true;
  }
}
