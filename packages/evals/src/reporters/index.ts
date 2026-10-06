import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { consoleReport } from './console';
import { jsonReport } from './json';
import { csvReport } from './csv';
import { ciReport } from './ci';
import type { EvalStats } from '../assertions';

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

export interface EvalSuiteResult {
  results: Array<{
    case: { input: string; expected?: string };
    output: string;
    duration: number;
    /** Why the case has no output: every attempt failed or timed out */
    error?: string;
    scores: Array<{ name: string; score: number; details?: string; error?: string }>;
  }>;
  aggregated: Record<string, AggregatedMetric>;
  assertions: AssertionResult[];
  stats: EvalStats;
}

export type ReporterType = 'console' | 'json' | 'csv' | 'ci';
export type ReporterOptions = {
  /**
   * Base path of file reports. Each file reporter writes it with its own
   * extension, so `./reports/eval` gives `eval.json` and `eval.csv`.
   */
  path?: string;
};

const DEFAULT_BASE = 'eval-report';

/** The file a reporter writes: the base path with the reporter's extension. */
export function reportPath(base: string | undefined, extension: 'json' | 'csv'): string {
  const stem = (base ?? DEFAULT_BASE).replace(/\.(json|csv)$/i, '');
  return `${stem}.${extension}`;
}

function prepare(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/**
 * Runs the reporters in the order given, except `ci`, which runs last because
 * it ends the process when an assertion failed.
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
