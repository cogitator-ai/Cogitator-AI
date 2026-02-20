import type { MetricFn, EvalCaseResult } from './types';

export interface CustomMetricConfig {
  name: string;
  evaluate: (data: {
    input: string;
    output: string;
    expected?: string;
    context?: Record<string, unknown>;
  }) => Promise<{ score: number; details?: string }> | { score: number; details?: string };
}

export function metric(config: CustomMetricConfig): MetricFn {
  const fn = (async (result: EvalCaseResult) => {
    try {
      const { score, details } = await config.evaluate({
        input: result.case.input,
        output: result.output,
        expected: result.case.expected,
        context: result.case.context,
      });

      const clamped = Math.max(0, Math.min(1, score));

      return {
        name: config.name,
        score: clamped,
        ...(details !== undefined && { details }),
      };
    } catch (err) {
      return {
        name: config.name,
        score: 0,
        details: `evaluate error: ${(err as Error).message}`,
      };
    }
  }) as MetricFn;

  fn.metricName = config.name;
  return fn;
}
