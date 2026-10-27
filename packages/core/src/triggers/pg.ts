/** What the Postgres stores of triggers and the inbox share: the client, table names, schema */

/** The query method of a `pg` Pool or Client */
export interface TriggerStorePgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A table name a store accepts: an identifier, optionally schema-qualified */
export const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

const DUPLICATE_OBJECT_CODES = new Set(['23505', '42P07', '42710']);

function isDuplicateObject(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DUPLICATE_OBJECT_CODES.has(error.code)
  );
}

/**
 * Runs a `CREATE ... IF NOT EXISTS` statement. Two sessions creating the same object at the same
 * moment can still collide on Postgres' catalog; by the retry the object exists
 */
export async function createIfMissing(
  client: TriggerStorePgClient,
  statement: string
): Promise<void> {
  try {
    await client.query(statement);
  } catch (error) {
    if (!isDuplicateObject(error)) throw error;
    await client.query(statement);
  }
}

/** A JSONB column: `pg` returns it parsed, other drivers may return the text */
export function fromJson<T>(data: unknown): T {
  return (typeof data === 'string' ? JSON.parse(data) : data) as T;
}

/** Checks a table prefix */
export function tablePrefix(prefix: string, what: string): string {
  if (!TABLE_NAME.test(prefix)) throw new Error(`Invalid ${what} table prefix: ${prefix}`);
  return prefix;
}
