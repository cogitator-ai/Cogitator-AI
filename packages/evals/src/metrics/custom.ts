import type {
  MetricFn,
  EvalCaseResult,
  EvalToolCall,
  EvalToolResult,
  EvalTurnResult,
  Passage,
} from './types';
import { nonFiniteScoreError } from './types';

export interface CustomMetricConfig {
  name: string;
  evaluate: (
    data: CustomMetricData
  ) => Promise<{ score: number; details?: string }> | { score: number; details?: string };
}

/** What a custom metric's `evaluate` gets about a case */
export interface CustomMetricData {
  input: string;
  output: string;
  expected?: string;
  context?: Record<string, unknown>;
  /** The tool calls of the run, over every turn */
  toolCalls?: readonly EvalToolCall[];
  /** What the tool calls returned, over every turn */
  toolResults?: readonly EvalToolResult[];
  /** The passages the run retrieved */
  retrieved?: readonly Passage[];
  /** Each turn of a multi-turn case */
  turns?: readonly EvalTurnResult[];
  /** The whole case result, the case itself included */
  result: EvalCaseResult;
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
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        retrieved: result.retrieved,
        turns: result.turns,
        result,
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
