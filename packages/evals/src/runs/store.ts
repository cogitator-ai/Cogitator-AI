import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_RUN_FORMAT } from './schema';
import type { EvalRun, JsonMetadata } from './schema';
import { parseRun, runOf, writeRun } from './run';
import type { EvalRunSource } from './run';

/** A run as `RunStore.list()` shows it */
export interface RunSummary {
  id: string;
  name?: string;
  metadata?: JsonMetadata;
  startedAt: string;
  finishedAt: string;
  /** Cases run */
  cases: number;
  /** The mean of each aggregated metric, NaN for a metric no case was scored on */
  metrics: Record<string, number>;
  /** The run file */
  path: string;
}

/** Picks runs: by `name`, or by a predicate over their summaries */
export type RunFilter = { name?: string } | ((run: RunSummary) => boolean);

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function summaryOf(run: EvalRun, path: string): RunSummary {
  const metrics: Record<string, number> = {};
  for (const [name, aggregated] of Object.entries(run.aggregated)) metrics[name] = aggregated.mean;
  return {
    id: run.runId,
    ...(run.name !== undefined && { name: run.name }),
    ...(run.metadata !== undefined && { metadata: run.metadata }),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cases: run.dataset.cases,
    metrics,
    path,
  };
}

function matches(summary: RunSummary, filter: RunFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (typeof filter === 'function') return filter(summary);
  return filter.name === undefined || summary.name === filter.name;
}

/**
 * Saved suite runs in a directory, one `<runId>.json` run file each. Other JSON files in the
 * directory are ignored, while a file that claims to be a run file and is not valid throws
 */
export class RunStore {
  constructor(readonly directory: string) {}

  /** Writes the run file of a suite result or a run, returning its path */
  save(source: EvalRunSource): string {
    return writeRun(runOf(source), `${this.directory}/`);
  }

  /** The runs of the directory, newest first */
  list(filter?: RunFilter): RunSummary[] {
    return this.entries()
      .map(({ run, path }) => summaryOf(run, path))
      .filter((summary) => matches(summary, filter));
  }

  /** The run with this id. Throws when the directory has none */
  load(id: string): EvalRun {
    if (!RUN_ID.test(id)) throw new Error(`'${id}' is not a run id`);
    const path = join(this.directory, `${id}.json`);
    const run = this.read(path);
    if (!run) throw new Error(`No run '${id}' in ${this.directory}`);
    return run;
  }

  /** The newest run, of those the filter picks, undefined when there is none */
  latest(filter?: RunFilter): EvalRun | undefined {
    for (const { run, path } of this.entries()) {
      if (matches(summaryOf(run, path), filter)) return run;
    }
    return undefined;
  }

  private entries(): Array<{ run: EvalRun; path: string }> {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: Array<{ run: EvalRun; path: string }> = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.directory, file);
      const run = this.read(path);
      if (run) entries.push({ run, path });
    }
    return entries.sort(
      (a, b) =>
        Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt) ||
        b.run.runId.localeCompare(a.run.runId)
    );
  }

  /** The run in a file, undefined when the file is missing or holds other JSON */
  private read(path: string): EvalRun | undefined {
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    const format =
      typeof value === 'object' && value !== null ? (value as { format?: unknown }).format : null;
    return format === EVAL_RUN_FORMAT ? parseRun(value, path) : undefined;
  }
}
