/**
 * Schema versions of the Postgres stores, kept in `<schema>.cogitator_schema_migrations`, and the
 * lock that keeps processes setting a schema up at once from racing
 */

import type { SqlQueryable } from './pgvector';

/** A pool that hands out one connection for a transaction */
export interface SqlPool {
  connect(): Promise<SqlQueryable & { release(error?: Error | boolean): void }>;
}

/**
 * Runs `work` on one connection while it holds a session lock on `key`, so processes doing the
 * same setup at once take turns instead of racing on `CREATE ... IF NOT EXISTS`. Statements run
 * on their own, so one that fails does not undo the others.
 */
export async function withSetupLock<T>(
  pool: SqlPool,
  key: string,
  work: (db: SqlQueryable) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    try {
      return await work(client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch {
        broken = true;
      }
    }
  } finally {
    client.release(broken);
  }
}

/**
 * Brings `component` of `schema` to `version`. Under a lock per schema and component, so
 * processes connecting at once take turns, it runs `apply` and records the version, all in one
 * transaction, unless the schema already has this version or a later one and `present` finds
 * its tables in place. `apply` must bring any earlier layout, also one from before versions were
 * recorded, up to `version`.
 *
 * @returns whether `apply` ran
 */
export async function ensureSchemaVersion(
  db: SqlQueryable,
  schema: string,
  component: string,
  version: number,
  apply: (db: SqlQueryable) => Promise<void>,
  present: (db: SqlQueryable) => Promise<boolean> = async () => true
): Promise<boolean> {
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${schema}.${component}`]);
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.cogitator_schema_migrations (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const current = await db.query(
      `SELECT version FROM ${schema}.cogitator_schema_migrations WHERE component = $1`,
      [component]
    );
    const recorded = current.rows[0]?.version;
    if (typeof recorded === 'number' && recorded >= version && (await present(db))) {
      await db.query('COMMIT');
      return false;
    }
    await apply(db);
    await db.query(
      `INSERT INTO ${schema}.cogitator_schema_migrations (component, version) VALUES ($1, $2)
       ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at = NOW()`,
      [component, version]
    );
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
