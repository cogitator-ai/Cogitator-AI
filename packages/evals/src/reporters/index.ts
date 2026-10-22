import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { consoleReport } from './console';
import { jsonReport } from './json';
import { csvReport } from './csv';
import { ciReport } from './ci';
import { junitReport } from './junit';
import { githubReport } from './github';
import type { EvalStats } from '../assertions';
import type { EvalToolCall, EvalToolResult, EvalTurnResult, Passage } from '../metrics/types';

export interface AggregatedMetric {
  name: string;
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  p50: number;
  p95: number;
  p99: number;
  /** Cases the metric was scored on: errored cases are not scored */
  count?: number;
  /** Extra figures a statistical metric reports, such as the total cost */
  metadata?: Record<string, unknown>;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  message: string;
  actual?: number;
  expected?: number;
}

/** A case result as the reporters get it */
export interface ReportedCase {
  case: { input: string; expected?: string };
  output: string;
  duration: number;
  /** Why the case has no output: every attempt failed or timed out */
  error?: string;
  /** The agent's answer stopped at its output token limit */
  truncated?: boolean;
  /** Tool calls used up the agent's `maxIterations` before it answered */
  iterationLimitReached?: boolean;
  /** The run paused for tool approvals, so `output` holds no answer */
  paused?: boolean;
  /** The tool calls of the run, over every turn */
  toolCalls?: readonly EvalToolCall[];
  /** What the tool calls returned, over every turn */
  toolResults?: readonly EvalToolResult[];
  /** The passages the run retrieved */
  retrieved?: readonly Passage[];
  /** Each turn of a multi-turn case */
  turns?: readonly EvalTurnResult[];
  scores: Array<{ name: string; score: number; details?: string; error?: string }>;
  /** Every run of the case when the suite ran several trials, the first being the case itself */
  trials?: readonly ReportedCase[];
}

export interface EvalSuiteResult {
  results: ReportedCase[];
  aggregated: Record<string, AggregatedMetric>;
  assertions: AssertionResult[];
  stats: EvalStats;
}

export type ReporterType = 'console' | 'json' | 'csv' | 'ci' | 'junit' | 'github';
export type ReporterOptions = {
  /**
   * Base path of file reports. Each file reporter writes it with its own
   * extension, so `./reports/eval` gives `eval.json`, `eval.csv` and `eval.xml`.
   */
  path?: string;
};

const DEFAULT_BASE = 'eval-report';

/** The file a reporter writes: the base path with the reporter's extension. */
export function reportPath(base: string | undefined, extension: 'json' | 'csv' | 'xml'): string {
  const stem = (base ?? DEFAULT_BASE).replace(/\.(json|csv|xml)$/i, '');
  return `${stem}.${extension}`;
}

function prepare(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/**
 * Runs the reporters in the order given, except `ci`, which runs last so its verdict is the
 * final line of the output. `ci` sets `process.exitCode` to 1 when an assertion failed instead
 * of ending the process, so output still flushes and later hooks still run.
 */
export function report(
  result: EvalSuiteResult,
  type: ReporterType | ReporterType[],
  options?: ReporterOptions
): void {
  const types = Array.isArray(type) ? type : [type];
  const ordered = [...types.filter((t) => t !== 'ci'), ...types.filter((t) => t === 'ci')];

  for (const t of ordered) {
    switch (t) {
      case 'console':
        consoleReport(result);
        break;
      case 'json':
        jsonReport(result, { path: prepare(reportPath(options?.path, 'json')) });
        break;
      case 'csv':
        csvReport(result, { path: prepare(reportPath(options?.path, 'csv')) });
        break;
      case 'junit':
        junitReport(result, { path: prepare(reportPath(options?.path, 'xml')) });
        break;
      case 'github':
        githubReport(result);
        break;
      case 'ci':
        ciReport(result);
        break;
    }
  }
}

export { consoleReport } from './console';
export { jsonReport } from './json';
export { csvReport } from './csv';
export { ciReport } from './ci';
export { junitReport } from './junit';
export { githubReport } from './github';
