import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { EvalCase } from '../schema';
import type { EvalPrompt, ScoredCaseResult } from '../metrics/types';
import type { AggregatedMetric, AssertionResult } from '../assertions';
import { canonicalJson, fingerprint, toJson } from './json';
import { EVAL_RUN_FORMAT, EVAL_RUN_VERSION, EvalRunSchema } from './schema';
import type { EvalRun, EvalRunConfig, JsonMetadata } from './schema';
import type { z } from 'zod';

/** A saved run, or a suite result that turns into one */
export type EvalRunSource = EvalRun | { toRun(): EvalRun };

/** Everything a run file records of a finished suite run */
export interface RunRecord {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  name?: string;
  metadata?: JsonMetadata;
  cases: readonly EvalCase[];
  config: EvalRunConfig;
  results: readonly ScoredCaseResult[];
  aggregated: Record<string, AggregatedMetric>;
  assertions: readonly AssertionResult[];
  stats: EvalRun['stats'];
}

/** A run id that sorts by start time: `20261022T101530123Z-1a2b3c4d` */
export function newRunId(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

/** The stable key a case is matched by across runs: its input, turns and expected answer */
export function caseKey(evalCase: Pick<EvalCase, 'input' | 'turns' | 'expected'>): string {
  return fingerprint({ input: evalCase.input, turns: evalCase.turns, expected: evalCase.expected });
}

/** The distinct versioned instructions the runs of the cases used, in the order first seen */
function promptsUsed(results: readonly ScoredCaseResult[]): EvalPrompt[] {
  const seen = new Map<string, EvalPrompt>();
  const add = (prompt: EvalPrompt | undefined) => {
    if (prompt) seen.set(canonicalJson(prompt), prompt);
  };
  for (const result of results) {
    for (const trial of result.trials ?? [result]) {
      add(trial.prompt);
      for (const turn of trial.turns ?? []) add(turn.prompt);
    }
  }
  return [...seen.values()];
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join(', ');
}

/** The run file of a finished suite run, every value as JSON keeps it */
export function buildRun(record: RunRecord): EvalRun {
  const { results } = record;
  const draft = {
    format: EVAL_RUN_FORMAT,
    version: EVAL_RUN_VERSION,
    runId: record.runId,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt.toISOString(),
    name: record.name,
    metadata: record.metadata,
    dataset: { fingerprint: fingerprint(record.cases), cases: record.cases.length },
    config: record.config,
    prompts: promptsUsed(results),
    results: results.map((result) => ({ ...result, caseKey: caseKey(result.case) })),
    aggregated: record.aggregated,
    assertions: record.assertions,
    stats: record.stats,
  };
  const parsed = EvalRunSchema.safeParse(toJson(draft));
  if (!parsed.success) {
    throw new Error(`Cannot record the run: ${issuesOf(parsed.error)}`);
  }
  return parsed.data;
}

/** The run of a source: the run itself, or a suite result's `toRun()` */
export function runOf(source: EvalRunSource): EvalRun {
  return 'toRun' in source && typeof source.toRun === 'function'
    ? source.toRun()
    : (source as EvalRun);
}

/**
 * Validates a parsed run file. Throws naming `origin` when it is not a run file, when it is of
 * another format version, or when a field does not fit the format
 */
export function parseRun(value: unknown, origin: string): EvalRun {
  const head =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (head.format !== EVAL_RUN_FORMAT) {
    throw new Error(`${origin} is not an eval run file: its format is not '${EVAL_RUN_FORMAT}'`);
  }
  if (head.version !== EVAL_RUN_VERSION) {
    throw new Error(
      `${origin} is an eval run file of version ${String(head.version)}, this version of @cogitator-ai/evals reads version ${EVAL_RUN_VERSION}`
    );
  }
  const parsed = EvalRunSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${origin} is not a valid eval run file: ${issuesOf(parsed.error)}`);
  }
  return parsed.data;
}

/** Reads and validates a run file written by `result.saveRun()` or a `RunStore` */
export function loadRun(path: string): EvalRun {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read the run file ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error });
  }
  return parseRun(value, path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates a run, so its id can never lead outside the directory, then writes its run file
 * and returns its path: `<target>/<runId>.json` when `target` is a directory
 * or ends with a path separator, `target` itself otherwise. Missing directories are created
 */
export function writeRun(run: EvalRun, target: string): string {
  const checked = EvalRunSchema.safeParse(toJson(run));
  if (!checked.success) {
    throw new Error(`Cannot write the run: ${issuesOf(checked.error)}`);
  }
  const intoDirectory = target.endsWith('/') || target.endsWith(sep) || isDirectory(target);
  const path = intoDirectory ? join(target, `${checked.data.runId}.json`) : target;
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(partial, `${JSON.stringify(checked.data, null, 2)}\n`, 'utf-8');
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return path;
}
