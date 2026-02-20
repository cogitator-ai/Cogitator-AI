import { describe, it, expect } from 'vitest';
import { EvalComparison } from '../eval-comparison';
import { Dataset } from '../datasets';
import type { EvalCaseResult, MetricFn, MetricScore } from '../metrics/types';

function makeMetricFn(name: string, scoreFn: (r: EvalCaseResult) => number): MetricFn {
  const fn = (async (result: EvalCaseResult): Promise<MetricScore> => {
    return { name, score: scoreFn(result) };
  }) as MetricFn;
  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  return fn;
}

function makeTarget(responses: string[]) {
  let idx = 0;
  return {
    fn: async (_input: string) => {
      return responses[idx++] ?? '';
    },
  };
}

describe('EvalComparison', () => {
  const dataset = Dataset.from([
    { input: 'a', expected: 'a' },
    { input: 'b', expected: 'b' },
    { input: 'c', expected: 'c' },
    { input: 'd', expected: 'd' },
    { input: 'e', expected: 'e' },
    { input: 'f', expected: 'f' },
    { input: 'g', expected: 'g' },
    { input: 'h', expected: 'h' },
    { input: 'i', expected: 'i' },
    { input: 'j', expected: 'j' },
  ]);

  const exactMatchMetric = makeMetricFn('exactMatch', (r) => {
    return r.output.trim() === (r.case.expected ?? '').trim() ? 1 : 0;
  });

  describe('basic flow', () => {
    it('runs both targets on the same dataset and returns results', async () => {
      const baseline = { fn: async (input: string) => `baseline-${input}` };
      const challenger = { fn: async (input: string) => `challenger-${input}` };

      const comparison = new EvalComparison({
        dataset,
        targets: { baseline, challenger },
        metrics: [makeMetricFn('dummy', () => 0.5)],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.baseline.results).toHaveLength(10);
      expect(result.challenger.results).toHaveLength(10);
      expect(result.baseline.results[0].output).toBe('baseline-a');
      expect(result.challenger.results[0].output).toBe('challenger-a');
    });

    it('metric comparison has correct baseline/challenger mean values', async () => {
      const baselineTarget = makeTarget(Array(10).fill('x'));
      const challengerTarget = makeTarget(Array(10).fill('y'));

      const metric = makeMetricFn('quality', (r) => (r.output === 'x' ? 0.8 : 0.6));

      const comparison = new EvalComparison({
        dataset,
        targets: { baseline: baselineTarget, challenger: challengerTarget },
        metrics: [metric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.quality.baseline).toBeCloseTo(0.8, 5);
      expect(result.summary.metrics.quality.challenger).toBeCloseTo(0.6, 5);
    });
  });

  describe('statistical tests', () => {
    it('clearly better challenger wins with significance', async () => {
      const inputs = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i));
      const ds = Dataset.from(inputs.map((c) => ({ input: c, expected: c })));

      const baselineTarget = makeTarget(inputs.map(() => 'wrong'));
      const challengerTarget = makeTarget([...inputs]);

      const comparison = new EvalComparison({
        dataset: ds,
        targets: { baseline: baselineTarget, challenger: challengerTarget },
        metrics: [exactMatchMetric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.exactMatch.challenger).toBe(1);
      expect(result.summary.metrics.exactMatch.baseline).toBe(0);
      expect(result.summary.metrics.exactMatch.significant).toBe(true);
      expect(result.summary.metrics.exactMatch.winner).toBe('challenger');
      expect(result.summary.winner).toBe('challenger');
    });

    it('equal targets result in tie', async () => {
      const responses = Array(10).fill('same');

      const comparison = new EvalComparison({
        dataset,
        targets: {
          baseline: makeTarget([...responses]),
          challenger: makeTarget([...responses]),
        },
        metrics: [makeMetricFn('score', () => 0.7)],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.score.significant).toBe(false);
      expect(result.summary.metrics.score.winner).toBe('tie');
      expect(result.summary.winner).toBe('tie');
    });

    it('mixed results: some metrics better, some worse', async () => {
      const ds = Dataset.from(
        Array.from({ length: 10 }, (_, i) => ({ input: `q${i}`, expected: `q${i}` }))
      );

      const baselineResponses = Array.from({ length: 10 }, (_, i) => (i < 10 ? `q${i}` : 'x'));
      const challengerResponses = Array.from({ length: 10 }, () => 'wrong');

      const metricA = makeMetricFn('metricA', (r) =>
        r.output === (r.case.expected ?? '') ? 1 : 0
      );
      const metricB = makeMetricFn('metricB', (r) =>
        r.output === (r.case.expected ?? '') ? 0.2 : 0.9
      );

      const comparison = new EvalComparison({
        dataset: ds,
        targets: {
          baseline: makeTarget([...baselineResponses]),
          challenger: makeTarget([...challengerResponses]),
        },
        metrics: [metricA, metricB],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.metricA.winner).toBe('baseline');
      expect(result.summary.metrics.metricB.winner).toBe('challenger');
    });
  });

  describe('winner determination', () => {
    it('challenger wins majority of significant metrics -> overall winner = challenger', async () => {
      const ds = Dataset.from(
        Array.from({ length: 10 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` }))
      );

      const m1 = makeMetricFn('m1', (r) => (r.output.startsWith('good') ? 1 : 0));
      const m2 = makeMetricFn('m2', (r) => (r.output.startsWith('good') ? 0.9 : 0.1));
      const m3 = makeMetricFn('m3', () => 0.5);

      const comparison = new EvalComparison({
        dataset: ds,
        targets: {
          baseline: makeTarget(Array(10).fill('bad')),
          challenger: makeTarget(Array(10).fill('good')),
        },
        metrics: [m1, m2, m3],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.m1.winner).toBe('challenger');
      expect(result.summary.metrics.m2.winner).toBe('challenger');
      expect(result.summary.metrics.m3.winner).toBe('tie');
      expect(result.summary.winner).toBe('challenger');
    });

    it('baseline wins when it is significantly better', async () => {
      const ds = Dataset.from(
        Array.from({ length: 10 }, (_, i) => ({ input: `q${i}`, expected: `q${i}` }))
      );

      const comparison = new EvalComparison({
        dataset: ds,
        targets: {
          baseline: makeTarget(Array.from({ length: 10 }, (_, i) => `q${i}`)),
          challenger: makeTarget(Array(10).fill('nope')),
        },
        metrics: [exactMatchMetric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.exactMatch.winner).toBe('baseline');
      expect(result.summary.winner).toBe('baseline');
    });

    it('tie when no significant differences', async () => {
      const comparison = new EvalComparison({
        dataset,
        targets: {
          baseline: makeTarget(Array(10).fill('same')),
          challenger: makeTarget(Array(10).fill('same')),
        },
        metrics: [exactMatchMetric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.winner).toBe('tie');
    });
  });

  describe('binary vs numerical detection', () => {
    it('scores all 0/1 uses McNemar test', async () => {
      const ds = Dataset.from(
        Array.from({ length: 10 }, (_, i) => ({ input: `q${i}`, expected: `q${i}` }))
      );

      const baselineResponses = Array.from({ length: 10 }, (_, i) => (i < 3 ? `q${i}` : 'x'));
      const challengerResponses = Array.from({ length: 10 }, (_, i) => (i < 8 ? `q${i}` : 'x'));

      const comparison = new EvalComparison({
        dataset: ds,
        targets: {
          baseline: makeTarget(baselineResponses),
          challenger: makeTarget(challengerResponses),
        },
        metrics: [exactMatchMetric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.exactMatch.baseline).toBeCloseTo(0.3, 5);
      expect(result.summary.metrics.exactMatch.challenger).toBeCloseTo(0.8, 5);
      expect(result.summary.metrics.exactMatch.pValue).toBeGreaterThanOrEqual(0);
      expect(result.summary.metrics.exactMatch.pValue).toBeLessThanOrEqual(1);
    });

    it('fractional scores use paired t-test', async () => {
      const ds = Dataset.from(Array.from({ length: 10 }, (_, i) => ({ input: `q${i}` })));

      const metric = makeMetricFn('fluency', (r) => (r.output.startsWith('good') ? 0.85 : 0.35));

      const comparison = new EvalComparison({
        dataset: ds,
        targets: {
          baseline: makeTarget(Array(10).fill('bad')),
          challenger: makeTarget(Array(10).fill('good')),
        },
        metrics: [metric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.fluency.baseline).toBeCloseTo(0.35, 5);
      expect(result.summary.metrics.fluency.challenger).toBeCloseTo(0.85, 5);
      expect(result.summary.metrics.fluency.significant).toBe(true);
      expect(result.summary.metrics.fluency.winner).toBe('challenger');
    });
  });

  describe('edge cases', () => {
    it('single case dataset - not enough for significance, results in tie', async () => {
      const ds = Dataset.from([{ input: 'only', expected: 'only' }]);

      const comparison = new EvalComparison({
        dataset: ds,
        targets: {
          baseline: { fn: async () => 'wrong' },
          challenger: { fn: async () => 'only' },
        },
        metrics: [exactMatchMetric],
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(result.summary.metrics.exactMatch.baseline).toBe(0);
      expect(result.summary.metrics.exactMatch.challenger).toBe(1);
      expect(result.summary.metrics.exactMatch.significant).toBe(false);
      expect(result.summary.metrics.exactMatch.winner).toBe('tie');
    });

    it('no metrics means empty metrics comparison', async () => {
      const comparison = new EvalComparison({
        dataset,
        targets: {
          baseline: { fn: async (i: string) => i },
          challenger: { fn: async (i: string) => i },
        },
        concurrency: 1,
      });

      const result = await comparison.run();

      expect(Object.keys(result.summary.metrics)).toHaveLength(0);
      expect(result.summary.winner).toBe('tie');
    });

    it('reports progress for both targets', async () => {
      const progress: Array<{ target: string; completed: number; total: number }> = [];

      const comparison = new EvalComparison({
        dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
        targets: {
          baseline: { fn: async (i: string) => i },
          challenger: { fn: async (i: string) => i },
        },
        concurrency: 1,
        onProgress: (p) => progress.push({ ...p }),
      });

      await comparison.run();

      const baselineProgress = progress.filter((p) => p.target === 'baseline');
      const challengerProgress = progress.filter((p) => p.target === 'challenger');
      expect(baselineProgress.length).toBeGreaterThan(0);
      expect(challengerProgress.length).toBeGreaterThan(0);
    });
  });
});
