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
  /** Size of the vectors in the column, which decides how it is indexed */
  dimensions: number;
}

/** What the installed pgvector lets a search tune on its HNSW index. */
export interface VectorSearchTuning {
  /** pgvector 0.8 and later keep scanning the index until enough rows pass the filters. */
  iterativeScan: boolean;
  /** pgvector 0.7 and later index `halfvec`, which takes vectors of up to 4000 dimensions. */
  halfvec: boolean;
}

/** Most dimensions an HNSW index takes on a `vector` column */
export const MAX_VECTOR_INDEX_DIMENSIONS = 2000;

/** Most dimensions an HNSW index takes on `halfvec`, the half-precision type */
export const MAX_HALFVEC_INDEX_DIMENSIONS = 4000;

/**
 * How a column of `dimensions`-sized vectors is indexed and searched. Up to 2000 dimensions the
 * index is on the column itself. Up to 4000 it is on the column cast to `halfvec`, which keeps
 * the stored vectors at full precision and compares them at half: a search must then compare
 * the same cast for the index to serve it. Larger vectors have no index and are searched exactly.
 */
export interface VectorColumnPlan {
  /** The operator class of its HNSW index, none when it cannot have one */
  opclass?: 'vector_cosine_ops' | 'halfvec_cosine_ops';
  /** The indexed expression */
  indexed: string;
  /** The cosine distance between the column and the vector in `parameter`, as the index computes it */
  distance(parameter: string): string;
}

export function vectorColumnPlan(
  column: string,
  dimensions: number,
  tuning: Pick<VectorSearchTuning, 'halfvec'>
): VectorColumnPlan {
  if (dimensions <= MAX_VECTOR_INDEX_DIMENSIONS) {
    return {
      opclass: 'vector_cosine_ops',
      indexed: column,
      distance: (parameter) => `${column} <=> ${parameter}`,
    };
  }
  if (dimensions <= MAX_HALFVEC_INDEX_DIMENSIONS && tuning.halfvec) {
    const cast = `(${column}::halfvec(${dimensions}))`;
    return {
      opclass: 'halfvec_cosine_ops',
      indexed: cast,
      distance: (parameter) => `${cast} <=> ${parameter}::halfvec(${dimensions})`,
    };
  }
  return { indexed: column, distance: (parameter) => `${column} <=> ${parameter}` };
}

const DEFAULT_EF_SEARCH = 40;
const MAX_EF_SEARCH = 1000;

/**
 * Makes sure `target.index` is an HNSW cosine index, built as {@link vectorColumnPlan} plans for
 * the column. HNSW needs no training rows, so unlike IVFFlat it can be built on the still empty
 * table at connect time and keeps full recall as rows arrive. An index of the same name with
 * another access method, such as the IVFFlat index earlier versions built, is dropped and rebuilt.
 * An HNSW index that already exists is left alone, so it can be built ahead of a deploy with
 * `CREATE INDEX CONCURRENTLY`. A column too large for any index gets none.
 *
 * @returns the plan the column is searched with
 */
export async function ensureHnswCosineIndex(
  db: SqlQueryable,
  target: HnswIndexTarget,
  tuning: Pick<VectorSearchTuning, 'halfvec'>
): Promise<VectorColumnPlan> {
  const { schema, table, column, index } = target;
  const plan = vectorColumnPlan(column, target.dimensions, tuning);
  const existing = await db.query(
    'SELECT indexdef FROM pg_indexes WHERE schemaname = lower($1) AND indexname = lower($2)',
    [schema, index]
  );
  const definition = existing.rows[0]?.indexdef;
  if (typeof definition === 'string') {
    if (/\busing hnsw\b/i.test(definition)) return plan;
    await db.query(`DROP INDEX IF EXISTS ${schema}.${index}`);
  }
  if (plan.opclass) {
    await db.query(
      `CREATE INDEX IF NOT EXISTS ${index} ON ${schema}.${table} USING hnsw (${plan.indexed} ${plan.opclass})`
    );
  }
  return plan;
}

/** Reads the installed pgvector version and what it supports. */
export async function detectVectorSearchTuning(db: SqlQueryable): Promise<VectorSearchTuning> {
  const result = await db.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const version = result.rows[0]?.extversion;
  if (typeof version !== 'string') return { iterativeScan: false, halfvec: false };
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return { iterativeScan: major > 0 || minor >= 8, halfvec: major > 0 || minor >= 7 };
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
