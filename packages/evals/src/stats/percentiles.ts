export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) {
    const d = v - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (values.length - 1));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) return sorted[lower];

  const fraction = rank - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function aggregate(values: number[]): {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  p50: number;
  p95: number;
  p99: number;
} {
  if (values.length === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);

  return {
    mean: mean(values),
    median: percentile(values, 0.5),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: stdDev(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}
