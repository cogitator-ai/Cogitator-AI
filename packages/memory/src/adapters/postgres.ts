/**
 * Postgres adapter for long-term memory
 *
 * Supports:
 * - Threads and entries (MemoryAdapter)
 * - Facts (FactAdapter)
 * - Embeddings with pgvector (EmbeddingAdapter)
 */

import type {
  Thread,
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
} from '@cogitator-ai/types';
import { BaseMemoryAdapter } from './base';
import { EMPTY_DELETE_FILTER_ERROR, hasDeleteCondition } from '../search/filter';
import {
  detectVectorSearchTuning,
  ensureHnswCosineIndex,
  hnswSearchSettings,
  type SqlQueryable,
  type VectorSearchTuning,
} from './pgvector';

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

/** JSON text for a JSONB parameter. node-pg would send a JS array as a Postgres array literal. */
function toJsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export class PostgresAdapter
  extends BaseMemoryAdapter
  implements FactAdapter, EmbeddingAdapter, KeywordSearchAdapter
{
  readonly provider: MemoryProvider = 'postgres';

  private pool: Pool | null = null;
  private config: PostgresAdapterConfig;
  private schema: string;
  private vectorDimensions = DEFAULT_VECTOR_DIMENSIONS;
  private dimensionsConfigured = false;
  private vectorTuning: VectorSearchTuning = { iterativeScan: false };
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

    let pool: Pool | undefined;
    try {
      const pg = await import('pg');
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

  private async initSchema(pool: Pool): Promise<void> {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

    let extensionError: string | undefined;
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (err) {
      extensionError = (err as Error).message;
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
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

    await pool.query(`
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_entries_thread_id
      ON ${this.schema}.entries(thread_id, created_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_facts_agent_id
      ON ${this.schema}.facts(agent_id, category)
    `);

    this.vectorStore = await this.prepareVectorStore(pool, extensionError);
  }

  /**
   * Creates the `embeddings` table, its HNSW index and its full-text column when pgvector is
   * available. An existing table keeps its vector size: an adapter without configured dimensions
   * adopts it, one configured for another size cannot store or search embeddings until the
   * table is migrated.
   */
  private async prepareVectorStore(
    pool: Pool,
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

    try {
      await ensureHnswCosineIndex(pool, {
        schema: this.schema,
        table: 'embeddings',
        column: 'vector',
        index: 'idx_embeddings_vector',
      });
      this.vectorTuning = await detectVectorSearchTuning(pool);
    } catch (err) {
      console.warn('Failed to create the HNSW vector index:', (err as Error).message);
    }

    try {
      await pool.query(`
        ALTER TABLE ${this.schema}.embeddings
        ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_tsv
        ON ${this.schema}.embeddings USING GIN (content_tsv)
      `);
    } catch (err) {
      console.warn('Failed to create tsvector column/index:', (err as Error).message);
    }

    return { available: true, dimensions: this.vectorDimensions };
  }

  /**
   * The vector size of the existing `embeddings.vector` column: null without the table, 0 for a
   * column declared without a size.
   */
  private async embeddingColumnDimensions(pool: Pool): Promise<number | null> {
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

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.pool) return this.failure('Not connected');

    try {
      const result = await this.pool.query(
        `UPDATE ${this.schema}.threads
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [threadId, toJsonb(metadata)]
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
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.threads WHERE id = $1`, [threadId]);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('entry');
    const now = this.entryTimestamp(entry);

    try {
      await this.pool.query(
        `INSERT INTO ${this.schema}.entries
         (id, thread_id, message, tool_calls, tool_results, token_count, metadata, created_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)`,
        [
          id,
          entry.threadId,
          toJsonb(entry.message),
          toJsonb(entry.toolCalls),
          toJsonb(entry.toolResults),
          entry.tokenCount,
          toJsonb(entry.metadata ?? {}),
          now,
        ]
      );

      return this.success({ ...entry, id, createdAt: now });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.pool) return this.failure('Not connected');

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

    if (options.limit) {
      query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
      params.push(options.limit);
      query = `SELECT * FROM (${query}) sub ORDER BY created_at ASC`;
    } else {
      query += ' ORDER BY created_at ASC';
    }

    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.pool.query(query, params);
    } catch (err) {
      return this.failure((err as Error).message);
    }

    return this.success(
      result.rows.map((row) => ({
        id: row.id as string,
        threadId: row.thread_id as string,
        message: row.message as MemoryEntry['message'],
        toolCalls: options.includeToolCalls
          ? (row.tool_calls as MemoryEntry['toolCalls'])
          : undefined,
        toolResults: options.includeToolCalls
          ? (row.tool_results as MemoryEntry['toolResults'])
          : undefined,
        tokenCount: row.token_count as number,
        metadata: row.metadata as Record<string, unknown>,
        createdAt: new Date(row.created_at as string),
      }))
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

    const row = result.rows[0];
    return this.success({
      id: row.id as string,
      threadId: row.thread_id as string,
      message: row.message as MemoryEntry['message'],
      toolCalls: row.tool_calls as MemoryEntry['toolCalls'],
      toolResults: row.tool_results as MemoryEntry['toolResults'],
      tokenCount: row.token_count as number,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
    });
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.entries WHERE id = $1`, [entryId]);
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    try {
      await this.pool.query(`DELETE FROM ${this.schema}.entries WHERE thread_id = $1`, [threadId]);
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
    const query = `
      SELECT * FROM (
        SELECT *, 1 - (vector <=> $1) as score
        FROM ${this.schema}.embeddings
        WHERE 1 - (vector <=> $1) >= $2${filter.sql}
        ORDER BY vector <=> $1
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
      result.rows.map((row) => ({
        id: row.id as string,
        sourceId: row.source_id as string,
        sourceType: row.source_type as Embedding['sourceType'],
        vector:
          typeof row.vector === 'string'
            ? (row.vector as string)
                .replace(/^\[|\]$/g, '')
                .split(',')
                .map(Number)
            : (row.vector as number[]),
        content: row.content as string,
        metadata: row.metadata as Record<string, unknown>,
        createdAt: new Date(row.created_at as string),
        score: row.score as number,
      }))
    );
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
    if (filter?.sourceType) {
      sql += ` AND source_type = $${index++}`;
      params.push(filter.sourceType);
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

  private rowToThread(row: Record<string, unknown>): Thread {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
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
