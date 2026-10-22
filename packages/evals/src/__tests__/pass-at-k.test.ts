import { describe, it, expect } from 'vitest';
import { passAtK, passAtKEstimate, isPassAtKMetric, latency } from '../metrics/statistical';
import { exactMatch } from '../metrics/deterministic';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import type { MetricScore, ScoredCaseResult } from '../metrics/types';

function binomial(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
}

function trial(score: number | undefined, error?: string): ScoredCaseResult {
  const scores: MetricScore[] = score === undefined ? [] : [{ name: 'exactMatch', score }];
  return {
    case: { input: 'q' },
    output: error ? '' : 'a',
    duration: 1,
    ...(error && { error }),
    scores,
  };
}

function caseWith(trials: ScoredCaseResult[]): ScoredCaseResult {
  return { ...trials[0], trials };
}

describe('passAtKEstimate()', () => {
  it('matches 1 - C(n - c, k) / C(n, k)', () => {
    for (const [n, c, k] of [
      [5, 2, 1],
      [5, 2, 2],
      [10, 3, 4],
      [20, 1, 5],
    ] as const) {
      expect(passAtKEstimate(n, c, k)).toBeCloseTo(1 - binomial(n - c, k) / binomial(n, k), 10);
    }
  });

  it('is 1 when fewer than k trials failed, 0 when none passed', () => {
    expect(passAtKEstimate(5, 4, 2)).toBe(1);
    expect(passAtKEstimate(5, 0, 3)).toBe(0);
    expect(passAtKEstimate(3, 1, 1)).toBeCloseTo(1 / 3);
  });
});

describe('passAtK()', () => {
  it('is named after its metric and k and is recognized as such', () => {
    const metric = passAtK('exactMatch', { k: 2 });
    expect(metric.metricName).toBe('passAtK(exactMatch,2)');
    expect(metric.passAtK).toEqual({ metric: 'exactMatch', k: 2, threshold: 1 });
    expect(isPassAtKMetric(metric)).toBe(true);
    expect(isPassAtKMetric(latency())).toBe(false);
  });

  it('averages the per-case estimate over cases, errored trials failing', () => {
    const metric = passAtK('exactMatch', { k: 2 });
    const results = [
      caseWith([trial(1), trial(0), trial(0)]),
      caseWith([trial(1), trial(undefined, 'boom'), trial(1)]),
    ];
    const score = metric(results);
    const first = passAtKEstimate(3, 1, 2);
    const second = passAtKEstimate(3, 2, 2);
    expect(score.values).toEqual([first, second]);
    expect(score.score).toBeCloseTo((first + second) / 2);
    expect(score.metadata).toEqual({ metric: 'exactMatch', k: 2, threshold: 1, cases: 2 });
  });

  it('passes trials at the threshold', () => {
    const metric = passAtK('exactMatch', { k: 1, threshold: 0.5 });
    expect(metric([caseWith([trial(0.5), trial(0.4)])]).score).toBe(0.5);
  });

  it('leaves out cases with no scored trial and is NaN without any', () => {
    const metric = passAtK('exactMatch', { k: 1 });
    const scored = metric([caseWith([trial(1)]), caseWith([trial(undefined, 'x')])]);
    expect(scored.values).toEqual([1]);
    const none = metric([caseWith([trial(undefined, 'x')])]);
    expect(none.score).toBeNaN();
    expect(none.values).toBeUndefined();
  });

  it('reads a result without trials as a single trial', () => {
    expect(passAtK('exactMatch', { k: 1 })([trial(1), trial(0)]).score).toBe(0.5);
  });

  it('throws when a case has fewer than k trials', () => {
    expect(() => passAtK('exactMatch', { k: 3 })([caseWith([trial(1), trial(1)])])).toThrow(
      'passAtK(exactMatch,3) needs at least 3 trials per case, a case has 2'
    );
  });

  it('rejects a k that is not a positive integer and a threshold that is not finite', () => {
    expect(() => passAtK('m', { k: 0 })).toThrow('passAtK k must be a positive integer, got 0');
    expect(() => passAtK('m', { k: 1.5 })).toThrow('positive integer');
    expect(() => passAtK('m', { k: 1, threshold: Number.NaN })).toThrow('finite number');
  });
});

describe('EvalSuite with passAtK', () => {
  const dataset = Dataset.from([{ input: 'a', expected: 'yes' }]);

  it('throws at construction when k exceeds the trials', () => {
    expect(
      () =>
        new EvalSuite({
          dataset,
          target: { fn: async () => 'yes' },
          metrics: [exactMatch()],
          statisticalMetrics: [passAtK('exactMatch', { k: 3 })],
          trials: 2,
        })
    ).toThrow('passAtK(exactMatch,3) needs at least 3 trials per case, the suite runs 2');
  });

  it('throws at construction when the suite lacks the metric', () => {
    expect(
      () =>
        new EvalSuite({
          dataset,
          target: { fn: async () => 'yes' },
          metrics: [exactMatch()],
          statisticalMetrics: [passAtK('contains', { k: 1 })],
        })
    ).toThrow("passAtK(contains,1) reads the metric 'contains', which the suite does not have");
  });

  it('scores pass@k over the trials of a run', async () => {
    let calls = 0;
    const suite = new EvalSuite({
      dataset,
      target: { fn: async () => (calls++ % 2 === 0 ? 'yes' : 'no') },
      metrics: [exactMatch()],
      statisticalMetrics: [passAtK('exactMatch', { k: 1 }), passAtK('exactMatch', { k: 2 })],
      trials: 4,
      concurrency: 1,
    });
    const result = await suite.run();
    expect(result.aggregated['passAtK(exactMatch,1)'].mean).toBeCloseTo(0.5);
    expect(result.aggregated['passAtK(exactMatch,2)'].mean).toBeCloseTo(passAtKEstimate(4, 2, 2));
    expect(result.aggregated.exactMatch.mean).toBeCloseTo(0.5);
  });
});
