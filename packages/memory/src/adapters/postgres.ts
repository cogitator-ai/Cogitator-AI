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
} from '@cogitator/types';
import { BaseMemoryAdapter } from './base.js';

type Pool = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{ release(): void }>;
  end(): Promise<void>;
};

export class PostgresAdapter
  extends BaseMemoryAdapter
  implements FactAdapter, EmbeddingAdapter
{
  readonly provider: MemoryProvider = 'postgres';

  private pool: Pool | null = null;
  private config: PostgresAdapterConfig;
  private schema: string;
  private vectorDimensions = 768; // Default for nomic-embed-text

  constructor(config: PostgresAdapterConfig) {
    super();
    this.config = config;
    this.schema = config.schema ?? 'cogitator';
  }

  async connect(): Promise<MemoryResult<void>> {
    try {
      const pg = await import('pg');
      const { Pool } = pg.default ?? pg;

      this.pool = new Pool({
        connectionString: this.config.connectionString,
        max: this.config.poolSize ?? 10,
      }) as Pool;

      // Test connection
      const client = await this.pool.connect();
      client.release();

      // Initialize schema
      await this.initSchema();

      return this.success(undefined);
    } catch (error) {
      return this.failure(
        `Postgres connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async initSchema(): Promise<void> {
    if (!this.pool) return;

    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

    // Enable pgvector extension (safe to run multiple times)
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {
      // pgvector might not be installed, continue without it
    }

    // Threads table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Entries table
    await this.pool.query(`
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

    // Facts table
    await this.pool.query(`
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

    // Embeddings table with vector column
    await this.pool.query(`
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

    // Indexes
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_entries_thread_id
      ON ${this.schema}.entries(thread_id, created_at)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_facts_agent_id
      ON ${this.schema}.facts(agent_id, category)
    `);

    // Vector index (IVFFlat for approximate nearest neighbor)
    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_embeddings_vector
        ON ${this.schema}.embeddings
        USING ivfflat (vector vector_cosine_ops) WITH (lists = 100)
      `);
    } catch {
      // pgvector index might fail if extension not available
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    return this.success(undefined);
  }

  // ============================================
  // Thread Operations
  // ============================================

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<MemoryResult<Thread>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('thread');
    const now = new Date();

    await this.pool.query(
      `INSERT INTO ${this.schema}.threads (id, agent_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, agentId, metadata, now]
    );

    return this.success({ id, agentId, metadata, createdAt: now, updatedAt: now });
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.pool) return this.failure('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.threads WHERE id = $1`,
      [threadId]
    );

    if (result.rows.length === 0) return this.success(null);

    const row = result.rows[0];
    return this.success({
      id: row.id as string,
      agentId: row.agent_id as string,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.pool) return this.failure('Not connected');

    const result = await this.pool.query(
      `UPDATE ${this.schema}.threads
       SET metadata = metadata || $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [threadId, metadata]
    );

    if (result.rows.length === 0) {
      return this.failure(`Thread not found: ${threadId}`);
    }

    const row = result.rows[0];
    return this.success({
      id: row.id as string,
      agentId: row.agent_id as string,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    });
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    await this.pool.query(`DELETE FROM ${this.schema}.threads WHERE id = $1`, [
      threadId,
    ]);
    return this.success(undefined);
  }

  // ============================================
  // Entry Operations
  // ============================================

  async addEntry(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>
  ): Promise<MemoryResult<MemoryEntry>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('entry');
    const now = new Date();

    await this.pool.query(
      `INSERT INTO ${this.schema}.entries
       (id, thread_id, message, tool_calls, tool_results, token_count, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        entry.threadId,
        entry.message,
        entry.toolCalls ?? null,
        entry.toolResults ?? null,
        entry.tokenCount,
        entry.metadata ?? {},
        now,
      ]
    );

    return this.success({ ...entry, id, createdAt: now });
  }

  async getEntries(
    options: MemoryQueryOptions
  ): Promise<MemoryResult<MemoryEntry[]>> {
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

    query += ' ORDER BY created_at ASC';

    if (options.limit) {
      // Get last N entries by wrapping in subquery
      query = `
        SELECT * FROM (
          SELECT * FROM ${this.schema}.entries WHERE thread_id = $1
          ${options.before ? `AND created_at < $2` : ''}
          ${options.after ? `AND created_at > $${options.before ? 3 : 2}` : ''}
          ORDER BY created_at DESC
          LIMIT $${paramIndex}
        ) sub ORDER BY created_at ASC
      `;
      params.push(options.limit);
    }

    const result = await this.pool.query(query, params);

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

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.entries WHERE id = $1`,
      [entryId]
    );

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
    await this.pool.query(`DELETE FROM ${this.schema}.entries WHERE id = $1`, [
      entryId,
    ]);
    return this.success(undefined);
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    await this.pool.query(
      `DELETE FROM ${this.schema}.entries WHERE thread_id = $1`,
      [threadId]
    );
    return this.success(undefined);
  }

  // ============================================
  // Fact Operations (FactAdapter)
  // ============================================

  async addFact(
    fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<Fact>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('fact');
    const now = new Date();

    await this.pool.query(
      `INSERT INTO ${this.schema}.facts
       (id, agent_id, content, category, confidence, source, metadata, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        id,
        fact.agentId,
        fact.content,
        fact.category,
        fact.confidence,
        fact.source,
        fact.metadata ?? {},
        fact.expiresAt ?? null,
        now,
      ]
    );

    return this.success({ ...fact, id, createdAt: now, updatedAt: now });
  }

  async getFacts(
    agentId: string,
    category?: string
  ): Promise<MemoryResult<Fact[]>> {
    if (!this.pool) return this.failure('Not connected');

    let query = `SELECT * FROM ${this.schema}.facts WHERE agent_id = $1`;
    const params: unknown[] = [agentId];

    if (category) {
      query += ' AND category = $2';
      params.push(category);
    }

    query += ' AND (expires_at IS NULL OR expires_at > NOW())';
    query += ' ORDER BY confidence DESC, updated_at DESC';

    const result = await this.pool.query(query, params);

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
    updates: Partial<
      Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt'>
    >
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
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(updates.metadata);
    }
    if (updates.expiresAt !== undefined) {
      setClauses.push(`expires_at = $${paramIndex++}`);
      params.push(updates.expiresAt);
    }

    params.push(factId);

    const result = await this.pool.query(
      `UPDATE ${this.schema}.facts SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

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
    await this.pool.query(`DELETE FROM ${this.schema}.facts WHERE id = $1`, [
      factId,
    ]);
    return this.success(undefined);
  }

  async searchFacts(
    agentId: string,
    query: string
  ): Promise<MemoryResult<Fact[]>> {
    if (!this.pool) return this.failure('Not connected');

    // Simple text search using ILIKE
    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.facts
       WHERE agent_id = $1 AND content ILIKE $2
       AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY confidence DESC`,
      [agentId, `%${query}%`]
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
  }

  // ============================================
  // Embedding Operations (EmbeddingAdapter)
  // ============================================

  async addEmbedding(
    embedding: Omit<Embedding, 'id' | 'createdAt'>
  ): Promise<MemoryResult<Embedding>> {
    if (!this.pool) return this.failure('Not connected');

    const id = this.generateId('emb');
    const now = new Date();

    // pgvector expects array formatted as string
    const vectorStr = `[${embedding.vector.join(',')}]`;

    await this.pool.query(
      `INSERT INTO ${this.schema}.embeddings
       (id, source_id, source_type, vector, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        embedding.sourceId,
        embedding.sourceType,
        vectorStr,
        embedding.content,
        embedding.metadata ?? {},
        now,
      ]
    );

    return this.success({ ...embedding, id, createdAt: now });
  }

  async search(
    options: SemanticSearchOptions
  ): Promise<MemoryResult<Array<Embedding & { score: number }>>> {
    if (!this.pool) return this.failure('Not connected');

    if (!options.vector) {
      return this.failure(
        'search() requires vector. Use EmbeddingService to convert query to vector first.'
      );
    }

    const vectorStr = `[${options.vector.join(',')}]`;
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.7;

    let query = `
      SELECT *, 1 - (vector <=> $1) as score
      FROM ${this.schema}.embeddings
      WHERE 1 - (vector <=> $1) >= $2
    `;
    const params: unknown[] = [vectorStr, threshold];
    let paramIndex = 3;

    if (options.filter?.sourceType) {
      query += ` AND source_type = $${paramIndex++}`;
      params.push(options.filter.sourceType);
    }

    query += ` ORDER BY vector <=> $1 LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(query, params);

    return this.success(
      result.rows.map((row) => ({
        id: row.id as string,
        sourceId: row.source_id as string,
        sourceType: row.source_type as Embedding['sourceType'],
        vector: row.vector as number[],
        content: row.content as string,
        metadata: row.metadata as Record<string, unknown>,
        createdAt: new Date(row.created_at as string),
        score: row.score as number,
      }))
    );
  }

  async deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    await this.pool.query(
      `DELETE FROM ${this.schema}.embeddings WHERE id = $1`,
      [embeddingId]
    );
    return this.success(undefined);
  }

  async deleteBySource(sourceId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return this.failure('Not connected');
    await this.pool.query(
      `DELETE FROM ${this.schema}.embeddings WHERE source_id = $1`,
      [sourceId]
    );
    return this.success(undefined);
  }

  // ============================================
  // Configuration
  // ============================================

  setVectorDimensions(dimensions: number): void {
    this.vectorDimensions = dimensions;
  }
}
