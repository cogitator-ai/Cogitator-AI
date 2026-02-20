import type { AssertionFn, AggregatedMetric } from './index';

function isLowerBetter(name: string): boolean {
  const base = name.split('.')[0];
  return (
    base.startsWith('latency') ||
    base.startsWith('cost') ||
    base.endsWith('Duration') ||
    base.endsWith('Latency')
  );
}

function resolve(
  aggregated: Record<string, AggregatedMetric>,
  path: string
): { value: number; found: boolean } {
  const parts = path.split('.');
  const metric = aggregated[parts[0]];
  if (!metric) return { value: 0, found: false };

  if (parts.length === 1) return { value: metric.mean, found: true };

  const field = parts[1] as keyof AggregatedMetric;
  const val = metric[field];
  if (typeof val !== 'number') return { value: 0, found: false };

  return { value: val, found: true };
}

export function threshold(metricName: string, value: number): AssertionFn {
  return (aggregated, _stats) => {
    const { value: actual, found } = resolve(aggregated, metricName);

    if (!found) {
      return {
        name: `threshold(${metricName})`,
        passed: false,
        message: `Metric '${metricName}' not found in aggregated results`,
      };
    }

    const lowerBetter = isLowerBetter(metricName);
    const passed = lowerBetter ? actual <= value : actual >= value;
    const direction = lowerBetter ? '<=' : '>=';

    return {
      name: `threshold(${metricName})`,
      passed,
      message: passed
        ? `${metricName} = ${actual} ${direction} ${value}`
        : `${metricName} = ${actual}, expected ${direction} ${value}`,
      actual,
      expected: value,
    };
  };
}
