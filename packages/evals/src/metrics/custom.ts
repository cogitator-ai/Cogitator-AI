import type { MetricFn, EvalCaseResult } from './types';
import { nonFiniteScoreError } from './types';

export interface CustomMetricConfig {
  name: string;
  evaluate: (data: {
    input: string;
    output: string;
    expected?: string;
    context?: Record<string, unknown>;
  }) => Promise<{ score: number; details?: string }> | { score: number; details?: string };
}

/**
 * A metric from an `evaluate` function. Its score is clamped to 0 - 1. When `evaluate` throws or
 * returns a score that is not a finite number (such as NaN from a division by zero), the metric
 * scores 0 and reports the failure in `error`.
 */
export function metric(config: CustomMetricConfig): MetricFn {
  const fn = (async (result: EvalCaseResult) => {
    try {
      const { score, details } = await config.evaluate({
        input: result.case.input,
        output: result.output,
        expected: result.case.expected,
        context: result.case.context,
      });

      const invalid = nonFiniteScoreError(score);
      if (invalid) {
        return {
          name: config.name,
          score: 0,
          details: `evaluate error: ${invalid}`,
          error: invalid,
        };
      }

      return {
        name: config.name,
        score: Math.max(0, Math.min(1, score)),
        ...(details !== undefined && { details }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: config.name,
        score: 0,
        details: `evaluate error: ${message}`,
        error: message,
      };
    }
  }) as MetricFn;

  fn.metricName = config.name;
  return fn;
}
