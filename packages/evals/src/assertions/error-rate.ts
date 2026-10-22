import type { AssertionFn } from './index';

/**
 * Passes while at most `rate` (0 to 1) of the cases errored, every attempt failed or timed out.
 * Errored cases are not scored, so a metric's mean says nothing about them: pair metric
 * thresholds with this to catch a run where the target mostly failed.
 */
export function maxErrorRate(rate: number): AssertionFn {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`maxErrorRate takes a rate from 0 to 1, got ${rate}`);
  }
  const name = `maxErrorRate(${rate})`;
  const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
  return (_aggregated, stats) => {
    const errors = stats.errors ?? 0;
    const actual = stats.total === 0 ? 0 : errors / stats.total;
    const passed = actual <= rate;
    return {
      name,
      passed,
      message: passed
        ? `${errors} of ${stats.total} cases errored, at most ${percent(rate)} allowed`
        : `${errors} of ${stats.total} cases errored (${percent(actual)}), expected at most ${percent(rate)}`,
      actual,
      expected: rate,
    };
  };
}
