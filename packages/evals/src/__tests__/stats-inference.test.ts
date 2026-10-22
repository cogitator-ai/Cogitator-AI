import { describe, it, expect } from 'vitest';
import { bootstrapCI } from '../stats/bootstrap';
import { cohensD } from '../stats/effect-size';
import { holm } from '../stats/holm';
import { mcnemarExact } from '../stats/mcnemar';
import { wilcoxonSignedRank } from '../stats/wilcoxon';
import { pearson, spearman } from '../stats/correlation';
import { seededRandom } from '../stats/random';
import { averageRanks } from '../stats/ranks';

describe('bootstrapCI', () => {
  const values = [0.1, 0.4, 0.35, 0.8, 0.55, 0.6, 0.2, 0.9, 0.45, 0.5];

  it('is the same on every run with a seed, and brackets the mean', () => {
    const first = bootstrapCI(values, { seed: 7 });
    const again = bootstrapCI(values, { seed: 7 });
    expect(again).toEqual(first);
    expect(first.mean).toBeCloseTo(0.485);
    expect(first.low).toBeLessThan(first.mean);
    expect(first.high).toBeGreaterThan(first.mean);
    expect(first.low).toBeGreaterThan(0.1);
    expect(first.high).toBeLessThan(0.9);
  });

  it('narrows with a lower confidence and differs with another seed', () => {
    const wide = bootstrapCI(values, { seed: 'a', confidence: 0.99 });
    const narrow = bootstrapCI(values, { seed: 'a', confidence: 0.5 });
    expect(narrow.high - narrow.low).toBeLessThan(wide.high - wide.low);
    expect(bootstrapCI(values, { seed: 'b' })).not.toEqual(bootstrapCI(values, { seed: 'a' }));
  });

  it('collapses on constant values and is NaN without values', () => {
    expect(bootstrapCI([0.3, 0.3, 0.3], { seed: 1 })).toEqual({ low: 0.3, high: 0.3, mean: 0.3 });
    const empty = bootstrapCI([]);
    expect([empty.low, empty.high, empty.mean].every(Number.isNaN)).toBe(true);
  });

  it('refuses a confidence outside (0, 1) and resamples that are not a positive integer', () => {
    expect(() => bootstrapCI(values, { confidence: 1 })).toThrow();
    expect(() => bootstrapCI(values, { resamples: 0 })).toThrow();
    expect(() => bootstrapCI(values, { resamples: 1.5 })).toThrow();
  });
});

describe('cohensD', () => {
  it('is the mean difference over its standard deviation', () => {
    expect(cohensD([1, 2, 3])).toBe(2);
    expect(cohensD([-0.2, -0.4, -0.6])).toBeCloseTo(-2);
  });

  it('handles differences that do not vary and too few differences', () => {
    expect(cohensD([0.5, 0.5])).toBe(Number.POSITIVE_INFINITY);
    expect(cohensD([-1, -1])).toBe(Number.NEGATIVE_INFINITY);
    expect(cohensD([0, 0])).toBe(0);
    expect(cohensD([1])).toBeNaN();
  });
});

describe('holm', () => {
  it('adjusts p-values in the order given, keeping them monotone and at most 1', () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holm([0.5, 0.9])).toEqual([1, 1]);
    expect(holm([0.02])).toEqual([0.02]);
    expect(holm([])).toEqual([]);
  });

  it('refuses values that are not p-values', () => {
    expect(() => holm([0.1, Number.NaN])).toThrow('p-values must be between 0 and 1');
    expect(() => holm([1.2])).toThrow();
  });
});

describe('mcnemarExact', () => {
  it('is the two-sided binomial test of the discordant pairs', () => {
    expect(mcnemarExact(0, 6).pValue).toBeCloseTo(0.03125, 10);
    expect(mcnemarExact(3, 12).pValue).toBeCloseTo(0.03515625, 10);
    expect(mcnemarExact(12, 3).pValue).toBeCloseTo(0.03515625, 10);
    expect(mcnemarExact(5, 5).pValue).toBe(1);
    expect(mcnemarExact(0, 0)).toEqual({ pValue: 1, significant: false });
    expect(mcnemarExact(0, 6).significant).toBe(true);
  });

  it('stays finite for many pairs', () => {
    const { pValue } = mcnemarExact(600, 400);
    expect(pValue).toBeGreaterThan(0);
    expect(pValue).toBeLessThan(1e-9);
  });

  it('refuses counts that are not non-negative integers', () => {
    expect(() => mcnemarExact(-1, 2)).toThrow('b must be a non-negative integer');
    expect(() => mcnemarExact(1, 2.5)).toThrow('c must be a non-negative integer');
  });
});

/** The exact two-sided p-value of W+ by trying every sign of every rank */
function bruteForceP(differences: number[]): number {
  const nonzero = differences.filter((d) => d !== 0);
  const ranks = averageRanks(nonzero.map(Math.abs));
  const observed = ranks.reduce((sum, rank, i) => (nonzero[i] > 0 ? sum + rank : sum), 0);
  let lower = 0;
  let upper = 0;
  const outcomes = 2 ** ranks.length;
  for (let mask = 0; mask < outcomes; mask++) {
    const w = ranks.reduce((sum, rank, i) => (mask & (1 << i) ? sum + rank : sum), 0);
    if (w <= observed + 1e-9) lower++;
    if (w >= observed - 1e-9) upper++;
  }
  return Math.min(1, (2 * Math.min(lower, upper)) / outcomes);
}

describe('wilcoxonSignedRank', () => {
  it('gives the exact p-value for few pairs', () => {
    const all = wilcoxonSignedRank([1, 2, 3, 4, 5], [0, 0, 0, 0, 0]);
    expect(all).toMatchObject({ statistic: 15, n: 5, method: 'exact' });
    expect(all.pValue).toBeCloseTo(0.0625, 10);
    expect(wilcoxonSignedRank(Array(10).fill(1), Array(10).fill(0)).pValue).toBeCloseTo(
      2 / 1024,
      10
    );
  });

  it('drops zero differences and ranks ties by their mean rank, exactly', () => {
    const a = [0.5, 0.7, 0.7, 0.2, 0.9, 0.4, 0.6, 0.3];
    const b = [0.5, 0.4, 0.4, 0.4, 0.5, 0.1, 0.8, 0.3];
    const result = wilcoxonSignedRank(a, b);
    const differences = a.map((x, i) => x - b[i]);
    expect(result.n).toBe(6);
    expect(result.method).toBe('exact');
    expect(result.pValue).toBeCloseTo(bruteForceP(differences), 12);
  });

  it('uses the normal approximation above 20 pairs', () => {
    const a = Array.from({ length: 25 }, (_, i) => i + 1);
    const result = wilcoxonSignedRank(a, Array(25).fill(0));
    expect(result).toMatchObject({ statistic: 325, n: 25, method: 'normal' });
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.significant).toBe(true);
  });

  it('is 1 when every difference is 0, and refuses samples of different lengths', () => {
    expect(wilcoxonSignedRank([1, 2], [1, 2])).toMatchObject({
      n: 0,
      pValue: 1,
      significant: false,
    });
    expect(() => wilcoxonSignedRank([1], [1, 2])).toThrow('Sample arrays must have equal length');
  });
});

describe('pearson and spearman', () => {
  it('measure linear and rank agreement', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(pearson([1, 2, 3, 4], [1, 4, 9, 16])).toBeLessThan(1);
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1);
  });

  it('are NaN when a side does not vary or there are fewer than 2 pairs', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(spearman([0.5], [0.5])).toBeNaN();
    expect(() => pearson([1], [1, 2])).toThrow();
  });
});

describe('seededRandom', () => {
  it('repeats its sequence for a seed and stays in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const values = Array.from({ length: 100 }, () => a());
    expect(Array.from({ length: 100 }, () => b())).toEqual(values);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRandom(undefined)).toBe(Math.random);
  });
});
