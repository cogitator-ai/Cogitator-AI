const LOWER_IS_BETTER_PREFIXES = ['latency', 'cost', 'tokenUsage'];
const LOWER_IS_BETTER_SUFFIXES = ['Duration', 'Latency'];

/**
 * Whether smaller values of a metric are better, as for the built-in `latency`, `cost` and
 * `tokenUsage` statistical metrics. A field path such as `latency.p95` follows its metric.
 */
export function isLowerBetter(metricPath: string): boolean {
  const base = metricPath.split('.')[0];
  return (
    LOWER_IS_BETTER_PREFIXES.some((prefix) => base.startsWith(prefix)) ||
    LOWER_IS_BETTER_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}
