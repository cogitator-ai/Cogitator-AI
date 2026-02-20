import { EvalSuite } from './eval-suite';
import type { EvalTarget, EvalSuiteResult } from './eval-suite';
import type { MetricFn, MetricScore, StatisticalMetricFn } from './metrics/types';
import type { JudgeConfig } from './schema';
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
  judge?: JudgeConfig;
  concurrency?: number;
  timeout?: number;
  retries?: number;
  onProgress?: (progress: { target: string; completed: number; total: number }) => void;
}

export interface MetricComparison {
  baseline: number;
  challenger: number;
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

  return { baseline: baselineMean, challenger: challengerMean, pValue, significant, winner };
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
    this.opts = opts;
  }

  async run(): Promise<ComparisonResult> {
    const {
      dataset,
      targets,
      metrics,
      statisticalMetrics,
      judge,
      concurrency,
      timeout,
      retries,
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
      baselineSuite.run(),
      challengerSuite.run(),
    ]);

    const metricNames = new Set<string>();
    for (const r of baselineResult.results) {
      for (const s of r.scores) {
        metricNames.add(s.name);
      }
    }

    const metricComparisons: Record<string, MetricComparison> = {};

    for (const name of metricNames) {
      const baselineScores = extractScores(baselineResult, name);
      const challengerScores = extractScores(challengerResult, name);
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

function extractScores(result: EvalSuiteResult, metricName: string): number[] {
  return result.results.map((r) => {
    const score = r.scores.find((s: MetricScore) => s.name === metricName);
    return score?.score ?? 0;
  });
}
