import { describe, it, expect, vi } from 'vitest';
import {
  detectVectorSearchTuning,
  ensureHnswCosineIndex,
  vectorColumnPlan,
  type SqlQueryable,
} from '../adapters/pgvector';
import { attempt, ensureSchemaVersion, withSetupTransaction } from '../adapters/schema-version';

const target = { schema: 'app', table: 'embeddings', column: 'vector', index: 'idx_vec' };

function database(existingIndex?: string) {
  const queries: string[] = [];
  const db: SqlQueryable = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('pg_indexes')) {
        return { rows: existingIndex ? [{ indexdef: existingIndex }] : [] };
      }
      return { rows: [] };
    }),
  };
  return { db, queries };
}

describe('vectorColumnPlan', () => {
  it('indexes vectors of up to 2000 dimensions as they are', () => {
    const plan = vectorColumnPlan('vector', 1536, { halfvec: true });
    expect(plan.opclass).toBe('vector_cosine_ops');
    expect(plan.indexed).toBe('vector');
    expect(plan.distance('$1')).toBe('vector <=> $1');
  });

  it('indexes vectors of up to 4000 dimensions as halfvec, and compares the same cast', () => {
    const plan = vectorColumnPlan('vector', 3072, { halfvec: true });
    expect(plan.opclass).toBe('halfvec_cosine_ops');
    expect(plan.indexed).toBe('(vector::halfvec(3072))');
    expect(plan.distance('$1')).toBe('(vector::halfvec(3072)) <=> $1::halfvec(3072)');
  });

  it('leaves larger vectors, or halfvec without pgvector 0.7, without an index', () => {
    expect(vectorColumnPlan('vector', 3072, { halfvec: false }).opclass).toBeUndefined();
    const huge = vectorColumnPlan('vector', 5000, { halfvec: true });
    expect(huge.opclass).toBeUndefined();
    expect(huge.distance('$1')).toBe('vector <=> $1');
  });
});

describe('ensureHnswCosineIndex', () => {
  it('builds a halfvec index for 3072 dimensions', async () => {
    const { db, queries } = database();

    await ensureHnswCosineIndex(db, { ...target, dimensions: 3072 }, { halfvec: true });

    expect(queries.at(-1)).toBe(
      'CREATE INDEX IF NOT EXISTS idx_vec ON app.embeddings USING hnsw ((vector::halfvec(3072)) halfvec_cosine_ops)'
    );
  });

  it('keeps an HNSW index that exists and rebuilds one of another access method', async () => {
    const hnsw = database(
      'CREATE INDEX idx_vec ON app.embeddings USING hnsw (((vector)::halfvec(3072)) halfvec_cosine_ops)'
    );
    await ensureHnswCosineIndex(hnsw.db, { ...target, dimensions: 3072 }, { halfvec: true });
    expect(hnsw.queries.some((q) => q.startsWith('DROP') || q.startsWith('CREATE'))).toBe(false);

    const ivfflat = database(
      'CREATE INDEX idx_vec ON app.embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists=100)'
    );
    await ensureHnswCosineIndex(ivfflat.db, { ...target, dimensions: 3072 }, { halfvec: true });
    expect(ivfflat.queries.slice(-2)).toEqual([
      'DROP INDEX IF EXISTS app.idx_vec',
      'CREATE INDEX IF NOT EXISTS idx_vec ON app.embeddings USING hnsw ((vector::halfvec(3072)) halfvec_cosine_ops)',
    ]);
  });

  it('builds nothing for vectors too large to index', async () => {
    const { db, queries } = database();

    const plan = await ensureHnswCosineIndex(
      db,
      { ...target, dimensions: 5000 },
      { halfvec: true }
    );

    expect(plan.opclass).toBeUndefined();
    expect(queries.some((q) => q.startsWith('CREATE'))).toBe(false);
  });
});

describe('detectVectorSearchTuning', () => {
  it.each([
    ['0.6.2', { iterativeScan: false, halfvec: false }],
    ['0.7.4', { iterativeScan: false, halfvec: true }],
    ['0.8.0', { iterativeScan: true, halfvec: true }],
  ])('reads pgvector %s', async (version, expected) => {
    const db: SqlQueryable = { query: async () => ({ rows: [{ extversion: version }] }) };
    expect(await detectVectorSearchTuning(db)).toEqual(expected);
  });
});

describe('ensureSchemaVersion', () => {
  function connection(recorded?: number) {
    const queries: string[] = [];
    const db: SqlQueryable = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        if (sql.includes('SELECT version FROM')) {
          return { rows: recorded === undefined ? [] : [{ version: recorded }] };
        }
        return { rows: [] };
      }),
    };
    return { db, queries };
  }

  it('applies and records a version the schema does not have yet', async () => {
    const { db, queries } = connection(undefined);
    const apply = vi.fn(async (q: SqlQueryable) => {
      await q.query('CREATE TABLE app.things (id TEXT)');
    });

    expect(await ensureSchemaVersion(db, 'app', 'memory', 2, apply)).toBe(true);

    expect(queries).toContain('CREATE TABLE app.things (id TEXT)');
    expect(queries.at(-1)).toMatch(/^INSERT INTO app\.cogitator_schema_migrations/);
  });

  it('skips a version the schema has, or a later one, while its tables are there', async () => {
    for (const recorded of [2, 3]) {
      const { db } = connection(recorded);
      const apply = vi.fn(async () => undefined);
      expect(await ensureSchemaVersion(db, 'app', 'memory', 2, apply)).toBe(false);
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it('applies a recorded version again when its tables are gone', async () => {
    const { db } = connection(2);
    const apply = vi.fn(async () => undefined);

    expect(await ensureSchemaVersion(db, 'app', 'memory', 2, apply, async () => false)).toBe(true);
    expect(apply).toHaveBeenCalled();
  });
});

describe('withSetupTransaction and attempt', () => {
  function pool(failOn?: RegExp) {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (failOn?.test(sql)) throw new Error('boom');
        return { rows: [] };
      }),
      release,
    };
    return { pool: { connect: async () => client }, queries, release };
  }

  it('runs the setup in one transaction holding a lock', async () => {
    const { pool: db, queries, release } = pool();

    await withSetupTransaction(db, 'app.setup', async (q) => {
      await q.query('CREATE TABLE app.things (id TEXT)');
    });

    expect(queries).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'CREATE TABLE app.things (id TEXT)',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledWith(false);
  });

  it('rolls the setup back when it fails, and lets a step fail in a savepoint', async () => {
    const { pool: db, queries } = pool(/CREATE EXTENSION|CREATE TABLE app\.broken/);
    let stepError: Error | undefined;

    await expect(
      withSetupTransaction(db, 'app.setup', async (q) => {
        stepError = await attempt(q, () => q.query('CREATE EXTENSION vector'));
        await q.query('CREATE TABLE app.broken (id TEXT)');
      })
    ).rejects.toThrow('boom');

    expect(stepError?.message).toBe('boom');
    expect(queries.filter((q) => q.includes('SAVEPOINT')).map((q) => q.split(' ')[0])).toEqual([
      'SAVEPOINT',
      'ROLLBACK',
    ]);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
});
