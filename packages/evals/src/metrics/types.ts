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

export type StatisticalMetricFn = ((results: EvalCaseResult[]) => MetricScore) & {
  metricName: string;
};
