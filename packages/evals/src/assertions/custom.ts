import type { AssertionFn, AggregatedMetric } from './index';

export function assertion(opts: {
  name: string;
  check: (
    aggregated: Record<string, AggregatedMetric>,
    stats: { total: number; duration: number; cost: number }
  ) => boolean;
  message?: string;
}): AssertionFn {
  return (aggregated, stats) => {
    let passed: boolean;
    try {
      passed = opts.check(aggregated, stats);
    } catch (err) {
      return {
        name: opts.name,
        passed: false,
        message: `Custom assertion '${opts.name}' threw: ${(err as Error).message}`,
      };
    }

    return {
      name: opts.name,
      passed,
      message: passed
        ? `Custom assertion '${opts.name}' passed`
        : (opts.message ?? `Custom assertion '${opts.name}' failed`),
    };
  };
}
