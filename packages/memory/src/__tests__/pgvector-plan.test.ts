import { describe, it, expect, vi } from 'vitest';
import {
  detectVectorSearchTuning,
  ensureHnswCosineIndex,
  vectorColumnPlan,
  type SqlQueryable,
} from '../adapters/pgvector';
import { ensureSchemaVersion, withSetupLock } from '../adapters/schema-version';

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
  function connection(recorded?: number, failOn?: RegExp) {
    const queries: string[] = [];
    const db: SqlQueryable = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        if (failOn?.test(sql)) throw new Error('boom');
        if (sql.includes('SELECT version FROM')) {
          return { rows: recorded === undefined ? [] : [{ version: recorded }] };
        }
        return { rows: [] };
      }),
    };
    return { db, queries };
  }

  it('applies and records a version the schema does not have yet, under a lock', async () => {
    const { db, queries } = connection(undefined);
    const apply = vi.fn(async (q: SqlQueryable) => {
      await q.query('CREATE TABLE app.things (id TEXT)');
    });

    expect(await ensureSchemaVersion(db, 'app', 'memory', 2, apply)).toBe(true);

    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(queries).toContain('CREATE TABLE app.things (id TEXT)');
    expect(queries.some((q) => q.startsWith('INSERT INTO app.cogitator_schema_migrations'))).toBe(
      true
    );
    expect(queries.at(-1)).toBe('COMMIT');
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

  it('rolls back when applying fails, recording nothing', async () => {
    const { db, queries } = connection(1, /CREATE TABLE app\.things/);

    await expect(
      ensureSchemaVersion(db, 'app', 'memory', 2, async (q) => {
        await q.query('CREATE TABLE app.things (id TEXT)');
      })
    ).rejects.toThrow('boom');

    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.some((q) => q.startsWith('INSERT INTO'))).toBe(false);
  });
});

describe('withSetupLock', () => {
  it('holds a session lock around the work and releases it when the work fails', async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      release,
    };

    await expect(
      withSetupLock({ connect: async () => client }, 'app.setup', async () => {
        queries.push('work');
        throw new Error('setup failed');
      })
    ).rejects.toThrow('setup failed');

    expect(queries).toEqual([
      'SELECT pg_advisory_lock(hashtext($1))',
      'work',
      'SELECT pg_advisory_unlock(hashtext($1))',
    ]);
    expect(release).toHaveBeenCalledWith(false);
  });
});
