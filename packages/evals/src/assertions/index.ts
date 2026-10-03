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

export type AssertionFn = (
  aggregated: Record<string, AggregatedMetric>,
  stats: { total: number; duration: number; cost: number }
) => AssertionResult;

export { threshold } from './threshold';
export { noRegression } from './regression';
export { assertion } from './custom';
