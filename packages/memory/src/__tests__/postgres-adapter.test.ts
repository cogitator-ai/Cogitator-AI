import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres';
import type { Message, ToolCall, ToolResult } from '@cogitator-ai/types';

/** How node-pg turns a JS parameter into the text it sends to the server. */
const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils.js') as {
  prepareValue(value: unknown): unknown;
};

type QueryResult = { rows: Record<string, unknown>[] };

const mockPool = {
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(),
  connect: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
};

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b|set_config\(/;

const mockPoolClient = {
  query: vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> =>
    TRANSACTION_CONTROL.test(sql) ? { rows: [] } : mockPool.query(sql, params)
  ),
  release: vi.fn(),
};
mockPool.connect.mockResolvedValue(mockPoolClient);

/** The SQL and the parameters, as node-pg serializes them, of the first query containing `fragment`. */
function sentToPostgres(fragment: string): { sql: string; params: unknown[] } {
  const call = mockPool.query.mock.calls.find(([sql]) => sql.includes(fragment));
  if (!call) throw new Error(`No query containing ${fragment}`);
  const [sql, params = []] = call;
  return { sql, params: params.map((param) => prepareValue(param)) };
}

/** Parses a JSONB parameter the way Postgres would, failing on anything that is not JSON text. */
function asJsonb(param: unknown): unknown {
  if (param === null) return null;
  if (typeof param !== 'string') throw new Error(`JSONB parameter sent as ${typeof param}`);
  return JSON.parse(param);
}

vi.mock('pg', () => {
  class Pool {
    query = mockPool.query;
    connect = mockPool.connect;
    end = mockPool.end;
  }
  return {
    default: { Pool },
    Pool,
  };
});

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
    adapter = new PostgresAdapter({
      provider: 'postgres',
      connectionString: 'postgresql://localhost:5432/test',
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects and initializes schema', async () => {
      const newAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS cogitator');
    });

    it('uses custom schema name', async () => {
      vi.clearAllMocks();
      mockPool.query.mockResolvedValue({ rows: [] });

      const newAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
        schema: 'custom_schema',
      });

      await newAdapter.connect();

      expect(mockPool.query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS custom_schema');
    });

    it('disconnects and closes pool', async () => {
      await adapter.disconnect();

      expect(mockPool.end).toHaveBeenCalled();
    });
  });

  describe('thread operations', () => {
    it('creates a thread', async () => {
      mockPool.query.mockImplementationOnce(async (_sql: string, params: unknown[] = []) => ({
        rows: [
          {
            id: params[0],
            agent_id: params[1],
            metadata: JSON.parse(String(params[2])),
            created_at: params[3],
            updated_at: params[3],
          },
        ],
      }));

      const result = await adapter.createThread('agent1', { foo: 'bar' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^thread_/);
        expect(result.data.agentId).toBe('agent1');
        expect(result.data.metadata).toEqual({ foo: 'bar' });
      }
    });

    it('gets a thread', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'thread_123',
            agent_id: 'agent1',
            metadata: { key: 'value' },
            created_at: now,
            updated_at: now,
          },
        ],
      });

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('thread_123');
        expect(result.data?.agentId).toBe('agent1');
        expect(result.data?.createdAt).toBeInstanceOf(Date);
      }
    });

    it('returns null for non-existent thread', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'thread_123',
            agent_id: 'agent1',
            metadata: { a: 1, b: 2 },
            created_at: now,
            updated_at: now,
          },
        ],
      });

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
    });

    it('returns error for updating non-existent thread', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'thread_123',
      ]);
    });
  });

  describe('entry operations', () => {
    it('adds an entry', async () => {
      const message: Message = { role: 'user', content: 'Hello' };
      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message,
        tokenCount: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^entry_/);
        expect(result.data.message).toEqual(message);
      }
    });

    it('gets entries for thread', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: {},
            created_at: now,
          },
        ],
      });

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('entry_123');
      }
    });

    it('gets entries with time range filter', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({
        threadId: 'thread_123',
        after: new Date('2024-01-01'),
        before: new Date('2024-12-31'),
      });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('created_at <');
      expect(lastCall[0]).toContain('created_at >');
    });

    it('gets entries with limit', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('LIMIT');
      expect(lastCall[1]).toContain(5);
    });

    it('gets single entry', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: {},
            created_at: now,
          },
        ],
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('entry_123');
      }
    });

    it('deletes entry', async () => {
      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'entry_123',
      ]);
    });

    it('clears thread entries', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'thread_123',
      ]);
    });
  });

  describe('fact operations', () => {
    it('adds a fact', async () => {
      const result = await adapter.addFact({
        agentId: 'agent1',
        content: 'User prefers dark mode',
        category: 'preferences',
        confidence: 0.9,
        source: 'inferred',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^fact_/);
        expect(result.data.content).toBe('User prefers dark mode');
      }
    });

    it('gets facts for agent', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'fact_123',
            agent_id: 'agent1',
            content: 'Test fact',
            category: 'general',
            confidence: 1.0,
            source: 'explicit',
            metadata: {},
            created_at: now,
            updated_at: now,
            expires_at: null,
          },
        ],
      });

      const result = await adapter.getFacts('agent1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].content).toBe('Test fact');
      }
    });

    it('gets facts by category', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getFacts('agent1', 'preferences');

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('category = $2');
      expect(lastCall[1]).toContain('preferences');
    });

    it('updates a fact', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'fact_123',
            agent_id: 'agent1',
            content: 'Updated content',
            category: 'general',
            confidence: 0.8,
            source: 'explicit',
            metadata: {},
            created_at: now,
            updated_at: now,
            expires_at: null,
          },
        ],
      });

      const result = await adapter.updateFact('fact_123', {
        content: 'Updated content',
        confidence: 0.8,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toBe('Updated content');
      }
    });

    it('returns error for updating non-existent fact', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.updateFact('nonexistent', { content: 'test' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes a fact', async () => {
      const result = await adapter.deleteFact('fact_123');

      expect(result.success).toBe(true);
    });

    it('searches facts', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'fact_123',
            agent_id: 'agent1',
            content: 'User likes coffee',
            category: 'preferences',
            confidence: 0.9,
            source: 'inferred',
            metadata: {},
            created_at: now,
            updated_at: now,
            expires_at: null,
          },
        ],
      });

      const result = await adapter.searchFacts('agent1', 'coffee');

      expect(result.success).toBe(true);
      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('ILIKE');
      expect(lastCall[1]).toContain('%coffee%');
    });
  });

  describe('embedding operations', () => {
    it('adds an embedding', async () => {
      const result = await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'message',
        vector: [0.1, 0.2, 0.3],
        content: 'Hello world',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^emb_/);
        expect(result.data.vector).toEqual([0.1, 0.2, 0.3]);
      }
    });

    it('searches embeddings by vector', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'emb_123',
            source_id: 'entry_123',
            source_type: 'entry',
            vector: [0.1, 0.2, 0.3],
            content: 'Test content',
            metadata: {},
            created_at: new Date().toISOString(),
            score: 0.95,
          },
        ],
      });

      const result = await adapter.search({
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        threshold: 0.7,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].score).toBe(0.95);
      }
    });

    it('requires vector for search', async () => {
      const result = await adapter.search({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('requires vector');
      }
    });

    it('filters search by source type', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.search({
        vector: [0.1, 0.2, 0.3],
        filter: { sourceType: 'fact' },
      });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('source_type =');
      expect(lastCall[1]).toContain('fact');
    });

    it('filters search by user, letting through embeddings of no user', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.search({ vector: [0.1, 0.2, 0.3], filter: { userId: 'alice' } });

      const [sql, params] = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(sql).toMatch(/\(metadata->>'userId' = \$\d+ OR metadata->>'userId' IS NULL\)/);
      expect(params).toContain('alice');
    });

    it('deletes an embedding', async () => {
      const result = await adapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(true);
    });

    it('deletes embeddings by source', async () => {
      const result = await adapter.deleteBySource('entry_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('source_id = $1'), [
        'entry_123',
      ]);
    });
  });

  describe('error handling', () => {
    it('returns error when not connected', async () => {
      const disconnectedAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });

      const result = await disconnectedAdapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });

    it.each([
      ['getThread', () => adapter.getThread('thread_1')],
      ['updateThread', () => adapter.updateThread('thread_1', { a: 1 })],
      ['getEntries', () => adapter.getEntries({ threadId: 'thread_1' })],
      ['getEntry', () => adapter.getEntry('entry_1')],
      ['getFacts', () => adapter.getFacts('agent1')],
      ['updateFact', () => adapter.updateFact('fact_1', { content: 'x' })],
    ])('%s returns a failed result when the query fails', async (_name, call) => {
      mockPool.query.mockRejectedValueOnce(new Error('connection terminated'));

      const result = await call();

      expect(result).toEqual({ success: false, error: 'connection terminated' });
    });

    it('disconnect returns a failed result when closing the pool fails', async () => {
      mockPool.end.mockRejectedValueOnce(new Error('pool already ended'));

      const result = await adapter.disconnect();

      expect(result).toEqual({ success: false, error: 'pool already ended' });
      expect((await adapter.getThread('thread_1')).success).toBe(false);
    });
  });

  describe('createThread upsert', () => {
    it('returns the stored createdAt when the thread already exists', async () => {
      const storedCreatedAt = new Date('2024-01-01T00:00:00.000Z');
      mockPool.query.mockImplementationOnce(async (_sql: string, params: unknown[] = []) => ({
        rows: [
          {
            id: params[0],
            agent_id: params[1],
            metadata: JSON.parse(String(params[2])),
            created_at: storedCreatedAt.toISOString(),
            updated_at: params[3],
          },
        ],
      }));

      const result = await adapter.createThread('agent1', { v: 2 }, 'thread_existing');

      expect(mockPool.query).toHaveBeenLastCalledWith(
        expect.stringContaining('RETURNING *'),
        expect.any(Array)
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdAt).toEqual(storedCreatedAt);
        expect(result.data.updatedAt.getTime()).toBeGreaterThan(storedCreatedAt.getTime());
        expect(result.data.metadata).toEqual({ v: 2 });
      }
    });
  });

  describe('JSONB columns', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'book_table', arguments: { venue: 'Quillon', guests: 2 } },
    ];
    const toolResults: ToolResult[] = [
      { callId: 'call_1', name: 'book_table', result: { confirmation: 'QX-5521' } },
    ];

    it('sends tool calls and tool results as JSON text, not as Postgres array literals', async () => {
      const message: Message = { role: 'assistant', content: '' };
      const result = await adapter.addEntry({
        threadId: 'thread_1',
        message,
        toolCalls,
        toolResults,
        tokenCount: 1,
        metadata: { tags: ['booking'] },
      });

      expect(result.success).toBe(true);
      const { sql, params } = sentToPostgres('INSERT INTO cogitator.entries');
      expect(sql).toMatch(/\$3::jsonb, \$4::jsonb, \$5::jsonb, \$6, \$7::jsonb/);
      expect(asJsonb(params[2])).toEqual(message);
      expect(asJsonb(params[3])).toEqual(toolCalls);
      expect(asJsonb(params[4])).toEqual(toolResults);
      expect(asJsonb(params[6])).toEqual({ tags: ['booking'] });
    });

    it('stores NULL for an entry without tool calls', async () => {
      await adapter.addEntry({
        threadId: 'thread_1',
        message: { role: 'user', content: 'Hi' },
        tokenCount: 1,
      });

      const { params } = sentToPostgres('INSERT INTO cogitator.entries');
      expect(params[3]).toBeNull();
      expect(params[4]).toBeNull();
      expect(asJsonb(params[6])).toEqual({});
    });

    it.each([
      [
        'createThread',
        () => adapter.createThread('agent1', { tags: ['a'] }),
        'INSERT INTO cogitator.threads',
        2,
      ],
      [
        'updateThread',
        () => adapter.updateThread('thread_1', { tags: ['b'] }),
        'UPDATE cogitator.threads',
        1,
      ],
      [
        'addFact',
        () =>
          adapter.addFact({
            agentId: 'agent1',
            content: 'Likes tea',
            category: 'preference',
            confidence: 1,
            source: 'user',
            metadata: { tags: ['c'] },
          }),
        'INSERT INTO cogitator.facts',
        6,
      ],
      [
        'updateFact',
        () => adapter.updateFact('fact_1', { metadata: { tags: ['d'] } }),
        'UPDATE cogitator.facts',
        0,
      ],
      [
        'addEmbedding',
        () =>
          adapter.addEmbedding({
            sourceId: 'doc_1',
            sourceType: 'document',
            vector: [0.1, 0.2],
            content: 'Doc',
            metadata: { tags: ['e'] },
          }),
        'INSERT INTO cogitator.embeddings',
        5,
      ],
    ])('%s sends metadata as JSON text cast to jsonb', async (_name, call, fragment, index) => {
      await call();

      const { sql, params } = sentToPostgres(fragment);
      expect(sql).toContain(`$${index + 1}::jsonb`);
      expect(asJsonb(params[index])).toEqual({ tags: [expect.any(String)] });
    });
  });

  describe('vector index', () => {
    async function connectWith(
      answer: (sql: string) => QueryResult | undefined
    ): Promise<{ fresh: PostgresAdapter; queries: string[] }> {
      vi.clearAllMocks();
      mockPool.query.mockImplementation(async (sql: string) => answer(sql) ?? { rows: [] });
      const fresh = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });
      const result = await fresh.connect();
      expect(result.success).toBe(true);
      const queries = mockPool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
      return { fresh, queries };
    }

    it('builds an HNSW cosine index, which needs no rows to be trained on', async () => {
      const { queries } = await connectWith(() => undefined);

      expect(queries).toContainEqual(
        expect.stringMatching(
          /CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON cogitator\.embeddings USING hnsw \(vector vector_cosine_ops\)/
        )
      );
      expect(queries.some((sql) => /ivfflat/i.test(sql))).toBe(false);
    });

    it('replaces the ivfflat index that earlier versions built on the empty table', async () => {
      const { queries } = await connectWith((sql) =>
        sql.includes('pg_indexes')
          ? {
              rows: [
                {
                  indexdef:
                    'CREATE INDEX idx_embeddings_vector ON cogitator.embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists=100)',
                },
              ],
            }
          : undefined
      );

      const drop = queries.indexOf('DROP INDEX IF EXISTS cogitator.idx_embeddings_vector');
      const create = queries.findIndex((sql) => sql.includes('USING hnsw'));
      expect(drop).toBeGreaterThan(-1);
      expect(create).toBeGreaterThan(drop);
    });

    it('keeps an HNSW index that already exists', async () => {
      const { queries } = await connectWith((sql) =>
        sql.includes('pg_indexes')
          ? {
              rows: [
                {
                  indexdef:
                    'CREATE INDEX idx_embeddings_vector ON cogitator.embeddings USING hnsw (vector vector_cosine_ops)',
                },
              ],
            }
          : undefined
      );

      expect(queries.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
      expect(queries.some((sql) => sql.includes('USING hnsw'))).toBe(false);
    });

    it('orders equally distant rows by id across all candidates the index computes', async () => {
      await adapter.search({ vector: [0.1, 0.2], limit: 3, threshold: 0 });

      const [sql, params] = mockPool.query.mock.calls.at(-1) ?? [''];
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat).toMatch(
        /ORDER BY vector <=> \$1 LIMIT \$3 \) nearest ORDER BY score DESC, id LIMIT \$4/
      );
      expect(params).toEqual(['[0.1,0.2]', 0, 40, 3]);
    });

    it('does not cap a limit above the largest HNSW candidate list', async () => {
      await adapter.search({ vector: [0.1], limit: 5000, threshold: 0 });

      const [, params] = mockPool.query.mock.calls.at(-1) ?? [''];
      expect(params?.slice(-2)).toEqual([5000, 5000]);
    });

    it.each([
      ['0.8.0', 100, true],
      ['0.7.4', 100, false],
      ['0.8.5', 3, true],
    ])(
      'with pgvector %s a search for %i rows asks the index for enough candidates',
      async (version, limit, iterative) => {
        const { fresh } = await connectWith((sql) =>
          sql.includes('pg_extension') ? { rows: [{ extversion: version }] } : undefined
        );
        mockPoolClient.query.mockClear();
        await fresh.search({ vector: [0.1, 0.2], limit, threshold: 0 });

        const sent = mockPoolClient.query.mock.calls.map(([sql, params]) => ({ sql, params }));
        const settings = sent.find(({ sql }) => sql.includes('set_config'));
        expect(sent[0]?.sql).toBe('BEGIN');
        expect(settings?.params).toEqual([String(Math.max(40, limit))]);
        expect(settings?.sql.includes("'hnsw.iterative_scan', 'strict_order'")).toBe(iterative);
        const search = sent.find(({ sql }) => sql.includes('ORDER BY vector <=> $1'));
        expect(search?.params?.slice(-2)).toEqual([Math.max(40, limit), limit]);
        expect(sent.at(-1)?.sql).toBe('COMMIT');
        expect(mockPoolClient.release).toHaveBeenCalled();
      }
    );
  });

  describe('provider', () => {
    it('returns postgres as provider', () => {
      expect(adapter.provider).toBe('postgres');
    });
  });

  describe('vector dimensions', () => {
    it('allows setting custom dimensions before connect', () => {
      const freshAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://test:test@localhost:5432/test',
      });
      freshAdapter.setVectorDimensions(1536);
    });

    it('throws when setting dimensions after connect', () => {
      expect(() => adapter.setVectorDimensions(1536)).toThrow(
        'Cannot change vector dimensions after connecting'
      );
    });

    it('rejects invalid dimensions', () => {
      const freshAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://test:test@localhost:5432/test',
      });
      expect(() => freshAdapter.setVectorDimensions(0)).toThrow();
      expect(() => freshAdapter.setVectorDimensions(-1)).toThrow();
      expect(() => freshAdapter.setVectorDimensions(NaN)).toThrow();
    });
  });
});
