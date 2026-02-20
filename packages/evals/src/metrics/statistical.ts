import type { EvalCaseResult, MetricScore, StatisticalMetricFn } from './types';
import { aggregate, mean } from '../stats';

function createStatisticalFn(
  name: string,
  fn: (results: EvalCaseResult[]) => MetricScore
): StatisticalMetricFn {
  const statFn = fn as StatisticalMetricFn;
  statFn.metricName = name;
  return statFn;
}

export function latency(): StatisticalMetricFn {
  return createStatisticalFn('latency', (results: EvalCaseResult[]) => {
    const durations = results.map((r) => r.duration);
    const stats = aggregate(durations);

    return {
      name: 'latency',
      score: 0,
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

export function cost(): StatisticalMetricFn {
  return createStatisticalFn('cost', (results: EvalCaseResult[]) => {
    const costs = results.filter((r) => r.usage).map((r) => r.usage!.cost);

    if (costs.length === 0) {
      return {
        name: 'cost',
        score: 0,
        metadata: { total: 0, mean: 0, median: 0, min: 0, max: 0 },
      };
    }

    const stats = aggregate(costs);
    let total = 0;
    for (const c of costs) {
      total += c;
    }

    return {
      name: 'cost',
      score: 0,
      metadata: {
        total,
        mean: stats.mean,
        median: stats.median,
        min: stats.min,
        max: stats.max,
      },
    };
  });
}

export function tokenUsage(): StatisticalMetricFn {
  return createStatisticalFn('tokenUsage', (results: EvalCaseResult[]) => {
    const withUsage = results.filter((r) => r.usage);

    if (withUsage.length === 0) {
      return {
        name: 'tokenUsage',
        score: 0,
        metadata: { totalInput: 0, totalOutput: 0, totalTokens: 0, meanInput: 0, meanOutput: 0 },
      };
    }

    const inputTokens = withUsage.map((r) => r.usage!.inputTokens);
    const outputTokens = withUsage.map((r) => r.usage!.outputTokens);

    let totalInput = 0;
    let totalOutput = 0;
    for (let i = 0; i < withUsage.length; i++) {
      totalInput += inputTokens[i];
      totalOutput += outputTokens[i];
    }

    return {
      name: 'tokenUsage',
      score: 0,
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
