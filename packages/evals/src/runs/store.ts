import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_RUN_FORMAT } from './schema';
import type { EvalRun, JsonMetadata } from './schema';
import { loadRun, parseRun, runOf, writeRun } from './run';
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

/** A file `list()` and `latest()` passed over: what it is and why it was not read */
export interface SkippedRunFile {
  path: string;
  reason: string;
}

export interface RunStoreOptions {
  /**
   * Called for each `.json` entry `list()` and `latest()` skip: a directory, a file that cannot
   * be read or is not JSON, or a run file that is not valid (of another format version, or edited
   * by hand). Default: a process warning with the code `COGITATOR_EVALS_RUN_SKIPPED`
   */
  onSkip?: (skipped: SkippedRunFile) => void;
}

type FileRead =
  | { kind: 'run'; run: EvalRun }
  | { kind: 'other' }
  | { kind: 'gone' }
  | { kind: 'bad'; reason: string };

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnSkipped({ path, reason }: SkippedRunFile): void {
  process.emitWarning(`RunStore skipped ${path}: ${reason}`, {
    code: 'COGITATOR_EVALS_RUN_SKIPPED',
  });
}

/** What a run file path holds: a valid run, JSON of another kind, or something unreadable */
function readRunFile(path: string): FileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if (isGone(error)) return { kind: 'gone' };
    return { kind: 'bad', reason: errorMessage(error) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'bad', reason: 'not JSON' };
  }
  const format =
    typeof value === 'object' && value !== null ? (value as { format?: unknown }).format : null;
  if (format !== EVAL_RUN_FORMAT) return { kind: 'other' };
  try {
    return { kind: 'run', run: parseRun(value, path) };
  } catch (error) {
    return { kind: 'bad', reason: errorMessage(error) };
  }
}

/** Whether a listed entry is still a file: `null` when it is, the reason to skip it otherwise */
function notAFile(path: string): FileRead | null {
  try {
    return statSync(path).isFile() ? null : { kind: 'bad', reason: 'not a file' };
  } catch (error) {
    if (isGone(error)) return { kind: 'gone' };
    return { kind: 'bad', reason: errorMessage(error) };
  }
}

/**
 * Saved suite runs in a directory, one `<runId>.json` run file each. `list()` and `latest()` pass
 * over JSON files that are not run files, such as a baseline, and report the `.json` entries they
 * cannot read through `onSkip`, so one bad file never hides the other runs. `load(id)` is strict
 * and throws for a run file it cannot read
 */
export class RunStore {
  private readonly onSkip: (skipped: SkippedRunFile) => void;

  constructor(
    readonly directory: string,
    options: RunStoreOptions = {}
  ) {
    this.onSkip = options.onSkip ?? warnSkipped;
  }

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

  /**
   * The run with this id. Throws when the directory has none, and when its file cannot be read
   * or is not a valid run file
   */
  load(id: string): EvalRun {
    if (!RUN_ID.test(id)) throw new Error(`'${id}' is not a run id`);
    const path = join(this.directory, `${id}.json`);
    if (!existsSync(path)) throw new Error(`No run '${id}' in ${this.directory}`);
    return loadRun(path);
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
      if (isGone(error)) return [];
      throw error;
    }
    const entries: Array<{ run: EvalRun; path: string }> = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.directory, file);
      const read = notAFile(path) ?? readRunFile(path);
      if (read.kind === 'run') entries.push({ run: read.run, path });
      else if (read.kind === 'bad') this.onSkip({ path, reason: read.reason });
    }
    return entries.sort(
      (a, b) =>
        Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt) ||
        b.run.runId.localeCompare(a.run.runId)
    );
  }
}
