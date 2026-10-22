import { z } from 'zod';
import { mean, percentile } from './percentiles';
import { seededRandom } from './random';

export const BootstrapOptionsSchema = z.object({
  confidence: z.number().gt(0).lt(1).default(0.95),
  resamples: z.number().int().positive().default(2000),
  seed: z.union([z.number(), z.string()]).optional(),
});

export type BootstrapOptions = z.input<typeof BootstrapOptionsSchema>;

export interface BootstrapInterval {
  /** Lower bound of the interval */
  low: number;
  /** Upper bound of the interval */
  high: number;
  /** Mean of the values themselves */
  mean: number;
}

/**
 * Percentile bootstrap confidence interval of the mean: the values are resampled with
 * replacement `resamples` times and the interval spans the middle `confidence` share of the
 * resampled means. With `seed` the interval is the same on every run. All NaN for no values
 */
export function bootstrapCI(
  values: readonly number[],
  options: BootstrapOptions = {}
): BootstrapInterval {
  const { confidence, resamples, seed } = BootstrapOptionsSchema.parse(options);
  if (values.length === 0) return { low: Number.NaN, high: Number.NaN, mean: Number.NaN };
  const random = seededRandom(seed);
  const n = values.length;
  const means = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(random() * n)];
    means[r] = sum / n;
  }
  const tail = (1 - confidence) / 2;
  return {
    low: percentile(means, tail),
    high: percentile(means, 1 - tail),
    mean: mean([...values]),
  };
}
