import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The part of a `pg` Pool or Client the Postgres stores use. */
export interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A table name a store accepts: an identifier, optionally schema-qualified. */
export const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

const DUPLICATE_OBJECT_CODES = new Set(['23505', '42P07', '42710']);

/**
 * Runs a `CREATE ... IF NOT EXISTS` statement. Two sessions creating the
 * same object at once can still collide on Postgres' catalog; by the retry
 * the object exists and the statement succeeds.
 */
export async function createIfMissing(client: PgClient, statement: string): Promise<void> {
  try {
    await client.query(statement);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (typeof code !== 'string' || !DUPLICATE_OBJECT_CODES.has(code)) throw error;
    await client.query(statement);
  }
}

/** A JSONB column: `pg` returns it parsed, other drivers may return the text. */
export function fromJson(data: unknown): unknown {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

let temporaryCounter = 0;

/**
 * Writes `content` to `path` through a temporary file and a rename, so a
 * crash never leaves half a file. The file is readable by its owner only,
 * since stores keep secrets in it.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${++temporaryCounter}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

/** Runs `task` after every task queued before it, so writes to one file never interleave. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
