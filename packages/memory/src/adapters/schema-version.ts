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
 * Runs `work` in one transaction that holds a lock on `key`, so processes doing the same setup at
 * once take turns instead of racing on `CREATE ... IF NOT EXISTS`. The lock goes with the
 * transaction, which a pooler in transaction mode (PgBouncer, Supabase, Neon) keeps on one
 * server connection, and is let go however the transaction ends. Wrap a statement that may fail
 * without failing the setup in {@link attempt}.
 */
export async function withSetupTransaction<T>(
  pool: SqlPool,
  key: string,
  work: (db: SqlQueryable) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

let savepoints = 0;

/**
 * Runs `work` inside a savepoint of the current transaction: when it fails, what it did is undone
 * and the transaction goes on. Returns the error, or undefined when it succeeded.
 */
export async function attempt(
  db: SqlQueryable,
  work: () => Promise<unknown>
): Promise<Error | undefined> {
  const name = `cogitator_setup_${++savepoints}`;
  await db.query(`SAVEPOINT ${name}`);
  try {
    await work();
    await db.query(`RELEASE SAVEPOINT ${name}`);
    return undefined;
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Brings `component` of `schema` to `version`, inside the caller's transaction (see
 * {@link withSetupTransaction}): it runs `apply` and records the version, unless the schema
 * already has this version or a later one and `present` finds its tables in place. `apply` must
 * bring any earlier layout, also one from before versions were recorded, up to `version`.
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
  if (typeof recorded === 'number' && recorded >= version && (await present(db))) return false;
  await apply(db);
  await db.query(
    `INSERT INTO ${schema}.cogitator_schema_migrations (component, version) VALUES ($1, $2)
     ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at = NOW()`,
    [component, version]
  );
  return true;
}
