import { mean, stdDev } from './percentiles';

/**
 * Cohen's d for paired samples (dz): the mean of the paired differences over their standard
 * deviation. NaN with fewer than 2 differences, plus or minus Infinity when the differences are
 * all the same and not 0, 0 when they are all 0
 */
export function cohensD(differences: readonly number[]): number {
  if (differences.length < 2) return Number.NaN;
  const values = [...differences];
  const m = mean(values);
  const sd = stdDev(values);
  if (sd === 0) return m === 0 ? 0 : Math.sign(m) * Number.POSITIVE_INFINITY;
  return m / sd;
}
