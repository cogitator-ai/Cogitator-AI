import * as fs from 'node:fs';
import type { AssertionFn } from './index';

function isLowerBetter(name: string): boolean {
  const base = name.split('.')[0];
  return (
    base.startsWith('latency') ||
    base.startsWith('cost') ||
    base.endsWith('Duration') ||
    base.endsWith('Latency')
  );
}

export function noRegression(baselinePath: string, opts?: { tolerance?: number }): AssertionFn {
  return (aggregated, _stats) => {
    let baseline: Record<string, number>;
    try {
      const raw = fs.readFileSync(baselinePath, 'utf-8');
      baseline = JSON.parse(raw);
    } catch {
      return {
        name: 'noRegression',
        passed: false,
        message: `Failed to read baseline file: ${baselinePath}`,
      };
    }

    const tolerance = opts?.tolerance ?? 0.05;
    let validated = 0;

    for (const [metric, baselineValue] of Object.entries(baseline)) {
      const agg = aggregated[metric];
      if (!agg) continue;

      validated++;
      const actual = agg.mean;
      const lowerBetter = isLowerBetter(metric);

      if (lowerBetter) {
        const limit = baselineValue * (1 + tolerance);
        if (actual > limit) {
          return {
            name: 'noRegression',
            passed: false,
            message: `Regression in '${metric}': ${actual} > ${limit} (baseline ${baselineValue}, tolerance ${tolerance * 100}%)`,
            actual,
            expected: limit,
          };
        }
      } else {
        const limit = baselineValue * (1 - tolerance);
        if (actual < limit) {
          return {
            name: 'noRegression',
            passed: false,
            message: `Regression in '${metric}': ${actual} < ${limit} (baseline ${baselineValue}, tolerance ${tolerance * 100}%)`,
            actual,
            expected: limit,
          };
        }
      }
    }

    if (validated === 0) {
      return {
        name: 'noRegression',
        passed: false,
        message: 'No baseline metrics found in current results — cannot validate regression',
      };
    }

    return {
      name: 'noRegression',
      passed: true,
      message: 'All metrics within tolerance of baseline',
    };
  };
}
