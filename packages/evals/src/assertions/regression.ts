import * as fs from 'node:fs';
import type { AssertionFn } from './index';

function isLowerBetter(name: string): boolean {
  return name.startsWith('latency') || name.startsWith('cost');
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

    for (const [metric, baselineValue] of Object.entries(baseline)) {
      const agg = aggregated[metric];
      if (!agg) continue;

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

    return {
      name: 'noRegression',
      passed: true,
      message: 'All metrics within tolerance of baseline',
    };
  };
}
