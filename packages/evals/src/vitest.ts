import { beforeAll, describe, it } from 'vitest';
import type { EvalRunOptions, EvalSuite, EvalSuiteResult } from './eval-suite';
import { caseLabel } from './reporters/format';

const DEFAULT_TIMEOUT = 10 * 60 * 1000;
/** Time the hook keeps after the deadline settled the outcome, for Vitest itself */
const HOOK_GRACE = 5 * 1000;
/** The longest delay `setTimeout` keeps, less the grace the hook adds to it */
const MAX_TIMEOUT = 2_147_483_647 - HOOK_GRACE;

export interface DescribeEvalOptions {
  /** The suite to run */
  suite: EvalSuite;
  /** Passed to `suite.run()`: `maxCases` also decides which cases get a test */
  run?: EvalRunOptions;
  /**
   * Milliseconds the suite run may take, 10 minutes by default. When it runs out the run is
   * cancelled and every test fails with the timeout.
   */
  timeout?: number;
}

export interface DescribeEvalHandle {
  /**
   * The result of the suite run. Call it inside a test or an `afterAll` hook of the same
   * describe block: it throws while the run has not finished, or with the cause when it failed.
   */
  result: () => EvalSuiteResult;
}

type Outcome =
  | { state: 'pending' }
  | { state: 'done'; result: EvalSuiteResult }
  | { state: 'failed'; error: unknown };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers a Vitest describe block for an eval suite. The suite runs once in `beforeAll`, each
 * case becomes a test that fails when the case errored, and an `assertions` test fails with
 * every assertion that did not pass.
 *
 * @example
 * ```ts
 * import { describeEval } from '@cogitator-ai/evals/vitest';
 *
 * const qa = describeEval('qa agent', { suite, run: { maxCases: 50 } });
 *
 * afterAll(() => qa.result().report('junit', { path: './reports/qa' }));
 * ```
 */
export function describeEval(name: string, options: DescribeEvalOptions): DescribeEvalHandle {
  const { suite, run = {}, timeout = DEFAULT_TIMEOUT } = options;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
    throw new Error(
      `describeEval timeout must be a positive number of milliseconds up to ${MAX_TIMEOUT}, got ${timeout}`
    );
  }

  let outcome: Outcome = { state: 'pending' };

  const result = (): EvalSuiteResult => {
    switch (outcome.state) {
      case 'done':
        return outcome.result;
      case 'failed':
        throw new Error(`Eval suite '${name}' failed to run: ${messageOf(outcome.error)}`, {
          cause: outcome.error,
        });
      case 'pending':
        throw new Error(
          `Eval suite '${name}' has not finished running: read the result inside its tests or afterAll`
        );
    }
  };

  describe(name, () => {
    beforeAll(async () => {
      const deadline = new AbortController();
      const late = new Error(`the run did not finish within ${timeout} ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadline.abort(late);
          reject(late);
        }, timeout);
      });
      const signal = run.signal ? AbortSignal.any([run.signal, deadline.signal]) : deadline.signal;
      const running = suite.run({ ...run, signal });
      running.catch(() => undefined);
      try {
        outcome = { state: 'done', result: await Promise.race([running, expired]) };
      } catch (error) {
        outcome = { state: 'failed', error };
      } finally {
        clearTimeout(timer);
      }
    }, timeout + HOOK_GRACE);

    suite.cases(run.maxCases).forEach((evalCase, index) => {
      it(caseLabel(index, evalCase.input), () => {
        const caseResult = result().results[index];
        if (caseResult?.error !== undefined) {
          const attempts =
            caseResult.attempts === undefined ? '' : ` after ${caseResult.attempts} attempt(s)`;
          throw new Error(`Case failed${attempts}: ${caseResult.error}`);
        }
      });
    });

    it('assertions', () => {
      const failed = result().assertions.filter((a) => !a.passed);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length} assertion(s) failed:\n${failed.map((a) => `  ${a.name}: ${a.message}`).join('\n')}`
        );
      }
    });
  });

  return { result };
}
