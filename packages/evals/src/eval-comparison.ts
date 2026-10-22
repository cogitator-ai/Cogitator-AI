import { EvalSuite } from './eval-suite';
import type { EvalTarget, EvalSuiteResult } from './eval-suite';
import type { MetricFn, ScoredCaseResult, StatisticalMetricFn } from './metrics/types';
import type { EvalComparisonConfig, JudgeCogitator, JudgeConfigInput } from './schema';
import { EvalComparisonConfigSchema, JudgeConfigSchema } from './schema';
import { Dataset } from './datasets';
import type { JudgeContext } from './metrics/llm-judge';
import { judgeContextFor } from './metrics/llm-judge';
import { judgePairwise } from './pairwise';
import type { PairwiseOptions, PairwiseResult } from './pairwise';
import { parseOptions } from './options';
import { mean } from './stats/percentiles';
import {
  compareMetrics,
  compareResource,
  determineOverallWinner,
  pairedScores,
  scoredMetricNames,
} from './comparison-stats';
import type {
  CasePair,
  ComparisonWinner,
  MetricComparison,
  ResourceComparison,
} from './comparison-stats';

export interface EvalComparisonOptions {
  dataset: Dataset;
  targets: {
    baseline: EvalTarget;
    challenger: EvalTarget;
  };
  metrics?: MetricFn[];
  statisticalMetrics?: StatisticalMetricFn[];
  /** The judge of LLM metrics and of `pairwise`, on both sides */
  judge?: JudgeConfigInput;
  concurrency?: number;
  timeout?: number;
  retries?: number;
  /**
   * Runs of each case on each side, as the suite's `trials`. A metric is compared on each case's
   * mean over its scored trials, and `passAtK()` statistical metrics see every trial
   */
  trials?: number;
  /**
   * Significance level, 0.05 by default. A metric is significant when its p-value, adjusted with
   * Holm's correction across the compared metrics, is below it, and its `ci` covers `1 - alpha`
   */
  alpha?: number;
  /**
   * Test of metrics that are not binary, and of latency and cost: `t` (paired t-test, the
   * default) or `wilcoxon` (Wilcoxon signed-rank). Binary metrics always take McNemar's test
   */
  test?: 't' | 'wilcoxon';
  /** Seeds the bootstrap of each metric's `ci`, so the intervals are the same on every run */
  seed?: number | string;
  /**
   * Asks the judge which side answered each case better, both ways round, into
   * `result.pairwise`. Needs `judge`, run by `judge.cogitator` or an agent target's `cogitator`
   */
  pairwise?: PairwiseOptions;
  onProgress?: (progress: { target: string; completed: number; total: number }) => void;
}

export interface EvalComparisonRunOptions {
  /** Cancels both runs; `run()` rejects with the signal's reason */
  signal?: AbortSignal;
}

export type {
  ComparisonTest,
  ComparisonWinner,
  MetricComparison,
  ResourceComparison,
} from './comparison-stats';

export interface ComparisonResult {
  summary: {
    winner: ComparisonWinner;
    metrics: Record<string, MetricComparison>;
    /** Milliseconds per case, the mean over the answered trials of a case */
    latency: ResourceComparison;
    /** USD per case, over the cases both sides reported usage on. Absent when none did */
    cost?: ResourceComparison;
  };
  baseline: EvalSuiteResult;
  challenger: EvalSuiteResult;
  /** The judge's pairwise verdicts, with the `pairwise` option */
  pairwise?: PairwiseResult;
}

export class EvalComparison {
  private readonly opts: EvalComparisonOptions;
  private readonly config: EvalComparisonConfig;
  private readonly pairwiseJudge?: JudgeContext;

  constructor(opts: EvalComparisonOptions) {
    this.config = parseOptions(
      EvalComparisonConfigSchema,
      {
        concurrency: opts.concurrency,
        timeout: opts.timeout,
        retries: opts.retries,
        trials: opts.trials,
        alpha: opts.alpha,
        test: opts.test,
        seed: opts.seed,
        pairwise: opts.pairwise,
      },
      'EvalComparison'
    );
    this.opts = opts;

    if (this.config.pairwise) {
      if (!opts.judge) throw new Error('Pairwise judging requires a judge config');
      const judgeConfig = JudgeConfigSchema.parse(opts.judge);
      const cogitator =
        judgeConfig.cogitator ??
        ((opts.targets.baseline.cogitator ?? opts.targets.challenger.cogitator) as
          JudgeCogitator | undefined);
      if (!cogitator) {
        throw new Error(
          'Pairwise judging needs a Cogitator to run the judge: pass judge.cogitator, or use an agent target'
        );
      }
      this.pairwiseJudge = judgeContextFor(cogitator, judgeConfig);
    }
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

    const pairs = casePairs(baselineResult, challengerResult);
    const paired = new Map<string, [number[], number[]]>();
    for (const name of scoredMetricNames([
      ...baselineResult.results,
      ...challengerResult.results,
    ])) {
      paired.set(name, pairedScores(pairs, name));
    }
    const metricComparisons = compareMetrics(paired, this.config);

    const latency = compareResource(
      ...pairedResource(baselineResult, challengerResult, caseLatency),
      this.config
    );
    const [baselineCost, challengerCost] = pairedResource(
      baselineResult,
      challengerResult,
      caseCost
    );
    const cost =
      baselineCost.length > 0
        ? compareResource(baselineCost, challengerCost, this.config)
        : undefined;

    const pairwise =
      this.pairwiseJudge && this.config.pairwise
        ? await judgePairwise(
            baselineResult,
            challengerResult,
            this.pairwiseJudge,
            this.config.pairwise,
            this.config.concurrency,
            options.signal
          )
        : undefined;

    return {
      summary: {
        winner: determineOverallWinner(metricComparisons),
        metrics: metricComparisons,
        latency,
        ...(cost && { cost }),
      },
      baseline: baselineResult,
      challenger: challengerResult,
      ...(pairwise && { pairwise }),
    };
  }
}

/** The trials of a case that answered */
function answeredTrials(result: ScoredCaseResult): readonly ScoredCaseResult[] {
  return (result.trials ?? [result]).filter((trial) => trial.error === undefined);
}

/** A case's latency: the mean duration of its answered trials, none when none answered */
function caseLatency(result: ScoredCaseResult): number | undefined {
  const answered = answeredTrials(result);
  return answered.length === 0 ? undefined : mean(answered.map((trial) => trial.duration));
}

/** A case's cost: the mean cost of its answered trials that reported usage */
function caseCost(result: ScoredCaseResult): number | undefined {
  const costs = answeredTrials(result).flatMap((trial) =>
    trial.usage === undefined ? [] : [trial.usage.cost]
  );
  return costs.length === 0 ? undefined : mean(costs);
}

/** A per-case figure of both sides, over the cases both have it for */
function pairedResource(
  baseline: EvalSuiteResult,
  challenger: EvalSuiteResult,
  figure: (result: ScoredCaseResult) => number | undefined
): [number[], number[]] {
  const baselineValues: number[] = [];
  const challengerValues: number[] = [];
  for (let at = 0; at < baseline.results.length; at++) {
    const challengerResult = challenger.results[at];
    if (!challengerResult) continue;
    const b = figure(baseline.results[at]);
    const c = figure(challengerResult);
    if (b === undefined || c === undefined) continue;
    baselineValues.push(b);
    challengerValues.push(c);
  }
  return [baselineValues, challengerValues];
}

/** The cases of the two runs side by side, by position */
function casePairs(baseline: EvalSuiteResult, challenger: EvalSuiteResult): CasePair[] {
  return baseline.results.map((result, at) => [result, challenger.results[at]] as const);
}
