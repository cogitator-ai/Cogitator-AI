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

/** A tool call the agent made */
export interface EvalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** What a tool call returned, as the run's `onToolResult` reported it */
export interface EvalToolResult {
  callId: string;
  name: string;
  result?: unknown;
  error?: string;
}

/** A passage the agent's retrieval surfaced, such as one result of a `rag_search` call */
export interface Passage {
  id?: string;
  content: string;
  score?: number;
  source?: string;
}

/** The versioned instructions an agent run used, as its `RunResult.prompt` reports them */
export interface EvalPrompt {
  /** The agent's `id` when it was set explicitly, else its `name` */
  key: string;
  versionId?: string;
  version?: number;
  abTest?: { id: string; variant: 'control' | 'treatment' };
}

/** One user turn of a multi-turn case and the answer to it */
export interface EvalTurnResult {
  input: string;
  output: string;
  toolCalls?: readonly EvalToolCall[];
  /** The trace of the agent run that answered the turn */
  traceId?: string;
  /** The versioned instructions the agent run of the turn used */
  prompt?: EvalPrompt;
  /** Set on the turn that failed, the last one the case ran */
  error?: string;
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
  /** The tool calls of the run, over every turn */
  toolCalls?: readonly EvalToolCall[];
  /** What the tool calls returned, over every turn, raw */
  toolResults?: readonly EvalToolResult[];
  /** The passages the tool results surfaced, over every turn, in the order they came */
  retrieved?: readonly Passage[];
  /** Each turn of a case with `turns`: `input` first, then the further turns */
  turns?: readonly EvalTurnResult[];
  /**
   * The trace of the agent run, from its `RunResult.trace.traceId`, to find the run in a trace
   * viewer. With `turns`, the last turn's. A `fn` target has none
   */
  traceId?: string;
  /**
   * The versioned instructions the agent run used, from its `RunResult.prompt`. With `turns`, the
   * last turn's. Set when the Cogitator versions instructions (`cogitator.prompts`)
   */
  prompt?: EvalPrompt;
  /**
   * Every run of the case when the suite runs several `trials`, each with its own scores. The
   * case result itself is the first of them
   */
  trials?: ReadonlyArray<EvalCaseResult & { scores: MetricScore[] }>;
  /** The agent's answer stopped at its output token limit */
  truncated?: boolean;
  /** Tool calls used up the agent's `maxIterations` before it answered */
  iterationLimitReached?: boolean;
  /** The run paused for tool approvals, so `output` holds no answer */
  paused?: boolean;
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

/** A case result with the scores of its metrics, as a suite run returns it */
export type ScoredCaseResult = EvalCaseResult & { scores: MetricScore[] };

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
