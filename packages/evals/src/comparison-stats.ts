import type { EvalComparisonConfig } from './schema';
import { pairedTTest } from './stats/t-test';
import { mcnemarExact, mcnemarsTest } from './stats/mcnemar';
import { wilcoxonSignedRank } from './stats/wilcoxon';
import { bootstrapCI } from './stats/bootstrap';
import { cohensD } from './stats/effect-size';
import { holm } from './stats/holm';
import { mean } from './stats/percentiles';
import { pairedDifference } from './stats/precision';
import { truncateInput } from './reporters/format';

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
  /**
   * The higher side when significant, by the test's direction: the sign of `difference`, except
   * for Wilcoxon's test, where it is the side with the larger rank sum and may differ from it
   */
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
  /** The lower side when significant, by the test's direction as for `MetricComparison.winner` */
  winner: ComparisonWinner;
}

/** The statistical settings of a comparison */
export type ComparisonStatsConfig = Pick<EvalComparisonConfig, 'alpha' | 'test' | 'seed'>;

/** A case result as the comparison reads it: its error, its scores and its trials */
export interface ScoredTrial {
  error?: string;
  scores: ReadonlyArray<{ name: string; score: number }>;
  trials?: readonly ScoredTrial[];
}

/** The two sides of one case, either missing when that side has no such case */
export type CasePair<T extends ScoredTrial = ScoredTrial> = readonly [T | undefined, T | undefined];

/** How the score of a case moved from one side to the other */
export interface CaseChange {
  /** Zero based position of the case in the pairs compared */
  index: number;
  /** The case input on one line, shortened */
  input: string;
  /** Score of the first side (the baseline, or the base run) */
  before: number;
  /** Score of the second side (the challenger, or the head run) */
  after: number;
  /** `after` minus `before` */
  delta: number;
}

/** A score moves when it changes by more than this */
export const SCORE_EPSILON = 1e-9;

function isBinary(scores: number[]): boolean {
  return scores.every((s) => s === 0 || s === 1);
}

/** Below this many discordant pairs McNemar's test is exact */
const EXACT_MCNEMAR_BELOW = 25;

interface PairedTest {
  test: ComparisonTest;
  pValue: number;
  /**
   * Which side the test finds higher: 1 the challenger, -1 the baseline, 0 neither. The sign of
   * the mean difference, except for Wilcoxon's test, where it is the side with the larger rank sum
   */
  direction: number;
}

function pairedTest(
  baseline: number[],
  challenger: number[],
  continuous: 't' | 'wilcoxon',
  binaryAllowed: boolean
): PairedTest {
  const direction = Math.sign(mean(differencesOf(baseline, challenger)));
  if (baseline.length < 2) return { test: 'none', pValue: 1, direction };
  if (binaryAllowed && isBinary(baseline) && isBinary(challenger)) {
    let b = 0;
    let c = 0;
    for (let i = 0; i < baseline.length; i++) {
      if (baseline[i] === 1 && challenger[i] === 0) b++;
      if (baseline[i] === 0 && challenger[i] === 1) c++;
    }
    return b + c < EXACT_MCNEMAR_BELOW
      ? { test: 'mcnemar-exact', pValue: mcnemarExact(b, c).pValue, direction }
      : { test: 'mcnemar', pValue: mcnemarsTest(b, c).pValue, direction };
  }
  if (continuous === 'wilcoxon') {
    const { statistic, n, pValue } = wilcoxonSignedRank(baseline, challenger);
    return { test: 'wilcoxon', pValue, direction: Math.sign((n * (n + 1)) / 4 - statistic) };
  }
  return { test: 't', pValue: pairedTTest(baseline, challenger).pValue, direction };
}

/** Challenger minus baseline per case, without float noise */
function differencesOf(baseline: number[], challenger: number[]): number[] {
  return challenger.map((score, i) => pairedDifference(score, baseline[i]));
}

type ComparedMetric = Omit<MetricComparison, 'adjustedPValue' | 'significant' | 'winner'> & {
  direction: number;
};

function meanOrNaN(values: number[]): number {
  return values.length === 0 ? Number.NaN : mean(values);
}

function compareMetric(
  name: string,
  baselineScores: number[],
  challengerScores: number[],
  config: ComparisonStatsConfig
): ComparedMetric {
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

/**
 * Compares each metric on its paired scores, then adjusts the p-values with Holm's correction
 * across the metrics and decides each metric's winner
 */
export function compareMetrics(
  paired: ReadonlyMap<string, readonly [number[], number[]]>,
  config: ComparisonStatsConfig
): Record<string, MetricComparison> {
  const names = [...paired.keys()];
  const compared = names.map((name) => {
    const [baselineScores, challengerScores] = paired.get(name)!;
    return compareMetric(name, baselineScores, challengerScores, config);
  });
  const adjusted = holm(compared.map((metric) => metric.pValue));
  const decided: Record<string, MetricComparison> = {};
  for (const [at, name] of names.entries()) {
    const { direction, ...metric } = compared[at];
    const significant = adjusted[at] < config.alpha && direction !== 0;
    decided[name] = {
      ...metric,
      adjustedPValue: adjusted[at],
      significant,
      winner: !significant ? 'tie' : direction > 0 ? 'challenger' : 'baseline',
    };
  }
  return decided;
}

export function compareResource(
  baseline: number[],
  challenger: number[],
  config: ComparisonStatsConfig
): ResourceComparison {
  const difference = meanOrNaN(differencesOf(baseline, challenger));
  const { test, pValue, direction } = pairedTest(baseline, challenger, config.test, false);
  const significant = pValue < config.alpha && direction !== 0;
  return {
    baseline: meanOrNaN(baseline),
    challenger: meanOrNaN(challenger),
    n: baseline.length,
    difference,
    test,
    pValue,
    significant,
    winner: !significant ? 'tie' : direction < 0 ? 'challenger' : 'baseline',
  };
}

/** The side more metrics name as their winner, a tie when as many name each */
export function determineOverallWinner(
  metrics: Record<string, Pick<MetricComparison, 'winner'>>
): ComparisonWinner {
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

/** The names of the metrics any trial of the cases was scored on, in the order first seen */
export function scoredMetricNames(results: Iterable<ScoredTrial>): Set<string> {
  const names = new Set<string>();
  for (const r of results) {
    for (const trial of r.trials ?? [r]) {
      for (const s of trial.scores) names.add(s.name);
    }
  }
  return names;
}

/** A case's score of a metric: the mean over its trials the metric scored, none when it scored none */
export function caseScore(result: ScoredTrial | undefined, metricName: string): number | undefined {
  if (!result) return undefined;
  const trials = result.trials ?? [result];
  if (trials.every((trial) => trial.error !== undefined)) return undefined;
  const scores = trials.flatMap((trial) =>
    trial.error !== undefined
      ? [0]
      : trial.scores.filter((s) => s.name === metricName).map((s) => s.score)
  );
  return scores.length === 0 ? undefined : mean(scores);
}

/**
 * The scores of a metric for each pair, side by side, with the index of the pair. A case one side
 * errored on counts as a 0 for that side, since a target that fails loses the case, and a case
 * both sides errored on is left out, telling nothing about either
 */
function pairedCaseScores(
  pairs: readonly CasePair[],
  metricName: string
): Array<{ index: number; before: number; after: number }> {
  const scored: Array<{ index: number; before: number; after: number }> = [];
  for (const [index, [first, second]] of pairs.entries()) {
    const before = caseScore(first, metricName);
    const after = caseScore(second, metricName);
    if (before === undefined && after === undefined) continue;
    scored.push({ index, before: before ?? 0, after: after ?? 0 });
  }
  return scored;
}

/** The scores of a metric for each pair, side by side, as `pairedCaseScores` pairs them */
export function pairedScores(pairs: readonly CasePair[], metricName: string): [number[], number[]] {
  const scored = pairedCaseScores(pairs, metricName);
  return [scored.map((s) => s.before), scored.map((s) => s.after)];
}

/**
 * The cases whose score of a metric rose or fell from the first side to the second by more than
 * `SCORE_EPSILON`, the largest moves first
 */
export function caseChanges(
  pairs: readonly CasePair[],
  metricName: string,
  inputOf: (index: number) => string
): { improved: CaseChange[]; regressed: CaseChange[] } {
  const improved: CaseChange[] = [];
  const regressed: CaseChange[] = [];
  for (const { index, before, after } of pairedCaseScores(pairs, metricName)) {
    const delta = pairedDifference(after, before);
    if (Math.abs(delta) <= SCORE_EPSILON) continue;
    const change = { index, input: truncateInput(inputOf(index)), before, after, delta };
    (delta > 0 ? improved : regressed).push(change);
  }
  const byMove = (a: CaseChange, b: CaseChange) =>
    Math.abs(b.delta) - Math.abs(a.delta) || a.index - b.index;
  return { improved: improved.sort(byMove), regressed: regressed.sort(byMove) };
}
