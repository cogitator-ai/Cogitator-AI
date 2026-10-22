import { mean, stdDev } from './percentiles';
import { isConstant, withoutNoise } from './precision';

/**
 * Cohen's d for paired samples (dz): the mean of the paired differences over their standard
 * deviation, the differences rounded to 12 significant digits. NaN with fewer than 2 differences,
 * plus or minus Infinity when the differences are all the same and not 0, 0 when they are all 0
 */
export function cohensD(differences: readonly number[]): number {
  if (differences.length < 2) return Number.NaN;
  const values = differences.map(withoutNoise);
  if (isConstant(values)) {
    return values[0] === 0 ? 0 : Math.sign(values[0]) * Number.POSITIVE_INFINITY;
  }
  return mean(values) / stdDev(values);
}
