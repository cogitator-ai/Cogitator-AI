import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { threshold, noRegression, assertion } from '../assertions';
import type { AggregatedMetric } from '../assertions';

function makeMetric(overrides: Partial<AggregatedMetric> = {}): AggregatedMetric {
  return {
    name: 'test',
    mean: 0.8,
    median: 0.8,
    min: 0.5,
    max: 1.0,
    stdDev: 0.1,
    p50: 0.8,
    p95: 0.95,
    p99: 0.99,
    ...overrides,
  };
}

const defaultStats = { total: 100, duration: 5000, cost: 0.5 };

describe('threshold', () => {
  it('passes when mean >= threshold', () => {
    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.9 }) };
    const result = threshold('accuracy', 0.8)(agg, defaultStats);

    expect(result.passed).toBe(true);
    expect(result.actual).toBe(0.9);
    expect(result.expected).toBe(0.8);
  });

  it('fails when mean < threshold', () => {
    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.6 }) };
    const result = threshold('accuracy', 0.8)(agg, defaultStats);

    expect(result.passed).toBe(false);
    expect(result.actual).toBe(0.6);
    expect(result.expected).toBe(0.8);
  });

  it('uses lower-is-better for latency metrics', () => {
    const agg = { latencyMs: makeMetric({ name: 'latencyMs', mean: 200 }) };

    const passes = threshold('latencyMs', 300)(agg, defaultStats);
    expect(passes.passed).toBe(true);

    const fails = threshold('latencyMs', 100)(agg, defaultStats);
    expect(fails.passed).toBe(false);
  });

  it('uses lower-is-better for cost metrics', () => {
    const agg = { costUsd: makeMetric({ name: 'costUsd', mean: 0.01 }) };

    const passes = threshold('costUsd', 0.05)(agg, defaultStats);
    expect(passes.passed).toBe(true);

    const fails = threshold('costUsd', 0.005)(agg, defaultStats);
    expect(fails.passed).toBe(false);
  });

  it('uses lower-is-better for metrics ending with Duration', () => {
    const agg = { responseDuration: makeMetric({ name: 'responseDuration', mean: 150 }) };

    const passes = threshold('responseDuration', 200)(agg, defaultStats);
    expect(passes.passed).toBe(true);

    const fails = threshold('responseDuration', 100)(agg, defaultStats);
    expect(fails.passed).toBe(false);
  });

  it('uses lower-is-better for metrics ending with Latency', () => {
    const agg = { apiLatency: makeMetric({ name: 'apiLatency', mean: 50 }) };

    const passes = threshold('apiLatency', 100)(agg, defaultStats);
    expect(passes.passed).toBe(true);
  });

  it('handles dotted path like latency.p95', () => {
    const agg = { latency: makeMetric({ name: 'latency', p95: 250, mean: 150 }) };
    const result = threshold('latency.p95', 300)(agg, defaultStats);

    expect(result.passed).toBe(true);
    expect(result.actual).toBe(250);
  });

  it('fails dotted path when exceeds threshold', () => {
    const agg = { latency: makeMetric({ name: 'latency', p95: 350, mean: 150 }) };
    const result = threshold('latency.p95', 300)(agg, defaultStats);

    expect(result.passed).toBe(false);
    expect(result.actual).toBe(350);
  });

  it('fails when metric not found', () => {
    const result = threshold('missing', 0.5)({}, defaultStats);

    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('passes on exact threshold value (higher-is-better)', () => {
    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.8 }) };
    const result = threshold('accuracy', 0.8)(agg, defaultStats);

    expect(result.passed).toBe(true);
  });

  it('passes on exact threshold value (lower-is-better)', () => {
    const agg = { latencyMs: makeMetric({ name: 'latencyMs', mean: 200 }) };
    const result = threshold('latencyMs', 200)(agg, defaultStats);

    expect(result.passed).toBe(true);
  });
});

describe('noRegression', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBaseline(data: Record<string, number>): string {
    const filePath = path.join(tmpDir, 'baseline.json');
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  it('passes when metrics are within tolerance', () => {
    const baselinePath = writeBaseline({ accuracy: 0.9 });
    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.88 }) };
    const result = noRegression(baselinePath)(agg, defaultStats);

    expect(result.passed).toBe(true);
  });

  it('fails when degraded beyond tolerance', () => {
    const baselinePath = writeBaseline({ accuracy: 0.9 });
    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.8 }) };
    const result = noRegression(baselinePath)(agg, defaultStats);

    expect(result.passed).toBe(false);
    expect(result.message).toContain('accuracy');
  });

  it('uses lower-is-better for latency metrics', () => {
    const baselinePath = writeBaseline({ latencyMs: 200 });

    const passAgg = { latencyMs: makeMetric({ name: 'latencyMs', mean: 205 }) };
    const passResult = noRegression(baselinePath)(passAgg, defaultStats);
    expect(passResult.passed).toBe(true);

    const failAgg = { latencyMs: makeMetric({ name: 'latencyMs', mean: 250 }) };
    const failResult = noRegression(baselinePath)(failAgg, defaultStats);
    expect(failResult.passed).toBe(false);
  });

  it('defaults to 5% tolerance', () => {
    const baselinePath = writeBaseline({ accuracy: 1.0 });

    const justWithin = { accuracy: makeMetric({ name: 'accuracy', mean: 0.95 }) };
    expect(noRegression(baselinePath)(justWithin, defaultStats).passed).toBe(true);

    const justBeyond = { accuracy: makeMetric({ name: 'accuracy', mean: 0.94 }) };
    expect(noRegression(baselinePath)(justBeyond, defaultStats).passed).toBe(false);
  });

  it('respects custom tolerance', () => {
    const baselinePath = writeBaseline({ accuracy: 1.0 });

    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.85 }) };

    expect(noRegression(baselinePath, { tolerance: 0.2 })(agg, defaultStats).passed).toBe(true);
    expect(noRegression(baselinePath, { tolerance: 0.1 })(agg, defaultStats).passed).toBe(false);
  });

  it('fails with clear error when baseline file is missing', () => {
    const fakePath = path.join(tmpDir, 'nonexistent.json');
    const result = noRegression(fakePath)({}, defaultStats);

    expect(result.passed).toBe(false);
    expect(result.message).toContain(fakePath);
  });

  it('skips metrics not present in aggregated', () => {
    const baselinePath = writeBaseline({ accuracy: 0.9, missing: 0.5 });
    const agg = { accuracy: makeMetric({ name: 'accuracy', mean: 0.88 }) };
    const result = noRegression(baselinePath)(agg, defaultStats);

    expect(result.passed).toBe(true);
  });
});

describe('assertion (custom)', () => {
  it('passes when check returns true', () => {
    const fn = assertion({
      name: 'always-pass',
      check: () => true,
    });
    const result = fn({}, defaultStats);

    expect(result.passed).toBe(true);
    expect(result.name).toBe('always-pass');
  });

  it('fails when check returns false', () => {
    const fn = assertion({
      name: 'always-fail',
      check: () => false,
    });
    const result = fn({}, defaultStats);

    expect(result.passed).toBe(false);
  });

  it('uses custom message', () => {
    const fn = assertion({
      name: 'custom-msg',
      check: () => false,
      message: 'Something went wrong',
    });
    const result = fn({}, defaultStats);

    expect(result.message).toBe('Something went wrong');
  });

  it('uses default message when not provided', () => {
    const fn = assertion({
      name: 'no-msg',
      check: () => false,
    });
    const result = fn({}, defaultStats);

    expect(result.message).toContain('no-msg');
    expect(result.message).toContain('failed');
  });

  it('receives aggregated and stats', () => {
    let capturedAgg: Record<string, AggregatedMetric> | null = null;
    let capturedStats: { total: number; duration: number; cost: number } | null = null;

    const agg = { accuracy: makeMetric({ name: 'accuracy' }) };
    const stats = { total: 50, duration: 3000, cost: 1.2 };

    const fn = assertion({
      name: 'capture',
      check: (a, s) => {
        capturedAgg = a;
        capturedStats = s;
        return true;
      },
    });

    fn(agg, stats);

    expect(capturedAgg).toBe(agg);
    expect(capturedStats).toBe(stats);
  });
});
