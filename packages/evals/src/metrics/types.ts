import type { EvalCase } from '../schema';

/** Tokens and USD a model call spent, such as the LLM judge's */
export interface MetricUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface MetricScore {
  name: string;
  score: number;
  details?: string;
  metadata?: Record<string, unknown>;
  /**
   * Set when the metric itself failed: it threw, returned a score that is not a finite number,
   * or its judge gave no verdict that could be read. `score` is 0 then.
   */
  error?: string;
  /** What computing the score cost, for metrics that call a model such as the LLM judge */
  usage?: MetricUsage;
}

export interface EvalCaseResult {
  case: EvalCase;
  output: string;
  duration: number;
  /** Set when every attempt failed or timed out; `output` is empty in that case */
  error?: string;
  /** How many attempts the case took, retries included */
  attempts?: number;
  /**
   * What the target spent on the case, summed over every attempt that reported usage, so an
   * attempt that finished after it timed out still counts
   */
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

/** Options every built-in per-case metric factory takes */
export interface MetricOptions {
  /**
   * The name the metric reports and aggregates under. Give one to tell apart two metrics of the
   * same kind, such as two `regex()` checks: a suite refuses two metrics with the same name.
   */
  name?: string;
}

/** Why a score is not usable, or undefined when it is a finite number */
export function nonFiniteScoreError(score: unknown): string | undefined {
  if (typeof score === 'number' && Number.isFinite(score)) return undefined;
  return `score ${String(score)} is not a finite number`;
}
