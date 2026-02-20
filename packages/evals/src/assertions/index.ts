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

export type AssertionFn = (
  aggregated: Record<string, AggregatedMetric>,
  stats: { total: number; duration: number; cost: number }
) => AssertionResult;

export { threshold } from './threshold';
export { noRegression } from './regression';
export { assertion } from './custom';
