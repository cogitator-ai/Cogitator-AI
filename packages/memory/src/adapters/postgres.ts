/**
 * Postgres adapter for long-term memory
 *
 * Supports:
 * - Threads and entries (MemoryAdapter)
 * - Memory items and their entity index (MemoryItemAdapter)
 * - Facts over memory items (FactAdapter)
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
  MemoryEntity,
  MemoryEntityFilter,
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemFilter,
  MemoryItemTrust,
  MemoryFileAdapter,
  MemoryFileFilter,
  MemoryFileVersion,
  EntryRedaction,
  MemoryFileHeadFilter,
} from '@cogitator-ai/types';
import {
  CONVERSATION_ENTRY_TYPES,
  MEMORY_ENTRY_FORMAT,
  MEMORY_FILE_CONFLICT,
} from '@cogitator-ai/types';
import { BranchingMemoryAdapter, MAX_PATH_DEPTH } from './base';
import {
  memoryEntityFromJson,
  memoryItemFromJson,
  type StoredMemoryEntity,
  type StoredMemoryItem,
  memoryFileVersionFromJson,
  type StoredMemoryFileVersion,
} from './memory-item-json';
import { entityNames, MemoryItems, normalizeName } from '../memory-items';
import { fileKeyOf, matchesFileFilter } from '../memory-files';
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

type Pool = Omit<SqlQueryable, 'query'> & {
  query(
    queryTextOrConfig: string | { text: string; query_timeout?: number },
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
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
 * Layout of threads, entries and memory items. 1: the tables with `entries.seq` and the listing
 * indexes. 2: entries form trees (`parent_id`, `type`, `event`, `format_version`) and threads
 * name their active leaf, entries written before are chained in the order they were added. 3:
 * memory items and their entity index, every row of `facts` becomes an item of the fact's own
 * slot with the fact's id, and the old table is kept as `facts_legacy`. 4: memory file versions
 * (`memory_file_versions`), a new table and nothing moved. A schema from before versions were
 * recorded is brought up to date in place.
 */
const MEMORY_SCHEMA_VERSION = 4;

/** The columns of a memory item's scope, beside the scope field each holds */
const SCOPE_COLUMNS = [
  ['user_id', 'userId'],
  ['project_id', 'projectId'],
  ['thread_id', 'threadId'],
] as const;

/** The slot of a fact written through {@link FactAdapter}: `fact:<id of its first item>` */
const FACT_SLOT_PREFIX = 'fact:';

const factSlot = (factId: string) => `${FACT_SLOT_PREFIX}${factId}`;

/** An ISO 8601 text of a timestamp in UTC to the millisecond, as `JSON.stringify` writes a date */
const isoText = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The trust of a memory item that holds a fact of `source` */
function trustOfSource(source: Fact['source']): MemoryItemTrust {
  switch (source) {
    case 'user':
      return 'user';
    case 'system':
      return 'system';
    default:
      return 'model';
  }
}

function sourceOfTrust(trust: MemoryItemTrust): Fact['source'] {
  return trust === 'user' || trust === 'system' ? trust : 'inferred';
}

/** The scope of a fact's items: its agent, narrowed to the user its metadata names */
function factScope(agentId: string, metadata: Record<string, unknown> | undefined) {
  const userId = metadata?.userId;
  return { agentId, ...(typeof userId === 'string' && { userId }) };
}

/** The metadata of a fact's item: the fact's own, with its category */
function factItemMetadata(
  category: string,
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  return { ...metadata, category };
}

/** The fact of `factId` whose current item is `item` and whose first item was recorded `createdAt` */
function itemToFact(factId: string, item: MemoryItem, createdAt: Date): Fact {
  const { category, ...metadata } = item.metadata ?? {};
  return {
    id: factId,
    agentId: item.scope.agentId,
    content: item.content,
    category: item.attribute ?? (typeof category === 'string' ? category : ''),
    confidence: item.confidence,
    source: sourceOfTrust(item.trust),
    metadata,
    createdAt,
    updatedAt: item.recordedAt,
    ...(item.expiredAt && { expiresAt: item.expiredAt }),
    ...(item.evidence.length > 0 && { evidence: item.evidence }),
  };
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

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
  implements
    MemoryItemAdapter,
    MemoryFileAdapter,
    FactAdapter,
    EmbeddingAdapter,
    KeywordSearchAdapter
{
  readonly provider: MemoryProvider = 'postgres';

  /** The rules of memory items over this adapter's storage, which facts are written through */
  private readonly memoryItems = new MemoryItems({ adapter: this });

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
      UPDATE ${entries} e SET parent_id = ordered.previous, format_version = 1
      FROM (
        SELECT id, LAG(id) OVER (
          PARTITION BY thread_id ORDER BY created_at, seq NULLS FIRST, id
        ) AS previous FROM ${entries}
      ) ordered
      WHERE ordered.id = e.id AND e.format_version IS NULL
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

  /**
   * Creates `memory_items` and `memory_entities`: a column for each field items and entities are
   * found by, and the whole of each in JSONB
   */
  private async createMemoryItemTables(db: SqlQueryable): Promise<void> {
    const items = `${this.schema}.memory_items`;
    const entities = `${this.schema}.memory_entities`;
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${items} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        slot TEXT,
        entity_id TEXT,
        user_id TEXT,
        project_id TEXT,
        thread_id TEXT,
        recorded_at TIMESTAMPTZ NOT NULL,
        expired_at TIMESTAMPTZ,
        item JSONB NOT NULL
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_memory_items_slot ON ${items}(agent_id, slot)`);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_items_user ON ${items}(agent_id, user_id)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_items_entity ON ${items}(agent_id, entity_id)`
    );
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_items_recorded
      ON ${items}(agent_id, recorded_at, (id COLLATE "C"))
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${entities} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        names TEXT[] NOT NULL,
        entity JSONB NOT NULL
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_entities_agent ON ${entities}(agent_id, (id COLLATE "C"))`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_entities_names ON ${entities} USING GIN (names)`
    );
  }

  /**
   * The table of memory file versions: each version whole as JSON, beside the columns its filters
   * read, and no two versions of one scope and path (`file_key`) in one `sequence`
   */
  private async createMemoryFileTable(db: SqlQueryable): Promise<void> {
    const files = `${this.schema}.memory_file_versions`;
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${files} (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        project_id TEXT,
        thread_id TEXT,
        file_key TEXT NOT NULL,
        path TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        version JSONB NOT NULL,
        UNIQUE (file_key, sequence)
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_file_versions_agent ON ${files}(agent_id, (path COLLATE "C"), created_at)`
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_file_versions_user ON ${files}(agent_id, user_id)`
    );
  }

  /**
   * Moves every row of `facts` into a memory item of kind `fact` with the fact's id, alone in
   * its slot `fact:<id>`: active, trusted as its source, in the scope of its agent and of the
   * user its metadata names, verified when it has evidence, said, recorded and valid from when
   * the fact was created, and let go when the fact expires. Then `facts` becomes `facts_legacy`.
   * Rows moved before are left as they are, so the move can run again.
   */
  private async migrateFactsToItems(db: SqlQueryable): Promise<void> {
    const facts = `${this.schema}.facts`;
    const legacy = `${this.schema}.facts_legacy`;
    const found = await db.query(
      'SELECT to_regclass($1) IS NOT NULL AS facts, to_regclass($2) IS NOT NULL AS legacy',
      [facts, legacy]
    );
    if (found.rows[0]?.facts !== true) return;

    await db.query(`ALTER TABLE ${facts} ADD COLUMN IF NOT EXISTS evidence JSONB`);
    await db.query(`
      INSERT INTO ${this.schema}.memory_items
        (id, agent_id, kind, status, slot, entity_id, user_id, recorded_at, expired_at, item)
      SELECT f.id, f.agent_id, 'fact', 'active', f.slot, NULL, f.user_id, f.at, f.expires_at,
        jsonb_build_object(
          'id', f.id,
          'kind', 'fact',
          'content', f.content,
          'attribute', f.category,
          'slot', f.slot,
          'status', 'active',
          'trust', CASE f.source WHEN 'user' THEN 'user' WHEN 'system' THEN 'system' ELSE 'model' END,
          'confidence', COALESCE(f.confidence, 1),
          'scope', jsonb_build_object('agentId', f.agent_id) || CASE
            WHEN f.user_id IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('userId', f.user_id) END,
          'evidence', f.evidence,
          'verified', jsonb_array_length(f.evidence) > 0,
          'saidAt', f.at_text,
          'sessionAt', f.at_text,
          'validFrom', f.at_text,
          'recordedAt', f.at_text,
          'metadata', f.metadata || jsonb_build_object('category', f.category)
        ) || CASE WHEN f.expires_at IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('expiredAt', ${isoText('f.expires_at')}) END
      FROM (
        SELECT id, agent_id, content, category, confidence, source, expires_at,
          '${FACT_SLOT_PREFIX}' || id AS slot,
          date_trunc('milliseconds', COALESCE(created_at, updated_at, NOW())) AS at,
          ${isoText('COALESCE(created_at, updated_at, NOW())')} AS at_text,
          CASE WHEN jsonb_typeof(evidence) = 'array' THEN evidence ELSE '[]'::jsonb END
            AS evidence,
          CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
            AS metadata,
          CASE WHEN jsonb_typeof(metadata -> 'userId') = 'string' THEN metadata ->> 'userId' END
            AS user_id
        FROM ${facts}
      ) f
      ON CONFLICT (id) DO NOTHING
    `);

    if (found.rows[0]?.legacy !== true) {
      await db.query(`ALTER TABLE ${facts} RENAME TO facts_legacy`);
      await db.query(
        `ALTER INDEX IF EXISTS ${this.schema}.idx_facts_agent_id RENAME TO idx_facts_legacy_agent_id`
      );
      return;
    }
    await db.query(`ALTER TABLE ${legacy} ADD COLUMN IF NOT EXISTS evidence JSONB`);
    const columns =
      'id, agent_id, content, category, confidence, source, metadata, created_at, updated_at, ' +
      'expires_at, evidence';
    await db.query(`
      INSERT INTO ${legacy} (${columns}) SELECT ${columns} FROM ${facts}
      ON CONFLICT (id) DO NOTHING
    `);
    await db.query(`DROP TABLE ${facts}`);
  }

  /** Brings threads, entries, memory items and memory files to {@link MEMORY_SCHEMA_VERSION} */
  private async migrate(connection: SqlQueryable): Promise<void> {
    const tables = [
      'threads',
      'entries',
      'memory_items',
      'memory_entities',
      'memory_file_versions',
    ].map((table) => `${this.schema}.${table}`);
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
        await this.migrateToTrees(db);
        await this.createMemoryItemTables(db);
        await this.createMemoryFileTable(db);
        await this.migrateFactsToItems(db);
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

  async healthCheck(): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.pool.query({ text: 'SELECT 1', query_timeout: 3000 });
      return this.success(undefined);
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
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
           WHERE path.kept < $4::bigint AND e.thread_id = $2 AND path.depth < ${MAX_PATH_DEPTH}
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
      const outcome = await this.inTransaction(async (client) => {
        const thread = await client.query(
          `SELECT 1 FROM ${this.schema}.threads WHERE id = $1 FOR UPDATE`,
          [threadId]
        );
        if (thread.rows.length === 0) return `Thread not found: ${threadId}`;
        if (leafId !== null) {
          const entry = await client.query(
            `SELECT 1 FROM ${this.schema}.entries WHERE id = $1 AND thread_id = $2`,
            [leafId, threadId]
          );
          if (entry.rows.length === 0) return `Entry ${leafId} is not in thread ${threadId}`;
        }
        const updated = await client.query(
          `UPDATE ${this.schema}.threads SET active_leaf_id = $1 WHERE id = $2 RETURNING *`,
          [leafId, threadId]
        );
        return this.rowToThread(updated.rows[0]);
      });
      return typeof outcome === 'string' ? this.failure(outcome) : this.success(outcome);
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

  async redactEntry(
    entryId: string,
    redaction: EntryRedaction
  ): Promise<MemoryResult<MemoryEntry | null>> {
    return this.redactThrough(entryId, redaction, async (entry) => {
      if (!this.pool) return this.failure('Not connected');
      try {
        await this.pool.query(
          `UPDATE ${this.schema}.entries SET message = $1::jsonb, tool_calls = $2::jsonb,
             tool_results = $3::jsonb, token_count = $4, metadata = $5::jsonb WHERE id = $6`,
          [
            toJsonb(entry.message),
            toJsonb(entry.toolCalls),
            toJsonb(entry.toolResults),
            entry.tokenCount,
            toJsonb(entry.metadata ?? {}),
            entry.id,
          ]
        );
        return this.success(undefined);
      } catch (err) {
        return this.failure((err as Error).message);
      }
    });
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
        const owner = await client.query(`SELECT thread_id FROM ${entries} WHERE id = $1`, [
          entryId,
        ]);
        if (!owner.rows[0]) return;
        await client.query(`SELECT 1 FROM ${this.schema}.threads WHERE id = $1 FOR UPDATE`, [
          owner.rows[0].thread_id,
        ]);
        const found = await client.query(
          `SELECT thread_id, parent_id FROM ${entries} WHERE id = $1 FOR UPDATE`,
          [entryId]
        );
        const entry = found.rows[0];
        if (!entry) return;
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
        await client.query(`SELECT 1 FROM ${this.schema}.threads WHERE id = $1 FOR UPDATE`, [
          threadId,
        ]);
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

  async putItem(item: MemoryItem): Promise<MemoryResult<MemoryItem>> {
    if (!this.pool) return this.failure('Not connected');
    const json = JSON.stringify(item);
    try {
      await this.pool.query(
        `INSERT INTO ${this.schema}.memory_items
         (id, agent_id, kind, status, slot, entity_id, user_id, project_id, thread_id,
          recorded_at, expired_at, item)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id, kind = EXCLUDED.kind, status = EXCLUDED.status,
           slot = EXCLUDED.slot, entity_id = EXCLUDED.entity_id, user_id = EXCLUDED.user_id,
           project_id = EXCLUDED.project_id, thread_id = EXCLUDED.thread_id,
           recorded_at = EXCLUDED.recorded_at, expired_at = EXCLUDED.expired_at,
           item = EXCLUDED.item`,
        [
          item.id,
          item.scope.agentId,
          item.kind,
          item.status,
          item.slot ?? null,
          item.entityId ?? null,
          item.scope.userId ?? null,
          item.scope.projectId ?? null,
          item.scope.threadId ?? null,
          item.recordedAt,
          item.expiredAt ?? null,
          json,
        ]
      );
      return this.success(memoryItemFromJson(JSON.parse(json) as StoredMemoryItem));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getItem(itemId: string): Promise<MemoryResult<MemoryItem | null>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      const result = await this.pool.query(
        `SELECT item FROM ${this.schema}.memory_items WHERE id = $1`,
        [itemId]
      );
      const row = result.rows[0];
      return this.success(row ? memoryItemFromJson(row.item as StoredMemoryItem) : null);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async findItems(filter: MemoryItemFilter): Promise<MemoryResult<MemoryItem[]>> {
    if (!this.pool) return this.failure('Not connected');
    const params: unknown[] = [filter.agentId];
    const conditions = ['agent_id = $1'];
    const anyOf = (column: string, values: readonly string[] | undefined) => {
      if (values === undefined) return;
      params.push(values);
      conditions.push(`${column} = ANY($${params.length}::text[])`);
    };
    anyOf('id', filter.ids);
    anyOf('slot', filter.slots);
    anyOf('entity_id', filter.entityIds);
    anyOf('kind', filter.kinds);
    anyOf('status', filter.statuses);
    const param = (value: string) => {
      params.push(value);
      return `$${params.length}`;
    };
    for (const [column, field] of SCOPE_COLUMNS) {
      const visible = filter.visibleTo?.[field];
      if (filter.visibleTo !== undefined) {
        conditions.push(
          visible === undefined
            ? `${column} IS NULL`
            : `(${column} IS NULL OR ${column} = ${param(visible)})`
        );
      }
      const exact = filter.scope?.[field];
      if (filter.scope !== undefined) {
        conditions.push(exact === undefined ? `${column} IS NULL` : `${column} = ${param(exact)}`);
      }
    }
    if (filter.includeExpired !== true)
      conditions.push('(expired_at IS NULL OR expired_at > NOW())');

    try {
      const result = await this.pool.query(
        `SELECT item FROM ${this.schema}.memory_items WHERE ${conditions.join(' AND ')}
         ORDER BY recorded_at, id COLLATE "C"`,
        params
      );
      return this.success(
        result.rows.map((row) => memoryItemFromJson(row.item as StoredMemoryItem))
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteItems(itemIds: string[]): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    if (itemIds.length === 0) return this.success(undefined);
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.memory_items WHERE id = ANY($1::text[])`, [
        itemIds,
      ]);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async countRetrieved(itemIds: string[], at: Date): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    if (itemIds.length === 0) return this.success(undefined);
    try {
      await this.pool.query(
        `UPDATE ${this.schema}.memory_items
         SET item = item || jsonb_build_object(
           'timesRetrieved', COALESCE((item->>'timesRetrieved')::int, 0) + 1,
           'lastRetrievedAt', $2::text
         )
         WHERE id = ANY($1::text[])`,
        [[...new Set(itemIds)], at.toISOString()]
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async putFileVersions(versions: MemoryFileVersion[]): Promise<MemoryResult<MemoryFileVersion[]>> {
    const pool = this.pool;
    if (!pool) return this.failure('Not connected');
    if (versions.length === 0) return this.success([]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const version of versions) {
        await client.query(
          `INSERT INTO ${this.schema}.memory_file_versions
           (id, agent_id, user_id, project_id, thread_id, file_key, path, sequence, created_at,
            version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            version.id,
            version.scope.agentId,
            version.scope.userId ?? null,
            version.scope.projectId ?? null,
            version.scope.threadId ?? null,
            fileKeyOf(version.scope, version.path),
            version.path,
            version.sequence,
            version.createdAt,
            JSON.stringify(version),
          ]
        );
      }
      await client.query('COMMIT');
      return this.success(
        versions.map((version) =>
          memoryFileVersionFromJson(JSON.parse(JSON.stringify(version)) as StoredMemoryFileVersion)
        )
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return (err as { code?: string }).code === '23505'
        ? this.failure(MEMORY_FILE_CONFLICT)
        : this.failure((err as Error).message);
    } finally {
      client.release();
    }
  }

  /** The conditions of `filter` on the memory file versions table, with their parameters */
  private fileConditions(filter: MemoryFileFilter): {
    conditions: string[];
    params: unknown[];
  } {
    const conditions = ['agent_id = $1'];
    const params: unknown[] = [filter.agentId];
    if (filter.ids) {
      params.push(filter.ids);
      conditions.push(`id = ANY($${params.length}::text[])`);
    }
    if (filter.paths) {
      params.push(filter.paths);
      conditions.push(`path = ANY($${params.length}::text[])`);
    }
    if (filter.prefix !== undefined) {
      params.push([...filter.prefix].length, filter.prefix);
      conditions.push(`left(path, $${params.length - 1}) = $${params.length}`);
    }
    const visibleTo = filter.visibleTo;
    if (visibleTo) {
      for (const [column, value] of [
        ['user_id', visibleTo.userId],
        ['project_id', visibleTo.projectId],
        ['thread_id', visibleTo.threadId],
      ] as const) {
        if (value === undefined) {
          conditions.push(`${column} IS NULL`);
        } else {
          params.push(value);
          conditions.push(`(${column} IS NULL OR ${column} = $${params.length})`);
        }
      }
    }
    return { conditions, params };
  }

  async findFileVersions(filter: MemoryFileFilter): Promise<MemoryResult<MemoryFileVersion[]>> {
    if (!this.pool) return this.failure('Not connected');
    const { conditions, params } = this.fileConditions(filter);
    try {
      const found = await this.pool.query(
        `SELECT version FROM ${this.schema}.memory_file_versions
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at, sequence, (id COLLATE "C")`,
        params
      );
      return this.success(
        found.rows
          .map((row) => memoryFileVersionFromJson(row.version as StoredMemoryFileVersion))
          .filter((version) => matchesFileFilter(version, filter))
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }
  async findFileHeads(filter: MemoryFileHeadFilter): Promise<MemoryResult<MemoryFileVersion[]>> {
    if (!this.pool) return this.failure('Not connected');
    const { place, ...rest } = filter;
    const { conditions, params } = this.fileConditions(rest);
    if (place) {
      params.push(place.threadId, [...place.pathIds]);
      conditions.push(
        `(version->'place' IS NULL OR jsonb_typeof(version->'place') = 'null' OR version->'place'->>'threadId' <> $${params.length - 1} OR version->'place'->>'entryId' = ANY($${params.length}::text[]))`
      );
    }
    try {
      const found = await this.pool.query(
        `SELECT version FROM (
           SELECT DISTINCT ON (file_key) version, created_at, sequence, id
           FROM ${this.schema}.memory_file_versions
           WHERE ${conditions.join(' AND ')} AND NOT (version ? 'withdrawn')
           ORDER BY file_key, sequence DESC
         ) heads
         ORDER BY created_at, sequence, (id COLLATE "C")`,
        params
      );
      return this.success(
        found.rows
          .map((row) => memoryFileVersionFromJson(row.version as StoredMemoryFileVersion))
          .filter((version) => matchesFileFilter(version, rest))
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async withdrawFileVersions(ids: string[], at: Date): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    if (ids.length === 0) return this.success(undefined);
    try {
      await this.pool.query(
        `UPDATE ${this.schema}.memory_file_versions
         SET version = version || jsonb_build_object('withdrawn', jsonb_build_object('at', $2::text))
         WHERE id = ANY($1::text[])`,
        [[...new Set(ids)], at.toISOString()]
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async redactFileVersions(
    ids: string[],
    redaction: { content: string; sha256: string; at: Date; reason?: string }
  ): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    if (ids.length === 0) return this.success(undefined);
    try {
      await this.pool.query(
        `UPDATE ${this.schema}.memory_file_versions
         SET version = version || jsonb_build_object(
           'content', $2::text,
           'sha256', $3::text,
           'redacted', $4::jsonb
         )
         WHERE id = ANY($1::text[])`,
        [
          [...new Set(ids)],
          redaction.content,
          redaction.sha256,
          JSON.stringify({
            at: redaction.at,
            ...(redaction.reason !== undefined && { reason: redaction.reason }),
          }),
        ]
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteFileVersions(ids: string[]): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    if (ids.length === 0) return this.success(undefined);
    try {
      await this.pool.query(
        `DELETE FROM ${this.schema}.memory_file_versions WHERE id = ANY($1::text[])`,
        [ids]
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async putEntity(entity: MemoryEntity): Promise<MemoryResult<MemoryEntity>> {
    if (!this.pool) return this.failure('Not connected');
    const json = JSON.stringify(entity);
    try {
      await this.pool.query(
        `INSERT INTO ${this.schema}.memory_entities (id, agent_id, names, entity)
         VALUES ($1, $2, $3::text[], $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id, names = EXCLUDED.names, entity = EXCLUDED.entity`,
        [entity.id, entity.scope.agentId, entityNames(entity), json]
      );
      return this.success(memoryEntityFromJson(JSON.parse(json) as StoredMemoryEntity));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async findEntities(filter: MemoryEntityFilter): Promise<MemoryResult<MemoryEntity[]>> {
    if (!this.pool) return this.failure('Not connected');
    const params: unknown[] = [filter.agentId];
    const conditions = ['agent_id = $1'];
    if (filter.ids !== undefined) {
      params.push(filter.ids);
      conditions.push(`id = ANY($${params.length}::text[])`);
    }
    if (filter.names !== undefined) {
      params.push(filter.names);
      conditions.push(`names && $${params.length}::text[]`);
    }

    try {
      const result = await this.pool.query(
        `SELECT entity FROM ${this.schema}.memory_entities WHERE ${conditions.join(' AND ')}
         ORDER BY id COLLATE "C"`,
        params
      );
      return this.success(
        result.rows.map((row) => memoryEntityFromJson(row.entity as StoredMemoryEntity))
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEntities(entityIds: string[]): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    if (entityIds.length === 0) return this.success(undefined);
    try {
      await this.pool.query(
        `DELETE FROM ${this.schema}.memory_entities WHERE id = ANY($1::text[])`,
        [entityIds]
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Writes the fact as the first memory item of its own slot `fact:<id>`, the item's id being
   * the fact's. It is `active` whatever its source, as facts have always been found once added,
   * and verified when it comes with evidence.
   */
  async addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('fact');
    const now = new Date();
    const evidence = fact.evidence ?? [];
    const written = await this.putItem({
      id,
      kind: 'fact',
      content: fact.content,
      attribute: fact.category,
      slot: factSlot(id),
      status: 'active',
      trust: trustOfSource(fact.source),
      confidence: fact.confidence,
      scope: factScope(fact.agentId, fact.metadata),
      evidence,
      verified: evidence.length > 0,
      saidAt: now,
      sessionAt: now,
      validFrom: now,
      recordedAt: now,
      ...(fact.expiresAt && { expiredAt: fact.expiresAt }),
      metadata: factItemMetadata(fact.category, fact.metadata),
    });
    if (!written.success) return written;
    return this.success({ ...fact, id, createdAt: now, updatedAt: now });
  }

  /** The current facts of the agent, without those past `expiresAt` */
  async getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>> {
    return this.currentFacts(
      agentId,
      category === undefined
        ? undefined
        : { sql: "latest.item->>'attribute' = $2", value: category }
    );
  }

  /**
   * Changes a fact. A new statement is written as a new item of the fact's slot that supersedes
   * the current one, so what the fact said before stays in its history. A change that keeps the
   * statement (its confidence, category, metadata, evidence or expiry) corrects the current item.
   */
  async updateFact(
    factId: string,
    updates: Partial<
      Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt' | 'evidence'>
    >
  ): Promise<MemoryResult<Fact>> {
    if (!this.pool) return this.failure('Not connected');

    try {
      const slot = factSlot(factId);
      const first = unwrap(await this.getItem(factId));
      if (first?.slot !== slot) return this.failure(`Fact not found: ${factId}`);
      const agentId = first.scope.agentId;
      const current = unwrap(
        await this.findItems({ agentId, slots: [slot], statuses: ['active'], includeExpired: true })
      )
        .filter((item) => item.validTo === undefined)
        .at(-1);
      if (!current) return this.failure(`Fact not found: ${factId}`);

      const category = updates.category ?? current.attribute ?? '';
      const { category: _category, ...ownMetadata } = current.metadata ?? {};
      const metadata = updates.metadata ?? ownMetadata;
      const evidence = updates.evidence ?? current.evidence;
      const expiredAt = updates.expiresAt ?? current.expiredAt;
      const changed = {
        content: updates.content ?? current.content,
        attribute: category,
        confidence: updates.confidence ?? current.confidence,
        scope: factScope(agentId, metadata),
        evidence,
        verified: updates.evidence ? evidence.length > 0 : current.verified,
        metadata: factItemMetadata(category, metadata),
      };

      const updated =
        normalizeName(changed.content) === normalizeName(current.content)
          ? unwrap(await this.putItem({ ...current, ...changed, ...(expiredAt && { expiredAt }) }))
          : await this.supersedeFact(current, changed, expiredAt);
      return this.success(itemToFact(factId, updated, first.recordedAt));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Writes `changed` as the new state of the fact whose current item is `current`, through
   * {@link MemoryItems}, which closes `current`. The current item has to be in the new scope and
   * not let go for that, so an expiry moves from it to the new item. The new state starts and is
   * recorded at least a millisecond after the current one, so it always follows it.
   */
  private async supersedeFact(
    current: MemoryItem,
    changed: Pick<
      MemoryItem,
      'content' | 'attribute' | 'confidence' | 'scope' | 'evidence' | 'verified' | 'metadata'
    >,
    expiredAt: Date | undefined
  ): Promise<MemoryItem> {
    if (current.expiredAt !== undefined || current.scope.userId !== changed.scope.userId) {
      const { expiredAt: _expiredAt, ...kept } = current;
      unwrap(await this.putItem({ ...kept, scope: changed.scope }));
    }
    const at = new Date(
      Math.max(
        Date.now(),
        current.recordedAt.getTime() + 1,
        (current.validFrom?.getTime() ?? 0) + 1
      )
    );
    const [written] = await this.memoryItems.write([
      {
        ...changed,
        kind: 'fact',
        slot: current.slot,
        status: 'active',
        trust: current.trust,
        saidAt: at,
        sessionAt: at,
        validFrom: at,
        recordedAt: at,
      },
    ]);
    if (!written) throw new Error(`Failed to update fact ${current.slot}`);
    if (expiredAt === undefined) return written;
    await this.memoryItems.expire([written.id], expiredAt);
    return { ...written, expiredAt };
  }

  /** Deletes every item of the fact for good, its history included */
  async deleteFact(factId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      const slot = factSlot(factId);
      const first = unwrap(await this.getItem(factId));
      if (first?.slot !== slot) return this.success(undefined);
      const items = unwrap(
        await this.findItems({ agentId: first.scope.agentId, slots: [slot], includeExpired: true })
      );
      await this.memoryItems.purge(items.map((item) => item.id));
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /** The current facts of the agent whose content holds `query`, matched without case */
  async searchFacts(agentId: string, query: string): Promise<MemoryResult<Fact[]>> {
    return this.currentFacts(agentId, {
      sql: "latest.item->>'content' ILIKE $2",
      value: `%${query.replace(/[%_\\]/g, '\\$&')}%`,
    });
  }

  /**
   * The facts of `agentId` that meet `where` (a condition on `latest`, its value `$2`): the
   * current active item of each slot `fact:<id>`, until its expiry, with the time its first
   * item was recorded. Most confident first, then the most recently updated.
   */
  private async currentFacts(
    agentId: string,
    where?: { sql: string; value: string }
  ): Promise<MemoryResult<Fact[]>> {
    if (!this.pool) return this.failure('Not connected');
    const items = `${this.schema}.memory_items`;

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(
        `SELECT latest.item, COALESCE(origin.recorded_at, latest.recorded_at) AS created_at
         FROM ${items} latest
         LEFT JOIN ${items} origin ON origin.id = substr(latest.slot, ${FACT_SLOT_PREFIX.length + 1})
         WHERE latest.agent_id = $1 AND latest.kind = 'fact' AND latest.status = 'active'
           AND latest.slot LIKE '${FACT_SLOT_PREFIX}%' AND NOT latest.item ? 'validTo'
           AND (latest.expired_at IS NULL OR latest.expired_at > NOW())
           ${where ? `AND ${where.sql}` : ''}
         ORDER BY (latest.item->>'confidence')::float8 DESC, latest.recorded_at DESC,
           latest.id COLLATE "C"`,
        where ? [agentId, where.value] : [agentId]
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }

    return this.success(
      result.rows.flatMap((row) => {
        const item = memoryItemFromJson(row.item as StoredMemoryItem);
        if (!item.slot?.startsWith(FACT_SLOT_PREFIX)) return [];
        const factId = item.slot.slice(FACT_SLOT_PREFIX.length);
        return [itemToFact(factId, item, new Date(row.created_at as string))];
      })
    );
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
