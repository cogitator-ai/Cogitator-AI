/**
 * Shared pieces of the Postgres stores: table names, schema creation and
 * reading JSONB columns.
 */

/** A table name a store accepts: an identifier, optionally schema-qualified. */
export const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

const DUPLICATE_OBJECT_CODES = new Set(['23505', '42P07', '42710']);

/**
 * Runs a `CREATE ... IF NOT EXISTS` statement. Two sessions creating the
 * same object at the same moment can still collide on Postgres' catalog
 * (unique_violation, duplicate_table, duplicate_object); by the retry the
 * object exists and the statement succeeds.
 */
export async function createIfMissing(
  client: { query(text: string, values?: unknown[]): Promise<unknown> },
  statement: string
): Promise<void> {
  try {
    await client.query(statement);
  } catch (error) {
    if (!isDuplicateObject(error)) throw error;
    await client.query(statement);
  }
}

function isDuplicateObject(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DUPLICATE_OBJECT_CODES.has(error.code)
  );
}

/** A JSONB column: `pg` returns it parsed, other drivers may return the text. */
export function fromJson<T>(data: unknown): T {
  return (typeof data === 'string' ? JSON.parse(data) : data) as T;
}
