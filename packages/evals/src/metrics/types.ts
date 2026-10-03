import type { EvalCase } from '../schema';

export interface MetricScore {
  name: string;
  score: number;
  details?: string;
  metadata?: Record<string, unknown>;
}

export interface EvalCaseResult {
  case: EvalCase;
  output: string;
  duration: number;
  /** Set when every attempt failed or timed out; `output` is empty in that case */
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
  toolCalls?: readonly {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }[];
}

export type MetricFn = ((result: EvalCaseResult) => Promise<MetricScore>) & {
  metricName: string;
};

export interface StatisticalScore extends MetricScore {
  /**
   * One value per case; the suite aggregates them into mean, percentiles and so
   * on. Without it the suite aggregates `score` alone.
   */
  values?: number[];
}

export type StatisticalMetricFn = ((results: EvalCaseResult[]) => StatisticalScore) & {
  metricName: string;
};
