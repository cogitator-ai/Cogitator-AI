import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres';

type QueryResult = { rows: Record<string, unknown>[] };

interface FakeDatabase {
  pgvector: boolean;
  extensionError?: string;
  embeddingColumnSize?: number;
  failOn?: RegExp;
}

const db = vi.hoisted(() => ({ current: { pgvector: true } as FakeDatabase }));

const pool = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(),
  end: vi.fn(async () => undefined),
}));

/** Answers the adapter's queries the way a Postgres with or without pgvector would. */
async function answer(sql: string): Promise<QueryResult> {
  const database = db.current;
  if (database.failOn?.test(sql)) throw new Error('relation is locked');
  if (sql.includes('CREATE EXTENSION')) {
    if (database.extensionError) throw new Error(database.extensionError);
    return { rows: [] };
  }
  if (sql.includes("to_regtype('vector')")) return { rows: [{ available: database.pgvector }] };
  if (sql.includes('pg_attribute')) {
    return database.embeddingColumnSize === undefined
      ? { rows: [] }
      : { rows: [{ dimensions: database.embeddingColumnSize }] };
  }
  if (!database.pgvector && /\bvector\(|vector_cosine_ops|<=>/.test(sql)) {
    throw new Error('type "vector" does not exist');
  }
  if (sql.includes('INSERT INTO cogitator.threads')) {
    return {
      rows: [
        { id: 't1', agent_id: 'a', metadata: {}, created_at: new Date(), updated_at: new Date() },
      ],
    };
  }
  return { rows: [] };
}

vi.mock('pg', () => {
  class Pool {
    query = pool.query;
    end = pool.end;
    async connect() {
      return { query: pool.query, release: () => undefined };
    }
  }
  return { default: { Pool }, Pool };
});

function adapter(dimensions?: number): PostgresAdapter {
  return new PostgresAdapter({
    provider: 'postgres',
    connectionString: 'postgresql://localhost:5432/test',
    ...(dimensions !== undefined && { dimensions }),
  });
}

function queries(): string[] {
  return pool.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
}

const embedding = {
  sourceId: 's1',
  sourceType: 'document' as const,
  vector: [0.1, 0.2],
  content: 'text',
};

describe('PostgresAdapter vector store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.query.mockImplementation(answer);
    db.current = { pgvector: true };
  });

  describe('without pgvector', () => {
    beforeEach(() => {
      db.current = {
        pgvector: false,
        extensionError: 'permission denied to create extension "vector"',
      };
    });

    it('connects and keeps threads working', async () => {
      const store = adapter();

      const connected = await store.connect();
      expect(connected).toEqual({ success: true, data: undefined });

      const thread = await store.createThread('a', {}, 't1');
      expect(thread.success).toBe(true);
      expect(queries().some((q) => q.includes('cogitator.embeddings'))).toBe(false);
    });

    it('fails embedding operations with the reason', async () => {
      const store = adapter();
      await store.connect();

      const status = store.vectorStatus();
      expect(status.available).toBe(false);

      const added = await store.addEmbedding(embedding);
      expect(added.success).toBe(false);
      if (!added.success) {
        expect(added.error).toMatch(/pgvector is not installed/);
        expect(added.error).toMatch(/permission denied/);
      }
      const found = await store.search({ vector: [0.1, 0.2] });
      expect(found.success).toBe(false);
      const keyword = await store.keywordSearch({ query: 'text' });
      expect(keyword.success).toBe(false);
    });
  });

  describe('vector size of an existing table', () => {
    it('reports a table of another size instead of searching it', async () => {
      db.current = { pgvector: true, embeddingColumnSize: 768 };
      const store = adapter(1536);
      await store.connect();

      expect(store.vectorStatus()).toMatchObject({ available: false, tableExists: true });
      const added = await store.addEmbedding({ ...embedding, vector: new Array(1536).fill(0) });
      expect(added.success).toBe(false);
      if (!added.success) expect(added.error).toMatch(/vector\(768\).*1536/);
      const found = await store.search({ vector: new Array(1536).fill(0) });
      expect(found.success).toBe(false);
      expect(queries().some((q) => q.includes('<=>'))).toBe(false);

      const deleted = await store.deleteBySource('s1');
      expect(deleted.success).toBe(true);
    });

    it('adopts the size of an existing table when none is configured', async () => {
      db.current = { pgvector: true, embeddingColumnSize: 1024 };
      const store = adapter();
      await store.connect();

      expect(store.vectorStatus()).toEqual({ available: true, dimensions: 1024 });
      expect(
        queries().some((q) => q.includes('CREATE TABLE IF NOT EXISTS cogitator.embeddings'))
      ).toBe(false);
    });

    it('creates the table with the configured size', async () => {
      const store = adapter(1536);
      await store.connect();

      expect(store.vectorStatus()).toEqual({ available: true, dimensions: 1536 });
      expect(queries().some((q) => q.includes('vector vector(1536)'))).toBe(true);
    });
  });

  describe('failed connect', () => {
    it('closes the pool when the schema cannot be created', async () => {
      db.current = { pgvector: true, failOn: /CREATE TABLE IF NOT EXISTS cogitator\.entries/ };
      const store = adapter();

      const connected = await store.connect();

      expect(connected.success).toBe(false);
      expect(pool.end).toHaveBeenCalledTimes(1);
      const thread = await store.getThread('t1');
      expect(thread).toEqual({ success: false, error: 'Not connected' });
    });
  });

  describe('metadata filters', () => {
    it('matches metadata by JSONB containment in searches and deletes', async () => {
      const store = adapter(2);
      await store.connect();
      pool.query.mockClear();

      await store.keywordSearch({ query: 'x', filter: { metadata: { namespace: 'docs' } } });
      const deleted = await store.deleteByFilter({
        sourceType: 'document',
        metadata: { source: '/a.md', namespace: 'docs' },
      });

      expect(deleted.success).toBe(true);
      const [searchSql, searchParams] = pool.query.mock.calls[0];
      expect(searchSql).toContain('metadata @> $2::jsonb');
      expect(searchParams?.[1]).toBe('{"namespace":"docs"}');
      const [deleteSql, deleteParams] = pool.query.mock.calls[1];
      expect(deleteSql.replace(/\s+/g, ' ')).toBe(
        'DELETE FROM cogitator.embeddings WHERE TRUE AND source_type = $1 AND metadata @> $2::jsonb'
      );
      expect(deleteParams).toEqual(['document', '{"source":"/a.md","namespace":"docs"}']);
    });

    it('refuses a delete filter without conditions', async () => {
      const store = adapter(2);
      await store.connect();
      pool.query.mockClear();

      const deleted = await store.deleteByFilter({});

      expect(deleted.success).toBe(false);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
