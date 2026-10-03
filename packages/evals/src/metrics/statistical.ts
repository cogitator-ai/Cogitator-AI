import type { EvalCaseResult, StatisticalMetricFn, StatisticalScore } from './types';
import { aggregate, mean } from '../stats';

function createStatisticalFn(
  name: string,
  fn: (results: EvalCaseResult[]) => StatisticalScore
): StatisticalMetricFn {
  const statFn = fn as StatisticalMetricFn;
  statFn.metricName = name;
  return statFn;
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Run duration per case, in milliseconds. */
export function latency(): StatisticalMetricFn {
  return createStatisticalFn('latency', (results: EvalCaseResult[]) => {
    const durations = results.map((r) => r.duration);
    const stats = aggregate(durations);

    return {
      name: 'latency',
      score: stats.mean,
      values: durations,
      metadata: {
        p50: stats.p50,
        p95: stats.p95,
        p99: stats.p99,
        mean: stats.mean,
        median: stats.median,
        min: stats.min,
        max: stats.max,
      },
    };
  });
}

/** Cost per case, in USD, for cases that report usage. */
export function cost(): StatisticalMetricFn {
  return createStatisticalFn('cost', (results: EvalCaseResult[]) => {
    const costs = results.filter((r) => r.usage).map((r) => r.usage!.cost);
    const stats = aggregate(costs);

    return {
      name: 'cost',
      score: stats.mean,
      values: costs,
      metadata: {
        total: sum(costs),
        mean: stats.mean,
        median: stats.median,
        min: stats.min,
        max: stats.max,
        p95: stats.p95,
        p99: stats.p99,
      },
    };
  });
}

/** Total tokens per case, for cases that report usage. */
export function tokenUsage(): StatisticalMetricFn {
  return createStatisticalFn('tokenUsage', (results: EvalCaseResult[]) => {
    const withUsage = results.filter((r) => r.usage);
    const inputTokens = withUsage.map((r) => r.usage!.inputTokens);
    const outputTokens = withUsage.map((r) => r.usage!.outputTokens);
    const totals = withUsage.map((r) => r.usage!.inputTokens + r.usage!.outputTokens);
    const totalInput = sum(inputTokens);
    const totalOutput = sum(outputTokens);

    return {
      name: 'tokenUsage',
      score: mean(totals),
      values: totals,
      metadata: {
        totalInput,
        totalOutput,
        totalTokens: totalInput + totalOutput,
        meanInput: mean(inputTokens),
        meanOutput: mean(outputTokens),
      },
    };
  });
}
