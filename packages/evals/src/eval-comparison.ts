import { EvalSuite } from './eval-suite';
import type { EvalTarget, EvalSuiteResult } from './eval-suite';
import type { MetricFn, MetricScore, ScoredCaseResult, StatisticalMetricFn } from './metrics/types';
import type { JudgeConfigInput } from './schema';
import { EvalComparisonConfigSchema } from './schema';
import { Dataset } from './datasets';
import { pairedTTest } from './stats/t-test';
import { mcnemarsTest } from './stats/mcnemar';
import { mean } from './stats/percentiles';

export interface EvalComparisonOptions {
  dataset: Dataset;
  targets: {
    baseline: EvalTarget;
    challenger: EvalTarget;
  };
  metrics?: MetricFn[];
  statisticalMetrics?: StatisticalMetricFn[];
  judge?: JudgeConfigInput;
  concurrency?: number;
  timeout?: number;
  retries?: number;
  /**
   * Runs of each case on each side, as the suite's `trials`. A metric is compared on each case's
   * mean over its scored trials, and `passAtK()` statistical metrics see every trial
   */
  trials?: number;
  onProgress?: (progress: { target: string; completed: number; total: number }) => void;
}

export interface EvalComparisonRunOptions {
  /** Cancels both runs; `run()` rejects with the signal's reason */
  signal?: AbortSignal;
}

export interface MetricComparison {
  baseline: number;
  challenger: number;
  /** Cases compared: those at least one side scored, an errored side counting as a 0 */
  n: number;
  pValue: number;
  significant: boolean;
  winner: 'baseline' | 'challenger' | 'tie';
}

export interface ComparisonResult {
  summary: {
    winner: 'baseline' | 'challenger' | 'tie';
    metrics: Record<string, MetricComparison>;
  };
  baseline: EvalSuiteResult;
  challenger: EvalSuiteResult;
}

function isBinary(scores: number[]): boolean {
  return scores.every((s) => s === 0 || s === 1);
}

function compareMetric(baselineScores: number[], challengerScores: number[]): MetricComparison {
  const baselineMean = mean(baselineScores);
  const challengerMean = mean(challengerScores);
  const n = baselineScores.length;

  if (n < 2) {
    return {
      baseline: baselineMean,
      challenger: challengerMean,
      n,
      pValue: 1,
      significant: false,
      winner: 'tie',
    };
  }

  const binary = isBinary(baselineScores) && isBinary(challengerScores);

  let pValue: number;
  let significant: boolean;

  if (binary) {
    let bCorrect_cIncorrect = 0;
    let bIncorrect_cCorrect = 0;
    for (let i = 0; i < n; i++) {
      if (baselineScores[i] === 1 && challengerScores[i] === 0) bCorrect_cIncorrect++;
      if (baselineScores[i] === 0 && challengerScores[i] === 1) bIncorrect_cCorrect++;
    }
    const result = mcnemarsTest(bCorrect_cIncorrect, bIncorrect_cCorrect);
    pValue = result.pValue;
    significant = result.significant;
  } else {
    const result = pairedTTest(baselineScores, challengerScores);
    pValue = result.pValue;
    significant = result.significant;
  }

  let winner: 'baseline' | 'challenger' | 'tie' = 'tie';
  if (significant) {
    winner = challengerMean > baselineMean ? 'challenger' : 'baseline';
  }

  return { baseline: baselineMean, challenger: challengerMean, n, pValue, significant, winner };
}

function determineOverallWinner(
  metrics: Record<string, MetricComparison>
): 'baseline' | 'challenger' | 'tie' {
  let baselineWins = 0;
  let challengerWins = 0;

  for (const mc of Object.values(metrics)) {
    if (mc.winner === 'baseline') baselineWins++;
    if (mc.winner === 'challenger') challengerWins++;
  }

  if (challengerWins > baselineWins) return 'challenger';
  if (baselineWins > challengerWins) return 'baseline';
  return 'tie';
}

export class EvalComparison {
  private readonly opts: EvalComparisonOptions;

  constructor(opts: EvalComparisonOptions) {
    EvalComparisonConfigSchema.parse({
      concurrency: opts.concurrency,
      timeout: opts.timeout,
      retries: opts.retries,
      trials: opts.trials,
    });
    this.opts = opts;
  }

  async run(options: EvalComparisonRunOptions = {}): Promise<ComparisonResult> {
    const {
      dataset,
      targets,
      metrics,
      statisticalMetrics,
      judge,
      concurrency,
      timeout,
      retries,
      trials,
      onProgress,
    } = this.opts;

    const sharedConfig = {
      dataset,
      metrics,
      statisticalMetrics,
      judge,
      concurrency,
      timeout,
      retries,
      trials,
    };

    const baselineSuite = new EvalSuite({
      ...sharedConfig,
      target: targets.baseline,
      onProgress: onProgress
        ? (p) => onProgress({ target: 'baseline', completed: p.completed, total: p.total })
        : undefined,
    });

    const challengerSuite = new EvalSuite({
      ...sharedConfig,
      target: targets.challenger,
      onProgress: onProgress
        ? (p) => onProgress({ target: 'challenger', completed: p.completed, total: p.total })
        : undefined,
    });

    const [baselineResult, challengerResult] = await Promise.all([
      baselineSuite.run({ signal: options.signal }),
      challengerSuite.run({ signal: options.signal }),
    ]);

    const metricNames = new Set<string>();
    for (const result of [baselineResult, challengerResult]) {
      for (const r of result.results) {
        for (const trial of r.trials ?? [r]) {
          for (const s of trial.scores) metricNames.add(s.name);
        }
      }
    }

    const metricComparisons: Record<string, MetricComparison> = {};

    for (const name of metricNames) {
      const [baselineScores, challengerScores] = pairedScores(
        baselineResult,
        challengerResult,
        name
      );
      metricComparisons[name] = compareMetric(baselineScores, challengerScores);
    }

    return {
      summary: {
        winner: determineOverallWinner(metricComparisons),
        metrics: metricComparisons,
      },
      baseline: baselineResult,
      challenger: challengerResult,
    };
  }
}

/** A case's score of a metric: the mean over its trials the metric scored, none when it scored none */
function caseScore(result: ScoredCaseResult | undefined, metricName: string): number | undefined {
  if (!result) return undefined;
  const trials = result.trials ?? [result];
  if (trials.every((trial) => trial.error !== undefined)) return undefined;
  const scores = trials.flatMap((trial) =>
    trial.error !== undefined
      ? [0]
      : trial.scores.filter((s: MetricScore) => s.name === metricName).map((s) => s.score)
  );
  return scores.length === 0 ? undefined : mean(scores);
}

/**
 * The scores of a metric for each case, side by side. A case one side errored on counts as a 0
 * for that side, since a target that fails loses the case, and a case both sides errored on is
 * left out, telling nothing about either
 */
function pairedScores(
  baseline: EvalSuiteResult,
  challenger: EvalSuiteResult,
  metricName: string
): [number[], number[]] {
  const scoreOf = (result: EvalSuiteResult, at: number) =>
    caseScore(result.results[at], metricName);
  const baselineScores: number[] = [];
  const challengerScores: number[] = [];
  for (let at = 0; at < baseline.results.length; at++) {
    const b = scoreOf(baseline, at);
    const c = scoreOf(challenger, at);
    if (b === undefined && c === undefined) continue;
    baselineScores.push(b ?? 0);
    challengerScores.push(c ?? 0);
  }
  return [baselineScores, challengerScores];
}
