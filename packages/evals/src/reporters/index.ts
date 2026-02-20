import { consoleReport } from './console';
import { jsonReport } from './json';
import { csvReport } from './csv';
import { ciReport } from './ci';

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
    scores: Array<{ name: string; score: number; details?: string }>;
  }>;
  aggregated: Record<string, AggregatedMetric>;
  assertions: AssertionResult[];
  stats: { total: number; duration: number; cost: number };
}

export type ReporterType = 'console' | 'json' | 'csv' | 'ci';
export type ReporterOptions = { path?: string };

export function report(
  result: EvalSuiteResult,
  type: ReporterType | ReporterType[],
  options?: ReporterOptions
): void {
  const types = Array.isArray(type) ? type : [type];

  for (const t of types) {
    switch (t) {
      case 'console':
        consoleReport(result);
        break;
      case 'json':
        jsonReport(result, { path: options?.path ?? 'eval-report.json' });
        break;
      case 'csv':
        csvReport(result, { path: options?.path ?? 'eval-report.csv' });
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
