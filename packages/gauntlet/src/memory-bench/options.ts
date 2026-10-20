import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { answerKey } from './runner.js';
import type { BenchAnswer } from './types.js';

/** A command line mistake: reported with the help, not as a crash. */
export class UsageError extends Error {}

/** `value` of `--flag` as a positive number, an integer when `integer` is set. */
export function positive(flag: string, value: string, integer = false): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) {
    throw new UsageError(
      `--${flag} takes a positive ${integer ? 'integer' : 'number'}, not ${value}`
    );
  }
  return number;
}

/** `--sample`: dataset=size pairs, each size a positive integer. */
export function parseSample(spec: string | undefined): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const part of spec?.split(',') ?? []) {
    const [id, size, ...rest] = part.split('=');
    if (!id?.trim() || size === undefined || rest.length > 0) {
      throw new UsageError(`--sample takes dataset=size pairs, not ${part}`);
    }
    sizes.set(id.trim(), positive('sample', size, true));
  }
  return sizes;
}

/** The names in a comma-separated list, each one of `known`. */
export function pick<T extends string>(flag: string, list: string, known: readonly T[]): T[] {
  return list
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      if (!(known as readonly string[]).includes(name)) {
        throw new UsageError(`--${flag}: unknown ${name}, one of ${known.join(', ')}`);
      }
      return name as T;
    });
}

/** The records of a JSONL file, a line cut short by a killed run skipped. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

/** The last record per key: a question answered again replaces its earlier answer. */
export function latest<T extends BenchAnswer>(records: readonly T[]): Map<string, T> {
  const byKey = new Map<string, T>();
  for (const record of records) {
    byKey.set(answerKey(record.dataset, record.questionId, record.strategy), record);
  }
  return byKey;
}
