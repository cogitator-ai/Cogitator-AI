import type { EvalSuiteResult } from './eval-suite';
import type { EvalCaseResult, MetricScore } from './metrics/types';
import type { TrajectoryOrder } from './metrics/tool-calls';
import { trajectoryScore } from './metrics/tool-calls';
import {
  isSubset,
  longestCommonSubsequence,
  multisetOverlap,
  passageMatches,
} from './metrics/matching';

/** The matchers `evalMatchers` adds to Vitest's `expect`, typed for Vitest 5 */
export interface EvalMatchers<R = unknown> {
  /**
   * The case result called the tool `name`, over any of its turns, with arguments holding `args`
   * when given (other arguments may be there too)
   */
  toHaveCalledTool(name: string, args?: Record<string, unknown>): R;
  /**
   * The case result called the tools in `names`. `order: 'exact'` (default): those calls and
   * no others, in this order. `'in-order'`: in this order, other calls may come between.
   * `'any-order'`: each of them, in any order, other calls allowed
   */
  toFollowTrajectory(names: readonly string[], options?: { order?: TrajectoryOrder }): R;
  /**
   * The case result retrieved a passage with this id or this text, or whose text contains this
   * one or is contained in it when the contained text has at least three words
   */
  toHaveRetrieved(idOrText: string): R;
  /**
   * A case result scored at least `min` on the metric, or a suite result's mean of the metric
   * is at least `min`
   */
  toScoreAtLeast(metricName: string, min: number): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface Assertion<R extends void | Promise<void> = void, T = unknown> extends EvalMatchers<R> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends EvalMatchers {}
}

/** The part of Vitest's matcher context the eval matchers use */
interface MatcherContext {
  isNot: boolean;
}

interface MatcherResult {
  pass: boolean;
  message: () => string;
  actual?: unknown;
  expected?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function caseResultOf(received: unknown, matcher: string): EvalCaseResult {
  if (isRecord(received) && isRecord(received.case) && typeof received.output === 'string') {
    return received as unknown as EvalCaseResult;
  }
  throw new TypeError(`${matcher} expects a case result, one of suite.run()'s results`);
}

function callText(name: string, args?: Record<string, unknown>): string {
  return args === undefined ? name : `${name}(${JSON.stringify(args)})`;
}

function callsText(result: EvalCaseResult): string {
  const calls = result.toolCalls ?? [];
  return calls.length === 0
    ? 'no tool calls'
    : calls.map((c) => callText(c.name, c.arguments)).join(', ');
}

function negation(context: MatcherContext): string {
  return context.isNot ? 'not ' : '';
}

/**
 * Vitest matchers for eval results. Register them once, in a test file or a setup file:
 *
 * @example
 * ```ts
 * import { expect } from 'vitest';
 * import { evalMatchers } from '@cogitator-ai/evals/matchers';
 *
 * expect.extend(evalMatchers);
 *
 * const { results } = await suite.run();
 * expect(results[0]).toHaveCalledTool('get_weather', { city: 'Paris' });
 * expect(results[0]).toFollowTrajectory(['search', 'answer'], { order: 'in-order' });
 * ```
 */
export const evalMatchers = {
  toHaveCalledTool(
    this: MatcherContext,
    received: unknown,
    name: string,
    args?: Record<string, unknown>
  ): MatcherResult {
    const result = caseResultOf(received, 'toHaveCalledTool');
    const calls = result.toolCalls ?? [];
    const pass = calls.some(
      (call) => call.name === name && (args === undefined || isSubset(args, call.arguments))
    );
    return {
      pass,
      message: () =>
        `expected the case ${negation(this)}to call ${callText(name, args)}, it made ${callsText(result)}`,
      actual: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
      expected: { name, ...(args !== undefined && { arguments: args }) },
    };
  },

  toFollowTrajectory(
    this: MatcherContext,
    received: unknown,
    names: readonly string[],
    options: { order?: TrajectoryOrder } = {}
  ): MatcherResult {
    const result = caseResultOf(received, 'toFollowTrajectory');
    const order = options.order ?? 'exact';
    const actual = (result.toolCalls ?? []).map((c) => c.name);
    const pass =
      order === 'exact'
        ? trajectoryScore(names, actual, 'exact') === 1
        : order === 'in-order'
          ? longestCommonSubsequence(names, actual) === names.length
          : multisetOverlap(names, actual) === names.length;
    return {
      pass,
      message: () =>
        `expected the tool calls ${negation(this)}to follow [${names.join(', ')}] (${order}), they were [${actual.join(', ')}]`,
      actual,
      expected: [...names],
    };
  },

  toHaveRetrieved(this: MatcherContext, received: unknown, idOrText: string): MatcherResult {
    const result = caseResultOf(received, 'toHaveRetrieved');
    const retrieved = result.retrieved ?? [];
    const pass = retrieved.some((p) => passageMatches(p, idOrText));
    const shown = retrieved.map((p) => p.id ?? JSON.stringify(p.content.slice(0, 60)));
    return {
      pass,
      message: () =>
        `expected the case ${negation(this)}to retrieve ${JSON.stringify(idOrText)}, it retrieved ${
          retrieved.length === 0 ? 'nothing' : `${retrieved.length} passage(s): ${shown.join(', ')}`
        }`,
    };
  },

  toScoreAtLeast(
    this: MatcherContext,
    received: unknown,
    metricName: string,
    min: number
  ): MatcherResult {
    const { score, of } = metricScoreOf(received, metricName);
    const pass = score >= min;
    return {
      pass,
      message: () => `expected ${of} ${negation(this)}to be at least ${min}, it is ${score}`,
      actual: score,
      expected: min,
    };
  },
};

/** The score a matcher compares: a case result's score of the metric, or a suite's mean of it */
function metricScoreOf(received: unknown, metricName: string): { score: number; of: string } {
  if (isRecord(received) && isRecord(received.aggregated)) {
    const aggregated = received.aggregated as EvalSuiteResult['aggregated'];
    const metric = aggregated[metricName];
    if (!metric) {
      throw new Error(
        `toScoreAtLeast: the suite has no metric '${metricName}', it has ${namesText(Object.keys(aggregated))}`
      );
    }
    return { score: metric.mean, of: `the mean of ${metricName}` };
  }
  const result = caseResultOf(received, 'toScoreAtLeast');
  const scores: readonly MetricScore[] = (result as { scores?: MetricScore[] }).scores ?? [];
  const found = scores.find((s) => s.name === metricName);
  if (!found) {
    throw new Error(
      `toScoreAtLeast: the case has no score for '${metricName}', it has ${namesText(scores.map((s) => s.name))}`
    );
  }
  return {
    score: found.score,
    of: `the ${metricName} score of the case${found.details ? ` (${found.details})` : ''}`,
  };
}

function namesText(names: string[]): string {
  return names.length === 0 ? 'none' : names.map((n) => `'${n}'`).join(', ');
}
