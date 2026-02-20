import { describe, it, expect } from 'vitest';
import { percentile, mean, median, stdDev, aggregate, pairedTTest, mcnemarsTest } from '../stats';

describe('percentiles', () => {
  it('computes percentile with linear interpolation', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 10);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBe(4);
  });

  it('returns 0 for empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('handles single element', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  it('computes mean correctly', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([10, 20, 30, 40])).toBe(25);
    expect(mean([-5, 5])).toBe(0);
  });

  it('returns 0 for mean of empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('computes median correctly', () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it('computes sample standard deviation', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  it('returns 0 for stdDev of empty or single-element array', () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([5])).toBe(0);
  });

  it('aggregate returns all fields', () => {
    const result = aggregate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.mean).toBe(5.5);
    expect(result.median).toBe(5.5);
    expect(result.min).toBe(1);
    expect(result.max).toBe(10);
    expect(result.stdDev).toBeCloseTo(3.0277, 3);
    expect(result.p50).toBe(5.5);
    expect(result.p95).toBeCloseTo(9.55, 10);
    expect(result.p99).toBeCloseTo(9.91, 10);
  });

  it('aggregate handles empty array', () => {
    const result = aggregate([]);
    expect(result.mean).toBe(0);
    expect(result.median).toBe(0);
    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
    expect(result.stdDev).toBe(0);
    expect(result.p50).toBe(0);
    expect(result.p95).toBe(0);
    expect(result.p99).toBe(0);
  });

  it('does not mutate the input array', () => {
    const input = [5, 3, 1, 4, 2];
    percentile(input, 0.5);
    expect(input).toEqual([5, 3, 1, 4, 2]);
  });
});

describe('paired t-test', () => {
  it('detects significant difference', () => {
    const a = [85, 90, 78, 92, 88, 95, 82, 91];
    const b = [80, 85, 79, 90, 84, 88, 76, 85];
    const result = pairedTTest(a, b);

    expect(result.degreesOfFreedom).toBe(7);
    expect(result.tStatistic).toBeGreaterThan(2);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.confidenceInterval[0]).toBeGreaterThan(0);
    expect(result.confidenceInterval[1]).toBeGreaterThan(result.confidenceInterval[0]);
  });

  it('computes correct t-statistic for known values', () => {
    const a = [85, 90, 78, 92, 88];
    const b = [80, 85, 79, 90, 84];
    const result = pairedTTest(a, b);

    expect(result.degreesOfFreedom).toBe(4);
    expect(result.tStatistic).toBeCloseTo(2.6312, 2);
    expect(result.pValue).toBeCloseTo(0.058, 1);
  });

  it('detects non-significant difference', () => {
    const a = [50, 51, 49, 50, 51];
    const b = [50, 50, 50, 51, 49];
    const result = pairedTTest(a, b);

    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it('throws on mismatched lengths', () => {
    expect(() => pairedTTest([1, 2, 3], [1, 2])).toThrow('equal length');
  });

  it('throws on fewer than 2 samples', () => {
    expect(() => pairedTTest([1], [2])).toThrow('at least 2');
    expect(() => pairedTTest([], [])).toThrow('at least 2');
  });

  it('handles identical arrays (no difference)', () => {
    const a = [10, 20, 30, 40, 50];
    const result = pairedTTest(a, a);

    expect(result.tStatistic).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.significant).toBe(false);
    expect(result.confidenceInterval[0]).toBe(0);
    expect(result.confidenceInterval[1]).toBe(0);
  });

  it('produces two-tailed p-value', () => {
    const a = [10, 22, 31, 43, 50];
    const b = [15, 20, 35, 40, 55];
    const r1 = pairedTTest(a, b);
    const r2 = pairedTTest(b, a);

    expect(r1.pValue).toBeCloseTo(r2.pValue, 10);
    expect(r1.tStatistic).toBeCloseTo(-r2.tStatistic, 10);
  });

  it('confidence interval contains the mean difference', () => {
    const a = [85, 90, 78, 92, 88, 95, 82, 91];
    const b = [80, 85, 79, 90, 84, 88, 76, 85];
    const result = pairedTTest(a, b);
    const meanDiff = mean(a.map((v, i) => v - b[i]));

    expect(result.confidenceInterval[0]).toBeLessThan(meanDiff);
    expect(result.confidenceInterval[1]).toBeGreaterThan(meanDiff);
  });

  it('handles large sample with known result', () => {
    const n = 100;
    const a = Array.from({ length: n }, (_, i) => 50 + i * 0.1);
    const b = Array.from({ length: n }, (_, i) => 50 + i * 0.1 - 0.5);
    const result = pairedTTest(a, b);

    expect(result.significant).toBe(true);
    expect(result.degreesOfFreedom).toBe(99);
  });
});

describe('McNemar test', () => {
  it('detects significant difference (b=20, c=5)', () => {
    const result = mcnemarsTest(20, 5);

    expect(result.chiSquare).toBeCloseTo(7.84, 10);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('detects non-significant difference (b=10, c=8)', () => {
    const result = mcnemarsTest(10, 8);

    expect(result.chiSquare).toBeCloseTo(1 / 18, 10);
    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it('handles edge case b=0, c=0', () => {
    const result = mcnemarsTest(0, 0);
    expect(result.chiSquare).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.significant).toBe(false);
  });

  it('handles equal discordant pairs', () => {
    const result = mcnemarsTest(15, 15);
    expect(result.chiSquare).toBeCloseTo(1 / 30, 10);
    expect(result.significant).toBe(false);
  });

  it('applies continuity correction', () => {
    const result = mcnemarsTest(5, 3);
    const expected = (Math.abs(5 - 3) - 1) ** 2 / (5 + 3);
    expect(result.chiSquare).toBeCloseTo(expected, 10);
  });

  it('handles b=1, c=0 (small sample)', () => {
    const result = mcnemarsTest(1, 0);
    expect(result.chiSquare).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.significant).toBe(false);
  });

  it('handles large chi-square', () => {
    const result = mcnemarsTest(100, 10);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.001);
  });
});

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
