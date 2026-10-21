/**
 * Schema versions of the Postgres stores, kept in `<schema>.schema_migrations`
 */

import type { SqlQueryable } from './pgvector';

/** A pool that hands out one connection for a transaction */
export interface SqlPool {
  connect(): Promise<SqlQueryable & { release(error?: Error | boolean): void }>;
}

/**
 * Brings `component` of `schema` to `version`. Under a lock per schema and component, so
 * processes connecting at once take turns, it runs `apply` and records the version, all in one
 * transaction, unless the schema already has this version or a later one. `apply` must bring
 * any earlier layout, also one from before versions were recorded, up to `version`.
 *
 * @returns whether `apply` ran
 */
export async function ensureSchemaVersion(
  pool: SqlPool,
  schema: string,
  component: string,
  version: number,
  apply: (db: SqlQueryable) => Promise<void>
): Promise<boolean> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${schema}.${component}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const current = await client.query(
      `SELECT version FROM ${schema}.schema_migrations WHERE component = $1`,
      [component]
    );
    const recorded = current.rows[0]?.version;
    if (typeof recorded === 'number' && recorded >= version) {
      await client.query('COMMIT');
      return false;
    }
    await apply(client);
    await client.query(
      `INSERT INTO ${schema}.schema_migrations (component, version) VALUES ($1, $2)
       ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at = NOW()`,
      [component, version]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
