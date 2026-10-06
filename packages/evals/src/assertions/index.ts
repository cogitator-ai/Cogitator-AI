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

/** Run-wide figures of a suite run */
export interface EvalStats {
  /** Cases run */
  total: number;
  /** Cases whose every attempt failed or timed out (`error` set on the result) */
  errors?: number;
  /** Metric scores that failed (`error` set on the score) and count as 0 */
  metricErrors?: number;
  /** Wall time of the run, in milliseconds */
  duration: number;
  /** USD spent: `targetCost` plus `judgeCost` */
  cost: number;
  /** USD the target spent, over every attempt that reported usage */
  targetCost?: number;
  /** USD the LLM judge spent */
  judgeCost?: number;
}

export type AssertionFn = (
  aggregated: Record<string, AggregatedMetric>,
  stats: EvalStats
) => AssertionResult;

export { threshold } from './threshold';
export { noRegression } from './regression';
export { assertion } from './custom';
