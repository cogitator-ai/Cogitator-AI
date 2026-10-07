import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

function temporaryPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * Writes `value` as JSON so that a reader, or a process recovering after a
 * crash, finds the previous file or the new one, never a torn write: the JSON
 * goes to a temporary file first, which then replaces the target in one step.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = temporaryPath(filePath);
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Like `writeJsonAtomic`, but only when nothing is at `filePath` yet: the
 * first writer across processes wins, a later one gets `EEXIST`, and nobody
 * reads a half-written file.
 */
export async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  const temporary = temporaryPath(filePath);
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf-8');
    await fs.link(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
