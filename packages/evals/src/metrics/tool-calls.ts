import type { ExpectedToolCall } from '../schema';
import type { EvalToolCall, MetricFn, MetricOptions } from './types';
import {
  deepEqual,
  isSubset,
  longestCommonSubsequence,
  maxMatching,
  multisetOverlap,
} from './matching';

/** How the arguments of an expected tool call are compared with the actual call's */
export type ToolArgumentsMatch = 'ignore' | 'subset' | 'exact';

/** Which figure of the tool call match `toolCalls()` scores */
export type ToolCallsScore = 'f1' | 'recall' | 'precision';

/** How strictly `trajectory()` compares the order of the tool calls */
export type TrajectoryOrder = 'exact' | 'in-order' | 'any-order';

export interface ToolCallsOptions extends MetricOptions {
  /**
   * `'subset'` (default): the expected arguments must all be in the call with equal values,
   * others may be there too. `'exact'`: the arguments must be equal. `'ignore'`: only the name
   * counts. An expected call without `arguments` matches on its name alone
   */
  arguments?: ToolArgumentsMatch;
  /** `'f1'` (default), `'recall'` (expected calls made) or `'precision'` (calls that were expected) */
  score?: ToolCallsScore;
}

export interface TrajectoryOptions extends MetricOptions {
  /**
   * `'exact'` (default): 1 when the tool names are the expected ones in the same order, else 0.
   * `'in-order'`: the longest common subsequence over the longer of the two sequences.
   * `'any-order'`: the names both share, as multisets, over the longer of the two
   */
  order?: TrajectoryOrder;
}

const ARGUMENT_MODES: readonly ToolArgumentsMatch[] = ['ignore', 'subset', 'exact'];
const SCORE_MODES: readonly ToolCallsScore[] = ['f1', 'recall', 'precision'];
const ORDERS: readonly TrajectoryOrder[] = ['exact', 'in-order', 'any-order'];

function checkOption<T extends string>(
  metric: string,
  option: string,
  value: T,
  allowed: readonly T[]
) {
  if (!allowed.includes(value)) {
    throw new Error(
      `${metric} ${option} must be one of ${allowed.map((v) => `'${v}'`).join(', ')}, got ${String(value)}`
    );
  }
}

function createMetricFn(name: string, fn: MetricFn): MetricFn {
  fn.metricName = name;
  return fn;
}

/** Whether an actual call is the expected one, its arguments compared as `mode` says */
export function toolCallMatches(
  expected: ExpectedToolCall,
  actual: EvalToolCall,
  mode: ToolArgumentsMatch = 'subset'
): boolean {
  if (expected.name !== actual.name) return false;
  if (mode === 'ignore' || expected.arguments === undefined) return true;
  return mode === 'exact'
    ? deepEqual(expected.arguments, actual.arguments)
    : isSubset(expected.arguments, actual.arguments);
}

function describeCall(call: { name: string; arguments?: Record<string, unknown> }): string {
  return call.arguments === undefined
    ? call.name
    : `${call.name}(${JSON.stringify(call.arguments)})`;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/**
 * Compares the tool calls of the run, over every turn, with the case's `expectedToolCalls` as
 * multisets: each expected call pairs with at most one actual call. Scores the F1 of the match
 * by default, or its recall or precision. A case expecting no calls scores 1 when the agent made
 * none and 0 otherwise, and so does a case expecting calls when the agent made none.
 */
export function toolCalls(opts?: ToolCallsOptions): MetricFn {
  const mode = opts?.arguments ?? 'subset';
  const scoring = opts?.score ?? 'f1';
  const name = opts?.name ?? 'toolCalls';
  checkOption('toolCalls', 'arguments', mode, ARGUMENT_MODES);
  checkOption('toolCalls', 'score', scoring, SCORE_MODES);

  return createMetricFn(name, (async (result) => {
    const expected = result.case.expectedToolCalls;
    if (expected === undefined) {
      return { name, score: 0, details: 'no expected tool calls provided' };
    }

    const actual = result.toolCalls ?? [];
    const pairs = maxMatching(expected, actual, (e, a) => toolCallMatches(e, a, mode));
    const precision =
      actual.length === 0 ? (expected.length === 0 ? 1 : 0) : ratio(pairs.size, actual.length);
    const recall =
      expected.length === 0 ? (actual.length === 0 ? 1 : 0) : ratio(pairs.size, expected.length);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const score = scoring === 'precision' ? precision : scoring === 'recall' ? recall : f1;

    const matchedActual = new Set(pairs.values());
    const missing = expected.filter((_, i) => !pairs.has(i)).map(describeCall);
    const unexpected = actual.filter((_, j) => !matchedActual.has(j)).map(describeCall);
    const problems = [
      ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(', ')}`] : []),
    ];

    return {
      name,
      score,
      details: problems.length > 0 ? problems.join(' | ') : undefined,
      metadata: { precision, recall, f1, matched: pairs.size },
    };
  }) as MetricFn);
}

/** How well a sequence of tool names follows the expected one, 0 to 1 */
export function trajectoryScore(
  expected: readonly string[],
  actual: readonly string[],
  order: TrajectoryOrder
): number {
  if (order === 'exact') {
    return expected.length === actual.length && expected.every((n, i) => n === actual[i]) ? 1 : 0;
  }
  const longest = Math.max(expected.length, actual.length);
  if (longest === 0) return 1;
  const shared =
    order === 'in-order'
      ? longestCommonSubsequence(expected, actual)
      : multisetOverlap(expected, actual);
  return shared / longest;
}

/**
 * Compares the sequence of tools the agent called, over every turn, with the names of the
 * case's `expectedToolCalls`. Arguments are not looked at: pair it with `toolCalls()` for them.
 */
export function trajectory(opts?: TrajectoryOptions): MetricFn {
  const order = opts?.order ?? 'exact';
  const name = opts?.name ?? 'trajectory';
  checkOption('trajectory', 'order', order, ORDERS);

  return createMetricFn(name, (async (result) => {
    const expectedCalls = result.case.expectedToolCalls;
    if (expectedCalls === undefined) {
      return { name, score: 0, details: 'no expected tool calls provided' };
    }

    const expected = expectedCalls.map((c) => c.name);
    const actual = (result.toolCalls ?? []).map((c) => c.name);
    const score = trajectoryScore(expected, actual, order);

    return {
      name,
      score,
      details:
        score < 1 ? `expected [${expected.join(', ')}], got [${actual.join(', ')}]` : undefined,
    };
  }) as MetricFn);
}
