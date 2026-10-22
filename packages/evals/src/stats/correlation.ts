import { mean } from './percentiles';
import { averageRanks } from './ranks';

function assertPaired(x: readonly number[], y: readonly number[]): void {
  if (x.length !== y.length) throw new Error('Sample arrays must have equal length');
}

/**
 * Pearson's correlation of paired values, from -1 to 1. NaN when there are fewer than 2 pairs
 * or either side does not vary
 */
export function pearson(x: readonly number[], y: readonly number[]): number {
  assertPaired(x, y);
  if (x.length < 2) return Number.NaN;
  const mx = mean([...x]);
  const my = mean([...y]);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return Number.NaN;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * Spearman's rank correlation of paired values: Pearson's correlation of their ranks, ties
 * sharing the mean of their ranks. NaN when Pearson's would be
 */
export function spearman(x: readonly number[], y: readonly number[]): number {
  assertPaired(x, y);
  return pearson(averageRanks(x), averageRanks(y));
}
