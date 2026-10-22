import type { EvalCaseResult, MetricScore, StatisticalMetricFn, StatisticalScore } from './types';
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

export interface PassAtKOptions {
  /** Trials that may be drawn, a positive integer up to the suite's `trials` */
  k: number;
  /** The score at which a trial passes. Default: 1 */
  threshold?: number;
}

/** A `passAtK()` metric: the suite checks its metric and its `k` against its own setup */
export type PassAtKMetricFn = StatisticalMetricFn & {
  readonly passAtK: { readonly metric: string; readonly k: number; readonly threshold: number };
};

/** Whether a statistical metric is a `passAtK()` one */
export function isPassAtKMetric(metric: StatisticalMetricFn): metric is PassAtKMetricFn {
  return 'passAtK' in metric && typeof (metric as PassAtKMetricFn).passAtK === 'object';
}

/**
 * The chance that at least one of `k` trials drawn from `n`, `c` of which passed, passes:
 * 1 - C(n - c, k) / C(n, k), computed as a product so large counts do not overflow
 */
export function passAtKEstimate(n: number, c: number, k: number): number {
  if (n - c < k) return 1;
  let allFail = 1;
  for (let i = n - c + 1; i <= n; i++) allFail *= 1 - k / i;
  return 1 - allFail;
}

type TrialResult = EvalCaseResult & { scores?: readonly MetricScore[] };

/**
 * pass@k of a per-case metric over the suite's trials: for each case, the unbiased estimate of
 * the chance that at least one of `k` trials scores `threshold` or more, averaged over the cases
 * the metric scored at least one trial of. A trial that errored counts as a failure. Named
 * `passAtK(<metric>,<k>)`. The suite must run at least `k` trials and have the metric.
 */
export function passAtK(metricName: string, opts: PassAtKOptions): PassAtKMetricFn {
  const { k, threshold = 1 } = opts;
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`passAtK k must be a positive integer, got ${k}`);
  }
  if (!Number.isFinite(threshold)) {
    throw new Error(`passAtK threshold must be a finite number, got ${threshold}`);
  }
  const name = `passAtK(${metricName},${k})`;

  const fn = createStatisticalFn(name, (results: EvalCaseResult[]) => {
    const values: number[] = [];
    for (const result of results) {
      const trials: readonly TrialResult[] = result.trials ?? [result];
      if (trials.length < k) {
        throw new Error(
          `${name} needs at least ${k} trials per case, a case has ${trials.length}: run the suite with trials: ${k} or more`
        );
      }
      const scores = trials.map((trial) =>
        trial.error === undefined ? trial.scores?.find((s) => s.name === metricName) : undefined
      );
      if (scores.every((s) => s === undefined)) continue;
      const passed = scores.filter((s) => s !== undefined && s.score >= threshold).length;
      values.push(passAtKEstimate(trials.length, passed, k));
    }

    const metadata = { metric: metricName, k, threshold, cases: values.length };
    if (values.length === 0) {
      return {
        name,
        score: Number.NaN,
        details: `no case has a trial scored on ${metricName}`,
        metadata,
      };
    }
    return { name, score: mean(values), values, metadata };
  });

  Object.defineProperty(fn, 'passAtK', {
    value: Object.freeze({ metric: metricName, k, threshold }),
    writable: false,
  });
  return fn as PassAtKMetricFn;
}
