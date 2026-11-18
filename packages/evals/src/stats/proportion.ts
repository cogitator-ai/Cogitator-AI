import { z } from 'zod';
import { normalQuantile } from './normal';

export const ProportionOptionsSchema = z.object({
  confidence: z.number().gt(0).lt(1).default(0.95),
});

export type ProportionOptions = z.input<typeof ProportionOptionsSchema>;

export interface ProportionInterval {
  /** Lower bound of the interval */
  low: number;
  /** Upper bound of the interval */
  high: number;
  /** The share itself: `successes / total` */
  rate: number;
}

/**
 * Wilson score confidence interval of a share: `successes` out of `total` trials that each
 * pass or fail, such as a pass rate. It stays inside 0 and 1 and keeps its width at the ends,
 * where a bootstrap of the same outcomes collapses to a point: 10 passes out of 10 give
 * 0.72 to 1, not 1 to 1. All NaN for no trials
 *
 * @throws Error when the counts are not whole numbers with `0 <= successes <= total`
 */
export function wilsonCI(
  successes: number,
  total: number,
  options: ProportionOptions = {}
): ProportionInterval {
  const { confidence } = ProportionOptionsSchema.parse(options);
  for (const [label, count] of [
    ['successes', successes],
    ['total', total],
  ] as const) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${label} must be a non-negative integer, got ${count}`);
    }
  }
  if (successes > total) {
    throw new Error(`successes (${successes}) cannot exceed total (${total})`);
  }
  if (total === 0) return { low: Number.NaN, high: Number.NaN, rate: Number.NaN };
  const rate = successes / total;
  const z = -normalQuantile((1 - confidence) / 2);
  const z2 = z * z;
  const scale = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / scale;
  const half = (z * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total))) / scale;
  return {
    low: successes === 0 ? 0 : Math.max(0, center - half),
    high: successes === total ? 1 : Math.min(1, center + half),
    rate,
  };
}
