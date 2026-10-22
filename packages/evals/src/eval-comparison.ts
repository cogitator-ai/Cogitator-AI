import { EvalSuite } from './eval-suite';
import type { EvalTarget, EvalSuiteResult } from './eval-suite';
import type { MetricFn, MetricScore, ScoredCaseResult, StatisticalMetricFn } from './metrics/types';
import type { EvalComparisonConfig, JudgeCogitator, JudgeConfigInput } from './schema';
import { EvalComparisonConfigSchema, JudgeConfigSchema } from './schema';
import { Dataset } from './datasets';
import type { JudgeContext } from './metrics/llm-judge';
import { judgeContextFor } from './metrics/llm-judge';
import { judgePairwise } from './pairwise';
import type { PairwiseOptions, PairwiseResult } from './pairwise';
import { parseOptions } from './options';
import { pairedTTest } from './stats/t-test';
import { mcnemarExact, mcnemarsTest } from './stats/mcnemar';
import { wilcoxonSignedRank } from './stats/wilcoxon';
import { bootstrapCI } from './stats/bootstrap';
import { cohensD } from './stats/effect-size';
import { holm } from './stats/holm';
import { mean } from './stats/percentiles';

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

/**
 * The test a comparison ran: McNemar's (exact below 25 discordant pairs, chi-square with
 * continuity correction from 25), the paired t-test, Wilcoxon signed-rank, or none with fewer
 * than 2 cases
 */
export type ComparisonTest = 'mcnemar' | 'mcnemar-exact' | 't' | 'wilcoxon' | 'none';

export type ComparisonWinner = 'baseline' | 'challenger' | 'tie';

export interface MetricComparison {
  baseline: number;
  challenger: number;
  /** Cases compared: those at least one side scored, an errored side counting as a 0 */
  n: number;
  /** Mean of the paired differences, challenger minus baseline */
  difference: number;
  /** Percentile bootstrap confidence interval of `difference` at `1 - alpha` */
  ci: { low: number; high: number };
  /** Cohen's d of the paired differences (dz), NaN with fewer than 2 cases */
  effectSize: number;
  test: ComparisonTest;
  /** The test's own p-value */
  pValue: number;
  /** `pValue` after Holm's correction across the compared metrics */
  adjustedPValue: number;
  /** `adjustedPValue` is below `alpha` */
  significant: boolean;
  winner: ComparisonWinner;
}

/**
 * Latency or cost of the two sides, paired over the cases both answered, where lower is better.
 * Not corrected for multiple comparisons and not part of the metrics' vote on the winner
 */
export interface ResourceComparison {
  /** Mean per case, NaN when no case pairs up */
  baseline: number;
  challenger: number;
  n: number;
  /** Challenger minus baseline: below 0 when the challenger is cheaper or faster */
  difference: number;
  test: ComparisonTest;
  pValue: number;
  significant: boolean;
  winner: ComparisonWinner;
}

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

function isBinary(scores: number[]): boolean {
  return scores.every((s) => s === 0 || s === 1);
}

/** Below this many discordant pairs McNemar's test is exact */
const EXACT_MCNEMAR_BELOW = 25;

function pairedTest(
  baseline: number[],
  challenger: number[],
  continuous: 't' | 'wilcoxon',
  binaryAllowed: boolean
): { test: ComparisonTest; pValue: number } {
  if (baseline.length < 2) return { test: 'none', pValue: 1 };
  if (binaryAllowed && isBinary(baseline) && isBinary(challenger)) {
    let b = 0;
    let c = 0;
    for (let i = 0; i < baseline.length; i++) {
      if (baseline[i] === 1 && challenger[i] === 0) b++;
      if (baseline[i] === 0 && challenger[i] === 1) c++;
    }
    return b + c < EXACT_MCNEMAR_BELOW
      ? { test: 'mcnemar-exact', pValue: mcnemarExact(b, c).pValue }
      : { test: 'mcnemar', pValue: mcnemarsTest(b, c).pValue };
  }
  if (continuous === 'wilcoxon') {
    return { test: 'wilcoxon', pValue: wilcoxonSignedRank(baseline, challenger).pValue };
  }
  return { test: 't', pValue: pairedTTest(baseline, challenger).pValue };
}

function differencesOf(baseline: number[], challenger: number[]): number[] {
  return challenger.map((score, i) => score - baseline[i]);
}

function meanOrNaN(values: number[]): number {
  return values.length === 0 ? Number.NaN : mean(values);
}

function compareMetric(
  name: string,
  baselineScores: number[],
  challengerScores: number[],
  config: EvalComparisonConfig
): Omit<MetricComparison, 'adjustedPValue' | 'significant' | 'winner'> {
  const differences = differencesOf(baselineScores, challengerScores);
  const { low, high } = bootstrapCI(differences, {
    confidence: 1 - config.alpha,
    ...(config.seed !== undefined && { seed: `${String(config.seed)}:${name}` }),
  });
  return {
    baseline: mean(baselineScores),
    challenger: mean(challengerScores),
    n: baselineScores.length,
    difference: mean(differences),
    ci: { low, high },
    effectSize: cohensD(differences),
    ...pairedTest(baselineScores, challengerScores, config.test, true),
  };
}

/** Each metric's verdict once its p-value is adjusted with Holm's correction over all metrics */
function decideMetrics(
  compared: Record<string, Omit<MetricComparison, 'adjustedPValue' | 'significant' | 'winner'>>,
  alpha: number
): Record<string, MetricComparison> {
  const names = Object.keys(compared);
  const adjusted = holm(names.map((name) => compared[name].pValue));
  const decided: Record<string, MetricComparison> = {};
  for (const [at, name] of names.entries()) {
    const metric = compared[name];
    const significant = adjusted[at] < alpha && metric.difference !== 0;
    decided[name] = {
      ...metric,
      adjustedPValue: adjusted[at],
      significant,
      winner: !significant ? 'tie' : metric.difference > 0 ? 'challenger' : 'baseline',
    };
  }
  return decided;
}

function compareResource(
  baseline: number[],
  challenger: number[],
  config: EvalComparisonConfig
): ResourceComparison {
  const difference = meanOrNaN(differencesOf(baseline, challenger));
  const { test, pValue } = pairedTest(baseline, challenger, config.test, false);
  const significant = pValue < config.alpha && difference !== 0;
  return {
    baseline: meanOrNaN(baseline),
    challenger: meanOrNaN(challenger),
    n: baseline.length,
    difference,
    test,
    pValue,
    significant,
    winner: !significant ? 'tie' : difference < 0 ? 'challenger' : 'baseline',
  };
}

function determineOverallWinner(metrics: Record<string, MetricComparison>): ComparisonWinner {
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

    const metricNames = new Set<string>();
    for (const result of [baselineResult, challengerResult]) {
      for (const r of result.results) {
        for (const trial of r.trials ?? [r]) {
          for (const s of trial.scores) metricNames.add(s.name);
        }
      }
    }

    const compared: Record<
      string,
      Omit<MetricComparison, 'adjustedPValue' | 'significant' | 'winner'>
    > = {};
    for (const name of metricNames) {
      const [baselineScores, challengerScores] = pairedScores(
        baselineResult,
        challengerResult,
        name
      );
      compared[name] = compareMetric(name, baselineScores, challengerScores, this.config);
    }
    const metricComparisons = decideMetrics(compared, this.config.alpha);

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
