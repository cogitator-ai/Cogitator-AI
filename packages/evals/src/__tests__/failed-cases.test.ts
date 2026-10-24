import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import { maxErrorRate } from '../assertions';
import type { EvalCaseResult, MetricFn, MetricScore } from '../metrics/types';

function metric(
  name: string,
  score: (result: EvalCaseResult) => number
): MetricFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (result: EvalCaseResult): Promise<MetricScore> => {
    calls.push(result.case.input);
    return { name, score: score(result) };
  }) as MetricFn & { calls: string[] };
  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  Object.defineProperty(fn, 'calls', { value: calls, writable: false });
  return fn;
}

describe('errored cases', () => {
  it('scores only the cases that answered and says how many the aggregate covers', async () => {
    const exact = metric('exact', (result) => (result.output === 'ok' ? 1 : 0));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }, { input: 'c' }, { input: 'd' }]),
      target: {
        fn: async (input) => {
          if (input === 'b' || input === 'd') throw new Error('provider down');
          return 'ok';
        },
      },
      metrics: [exact],
      assertions: [maxErrorRate(0.25)],
    });

    const result = await suite.run();

    expect(exact.calls).toEqual(['a', 'c']);
    expect(result.results.map((one) => one.scores.length)).toEqual([1, 0, 1, 0]);
    expect(result.aggregated.exact).toMatchObject({ mean: 1, count: 2 });
    expect(result.stats.errors).toBe(2);
    expect(result.assertions[0]).toMatchObject({ passed: false, actual: 0.5, expected: 0.25 });
  });

  it('passes the error rate a run stays within, and refuses a rate outside 0 to 1', () => {
    const check = maxErrorRate(0.5);
    expect(check({}, { total: 4, errors: 2, duration: 1, cost: 0 }).passed).toBe(true);
    expect(check({}, { total: 0, duration: 1, cost: 0 }).passed).toBe(true);
    expect(() => maxErrorRate(1.5)).toThrow('from 0 to 1');
    expect(() => maxErrorRate(Number.NaN)).toThrow('from 0 to 1');
  });
});

describe('run flags', () => {
  it('carries how an agent run ended into the case result and its reports', async () => {
    const outcomes: Record<string, Record<string, unknown>> = {
      long: { output: 'cut', truncated: true },
      loop: { output: '', iterationLimitReached: true },
      wait: { output: '', status: 'paused' },
      done: { output: 'fine', status: 'completed' },
    };
    const cogitator = {
      run: vi.fn(async (_agent: unknown, options: { input: string }) => outcomes[options.input]!),
    };
    const suite = new EvalSuite({
      dataset: Dataset.from(Object.keys(outcomes).map((input) => ({ input }))),
      target: { agent: {}, cogitator },
    });

    const result = await suite.run();

    expect(
      result.results.map(({ truncated, iterationLimitReached, paused }) => ({
        truncated,
        iterationLimitReached,
        paused,
      }))
    ).toEqual([
      { truncated: true, iterationLimitReached: undefined, paused: undefined },
      { truncated: undefined, iterationLimitReached: true, paused: undefined },
      { truncated: undefined, iterationLimitReached: undefined, paused: true },
      { truncated: undefined, iterationLimitReached: undefined, paused: undefined },
    ]);
  });
});

describe('a run paused on a question of a tool', () => {
  it('is flagged paused like an approval pause, with no approvals waiting', async () => {
    const cogitator = {
      run: vi.fn(async () => ({
        output: 'Let me ask.',
        status: 'paused',
        pendingApprovals: [],
        interrupts: [{ id: 'q1#0', kind: 'input', reason: 'confirm_plan', message: 'Go ahead?' }],
      })),
    };
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'plan' }]),
      target: { agent: {}, cogitator },
    });

    const result = await suite.run();

    expect(result.results[0]).toMatchObject({ output: 'Let me ask.', paused: true });
    expect(cogitator.run).toHaveBeenCalledTimes(1);
  });
});

describe('reports of run flags', () => {
  it('passes the flags of a case on to what the reporters write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-flags-'));
    const cogitator = { run: vi.fn(async () => ({ output: 'cut', truncated: true })) };
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'long' }]),
      target: { agent: {}, cogitator },
    });

    const result = await suite.run();
    result.report('json', { path: join(dir, 'report') });

    const written = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf-8')) as {
      results: Array<{ truncated?: boolean }>;
    };
    expect(written.results[0]?.truncated).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
