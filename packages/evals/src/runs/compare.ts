import { z } from 'zod';
import { parseOptions } from '../options';
import {
  caseChanges,
  compareMetrics,
  determineOverallWinner,
  pairedScores,
  scoredMetricNames,
} from '../comparison-stats';
import type { ComparisonTest, ComparisonWinner } from '../comparison-stats';
import { truncateInput } from '../reporters/format';
import { canonicalJson } from './json';
import { runOf } from './run';
import type { EvalRunSource } from './run';
import type { EvalRun, EvalRunCase } from './schema';

export const CompareRunsOptionsSchema = z.object({
  alpha: z.number().gt(0).lt(1).default(0.05),
  test: z.enum(['t', 'wilcoxon']).default('t'),
  seed: z.union([z.number(), z.string()]).optional(),
  metrics: z.array(z.string().min(1)).min(1).optional(),
});

export interface CompareRunsOptions {
  /**
   * Significance level, 0.05 by default. A metric is significant when its p-value, adjusted with
   * Holm's correction across the compared metrics, is below it, and its `ci` covers `1 - alpha`
   */
  alpha?: number;
  /** Test of metrics that are not binary: `t` (paired t-test, the default) or `wilcoxon` */
  test?: 't' | 'wilcoxon';
  /** Seeds the bootstrap of each metric's `ci`, so the intervals are the same on every call */
  seed?: number | string;
  /**
   * The metrics to compare. Default: every per-case metric both runs have and scored on at least
   * one matched case, the others named in `warnings`, so a metric without data neither shows two
   * means of 0 nor weakens the Holm correction of the others
   */
  metrics?: string[];
}

export type RunWinner = 'base' | 'head' | 'tie';

/** How the score of a case moved from the base run to the head run */
export interface RunCaseChange {
  caseKey: string;
  /** The case input on one line, shortened */
  input: string;
  base: number;
  head: number;
  /** `head` minus `base` */
  delta: number;
}

export interface RunMetricComparison {
  /** Mean score of the base run over the compared cases, NaN when `n` is 0 */
  base: number;
  head: number;
  /** Cases compared: matched cases at least one run scored, an errored side counting as a 0 */
  n: number;
  /** Mean of the paired differences, head minus base */
  difference: number;
  /** Percentile bootstrap confidence interval of `difference` at `1 - alpha` */
  ci: { low: number; high: number };
  /** Cohen's d of the paired differences (dz), NaN with fewer than 2 cases */
  effectSize: number;
  test: ComparisonTest;
  pValue: number;
  /** `pValue` after Holm's correction across the compared metrics */
  adjustedPValue: number;
  significant: boolean;
  /** The higher run when significant, by the test's direction */
  winner: RunWinner;
  /** Cases whose score rose, the largest rise first */
  improved: RunCaseChange[];
  /** Cases whose score fell, the largest fall first */
  regressed: RunCaseChange[];
}

/** Which run a side of a comparison is */
export interface RunRef {
  runId: string;
  name?: string;
  startedAt: string;
}

/** A case only one of the runs has */
export interface RunCaseRef {
  caseKey: string;
  input: string;
}

export interface RunComparison {
  base: RunRef;
  head: RunRef;
  /** The run more metrics name as their winner, a tie when as many name each */
  winner: RunWinner;
  metrics: Record<string, RunMetricComparison>;
  /** Cases both runs have, matched by `caseKey` */
  matched: number;
  /** Cases only the head run has */
  added: RunCaseRef[];
  /** Cases only the base run has */
  removed: RunCaseRef[];
  /**
   * What makes the runs harder to compare: other cases, other prompts, other metrics or judge,
   * and metrics left out because no matched case was scored on them
   */
  warnings: string[];
}

type RunPrompt = EvalRun['prompts'][number];

const WINNERS: Record<ComparisonWinner, RunWinner> = {
  baseline: 'base',
  challenger: 'head',
  tie: 'tie',
};

function refOf(run: EvalRun): RunRef {
  return {
    runId: run.runId,
    ...(run.name !== undefined && { name: run.name }),
    startedAt: run.startedAt,
  };
}

function caseRef(result: EvalRunCase): RunCaseRef {
  return { caseKey: result.caseKey, input: truncateInput(result.case.input) };
}

/**
 * Pairs the cases of the runs by `caseKey`, in the order of the base run. A key that repeats pairs
 * its first case of one run with its first case of the other, its second with the second, and so on
 */
function matchCases(base: EvalRun, head: EvalRun) {
  const headByKey = new Map<string, EvalRunCase[]>();
  for (const result of head.results) {
    const list = headByKey.get(result.caseKey);
    if (list) list.push(result);
    else headByKey.set(result.caseKey, [result]);
  }
  const pairs: Array<readonly [EvalRunCase, EvalRunCase]> = [];
  const removed: RunCaseRef[] = [];
  for (const result of base.results) {
    const match = headByKey.get(result.caseKey)?.shift();
    if (match) pairs.push([result, match]);
    else removed.push(caseRef(result));
  }
  const added = [...headByKey.values()].flat();
  const addedSet = new Set(added);
  return {
    pairs,
    removed,
    added: head.results.filter((result) => addedSet.has(result)).map(caseRef),
  };
}

/** The per-case metrics of a run: those it was set up with and those its cases were scored on */
function caseMetricNames(run: EvalRun): Set<string> {
  return new Set([...run.config.metrics, ...scoredMetricNames(run.results)]);
}

function metricsToCompare(base: EvalRun, head: EvalRun, requested: string[] | undefined): string[] {
  const baseNames = caseMetricNames(base);
  const headNames = caseMetricNames(head);
  const shared = [...baseNames].filter((name) => headNames.has(name));
  if (requested === undefined) return shared;
  const missing = requested.filter((name) => !shared.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `compareRuns: ${missing.map((name) => `'${name}'`).join(', ')} not in both runs, the base run has ${[...baseNames].join(', ') || 'no metrics'} and the head run ${[...headNames].join(', ') || 'no metrics'}`
    );
  }
  return [...new Set(requested)];
}

function promptLabel(prompt: RunPrompt): string {
  if (prompt.abTest) return `A/B test ${prompt.abTest.id} (${prompt.abTest.variant})`;
  if (prompt.version !== undefined) {
    return prompt.versionId !== undefined
      ? `v${prompt.version} (${prompt.versionId})`
      : `v${prompt.version}`;
  }
  return prompt.versionId ?? 'unversioned instructions';
}

function promptsByKey(run: EvalRun): Map<string, Map<string, string>> {
  const byKey = new Map<string, Map<string, string>>();
  for (const prompt of run.prompts) {
    const labels = byKey.get(prompt.key) ?? new Map<string, string>();
    labels.set(canonicalJson(prompt), promptLabel(prompt));
    byKey.set(prompt.key, labels);
  }
  return byKey;
}

function promptWarnings(base: EvalRun, head: EvalRun): string[] {
  const baseKeys = promptsByKey(base);
  const headKeys = promptsByKey(head);
  const warnings: string[] = [];
  for (const key of new Set([...baseKeys.keys(), ...headKeys.keys()])) {
    const before = baseKeys.get(key);
    const after = headKeys.get(key);
    const list = (labels: Map<string, string>) => [...labels.values()].join(', ');
    if (!before) {
      warnings.push(`Prompt '${key}' is used by the head run only (${list(after!)})`);
    } else if (!after) {
      warnings.push(`Prompt '${key}' is used by the base run only (${list(before)})`);
    } else if (
      before.size !== after.size ||
      [...before.keys()].some((identity) => !after.has(identity))
    ) {
      warnings.push(
        `Prompt '${key}' differs: the base run used ${list(before)}, the head run ${list(after)}`
      );
    }
  }
  return warnings;
}

function difference(label: string, base: string[], head: string[]): string | undefined {
  const onlyBase = base.filter((name) => !head.includes(name));
  const onlyHead = head.filter((name) => !base.includes(name));
  if (onlyBase.length === 0 && onlyHead.length === 0) return undefined;
  const parts = [
    ...(onlyBase.length > 0 ? [`only the base run has ${onlyBase.join(', ')}`] : []),
    ...(onlyHead.length > 0 ? [`only the head run has ${onlyHead.join(', ')}`] : []),
  ];
  return `${label} differ: ${parts.join(', ')}`;
}

function judgeLabel(judge: EvalRun['config']['judge']): string {
  if (!judge) return 'no judge';
  const samples = judge.samples !== undefined ? `, ${judge.samples} samples` : '';
  return `${judge.model} at temperature ${judge.temperature}${samples}`;
}

function configWarnings(base: EvalRun, head: EvalRun): string[] {
  const warnings: string[] = [];
  const metrics = difference(
    'Metrics',
    [...base.config.metrics, ...base.config.statisticalMetrics],
    [...head.config.metrics, ...head.config.statisticalMetrics]
  );
  if (metrics) warnings.push(metrics);
  if (canonicalJson(base.config.judge ?? null) !== canonicalJson(head.config.judge ?? null)) {
    warnings.push(
      `Judge differs: the base run used ${judgeLabel(base.config.judge)}, the head run ${judgeLabel(head.config.judge)}`
    );
  }
  return warnings;
}

function datasetWarning(
  base: EvalRun,
  head: EvalRun,
  added: number,
  removed: number
): string | undefined {
  if (base.dataset.fingerprint === head.dataset.fingerprint) return undefined;
  if (added === 0 && removed === 0) {
    return 'The datasets differ (fingerprints differ) while every case matches by input, turns and expected answer: their order, context or metadata changed';
  }
  return `The datasets differ (fingerprints differ): ${added} cases only in the head run, ${removed} only in the base run`;
}

/**
 * Compares two saved runs, or suite results, case by case: cases are matched by their `caseKey`,
 * and each metric both runs have is compared as `EvalComparison` compares its sides, the base run
 * in the baseline's place and the head run in the challenger's
 */
export function compareRuns(
  baseSource: EvalRunSource,
  headSource: EvalRunSource,
  options: CompareRunsOptions = {}
): RunComparison {
  const config = parseOptions(CompareRunsOptionsSchema, options, 'compareRuns');
  const base = runOf(baseSource);
  const head = runOf(headSource);
  const { pairs, added, removed } = matchCases(base, head);
  const paired = new Map<string, [number[], number[]]>();
  const unscored: string[] = [];
  for (const name of metricsToCompare(base, head, config.metrics)) {
    const scores = pairedScores(pairs, name);
    if (scores[0].length === 0 && config.metrics === undefined) unscored.push(name);
    else paired.set(name, scores);
  }
  const names = [...paired.keys()];
  const compared = compareMetrics(paired, config);

  const metrics: Record<string, RunMetricComparison> = {};
  for (const name of names) {
    const { baseline, challenger, winner, ...stats } = compared[name];
    const changes = caseChanges(pairs, name, (index) => pairs[index][0].case.input);
    const toRunChange = (change: (typeof changes.improved)[number]): RunCaseChange => ({
      caseKey: pairs[change.index][0].caseKey,
      input: change.input,
      base: change.before,
      head: change.after,
      delta: change.delta,
    });
    metrics[name] = {
      base: baseline,
      head: challenger,
      ...stats,
      winner: WINNERS[winner],
      improved: changes.improved.map(toRunChange),
      regressed: changes.regressed.map(toRunChange),
    };
  }

  const dataset = datasetWarning(base, head, added.length, removed.length);
  const warnings = [
    ...(dataset ? [dataset] : []),
    ...promptWarnings(base, head),
    ...configWarnings(base, head),
    ...unscored.map(
      (name) =>
        `Metric '${name}' was scored on no case the runs share (every case errored or went unscored), so it is not compared`
    ),
  ];

  return {
    base: refOf(base),
    head: refOf(head),
    winner: WINNERS[determineOverallWinner(compared)],
    metrics,
    matched: pairs.length,
    added,
    removed,
    warnings,
  };
}
