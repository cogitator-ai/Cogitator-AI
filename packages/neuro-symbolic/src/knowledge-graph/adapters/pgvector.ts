/**
 * pgvector helpers for the Postgres graph adapter: the vector index it builds and the settings
 * a nearest-neighbour query runs with. They match the ones `@cogitator-ai/memory` uses.
 */

export interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface HnswIndexTarget {
  schema: string;
  table: string;
  column: string;
  index: string;
}

/** What the installed pgvector lets a search tune on its HNSW index. */
export interface VectorSearchTuning {
  /** pgvector 0.8 and later keep scanning the index until enough rows pass the filters. */
  iterativeScan: boolean;
}

const DEFAULT_EF_SEARCH = 40;
const MAX_EF_SEARCH = 1000;

/**
 * Makes sure `target.index` is an HNSW cosine index. HNSW needs no training rows, so unlike IVFFlat
 * it can be built on the still empty table at connect time and keeps full recall as rows arrive.
 * An index of the same name with another access method, such as the IVFFlat index earlier versions
 * built, is dropped and rebuilt. An HNSW index that already exists is left alone, so it can be
 * built ahead of a deploy with `CREATE INDEX CONCURRENTLY`.
 */
export async function ensureHnswCosineIndex(
  db: SqlQueryable,
  target: HnswIndexTarget
): Promise<void> {
  const { schema, table, column, index } = target;
  const existing = await db.query(
    'SELECT indexdef FROM pg_indexes WHERE schemaname = lower($1) AND indexname = lower($2)',
    [schema, index]
  );
  const definition = existing.rows[0]?.indexdef;
  if (typeof definition === 'string') {
    if (/\busing hnsw\b/i.test(definition)) return;
    await db.query(`DROP INDEX IF EXISTS ${schema}.${index}`);
  }
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${index} ON ${schema}.${table} USING hnsw (${column} vector_cosine_ops)`
  );
}

/** Reads the installed pgvector version and what it supports. */
export async function detectVectorSearchTuning(db: SqlQueryable): Promise<VectorSearchTuning> {
  const result = await db.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const version = result.rows[0]?.extversion;
  if (typeof version !== 'string') return { iterativeScan: false };
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return { iterativeScan: major > 0 || minor >= 8 };
}

/**
 * How one nearest-neighbour search runs on an HNSW index. The index returns at most
 * `hnsw.ef_search` candidates (40 by default), so a larger limit would be cut short, and rows a
 * filter rejects would be missing from the result. `sql` grows the candidate list with the limit
 * for the current transaction and, where pgvector supports it, keeps the scan going in strict
 * distance order until enough rows pass. `candidates` is how many rows to fetch, at least as many
 * as the index computes anyway: taking all of them and ordering equally distant rows by id makes
 * the result independent of whether Postgres plans the index or an exact scan, so a small limit
 * returns a prefix of a large one.
 */
export function hnswSearchSettings(
  limit: number,
  tuning: VectorSearchTuning
): { sql: string; params: unknown[]; candidates: number } {
  const efSearch = Math.min(MAX_EF_SEARCH, Math.max(DEFAULT_EF_SEARCH, Math.ceil(limit)));
  const iterative = tuning.iterativeScan
    ? ", set_config('hnsw.iterative_scan', 'strict_order', true)"
    : '';
  return {
    sql: `SELECT set_config('hnsw.ef_search', $1, true)${iterative}`,
    params: [String(efSearch)],
    candidates: Math.max(efSearch, Math.ceil(limit)),
  };
}
