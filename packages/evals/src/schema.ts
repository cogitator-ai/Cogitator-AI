import { z } from 'zod';

/** A tool call a case expects: the tool's name and, optionally, arguments to compare */
export const ExpectedToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const EvalCaseSchema = z.object({
  input: z.string(),
  expected: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Further user turns after `input`, run in order on the same conversation */
  turns: z.array(z.string()).optional(),
  /** The tool calls the agent should make over the whole conversation, in order */
  expectedToolCalls: z.array(ExpectedToolCallSchema).optional(),
  /** Ids or texts of the passages the retrieval should surface */
  expectedPassages: z.array(z.string().min(1)).optional(),
});

export const EvalSuiteConfigSchema = z.object({
  concurrency: z.number().int().min(1).default(5),
  timeout: z.number().int().min(1000).default(30000),
  retries: z.number().int().min(0).max(10).default(0),
  trials: z.number().int().min(1).default(1),
});

/**
 * The part of a Cogitator runtime the judge needs: running an agent. The judge's `usage`, when
 * the run reports it, counts toward the suite's `stats.judgeCost`.
 */
export interface JudgeCogitator {
  run(
    agent: unknown,
    options: { input: string; useMemory?: boolean; signal?: AbortSignal }
  ): Promise<{ output: string; structured?: unknown; usage?: { cost: number } }>;
}

/**
 * Where the judge keeps the verdicts it already gave, by a key of its model, settings and the
 * whole prompt: a case judged again with the same answer reuses the verdict and costs nothing.
 * A store of your own (a file, Redis) keeps verdicts across runs
 */
export interface JudgeCache {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, verdict: string): void | Promise<void>;
}

function isJudgeCache(value: unknown): value is JudgeCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { set?: unknown }).set === 'function'
  );
}

function isJudgeCogitator(value: unknown): value is JudgeCogitator {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { run?: unknown }).run === 'function'
  );
}

export const JudgeConfigSchema = z.object({
  model: z.string(),
  temperature: z.number().default(0),
  maxTokens: z.number().int().positive().optional(),
  /** Runtime that runs the judge; defaults to the `cogitator` of an agent target */
  cogitator: z.custom<JudgeCogitator>(isJudgeCogitator).optional(),
  /**
   * Reuse verdicts: `true` keeps them in memory for the suite, a `JudgeCache` of your own keeps
   * them where it likes. Default: every case is judged afresh
   */
  cache: z.union([z.boolean(), z.custom<JudgeCache>(isJudgeCache)]).optional(),
  /**
   * Most judge calls at once across the run, below the suite's own concurrency times its judge
   * metrics. Default: no limit of its own
   */
  concurrency: z.number().int().positive().optional(),
  /**
   * Verdicts per case and judge metric, a positive integer, 1 by default. The score is the mean
   * of the verdicts the judge gave, their spread is in the score's `details`. Each verdict is
   * cached on its own, so use a `temperature` above 0 for verdicts that differ
   */
  samples: z.number().int().positive().optional(),
});

export const PairwiseOptionsSchema = z.object({
  criteria: z.string().trim().min(1, 'criteria must not be empty').optional(),
  name: z.string().trim().min(1, 'name must not be empty').optional(),
});

export const EvalComparisonConfigSchema = z.object({
  concurrency: z.number().int().min(1).default(5),
  timeout: z.number().int().min(1000).default(30000),
  retries: z.number().int().min(0).max(10).default(0),
  trials: z.number().int().min(1).default(1),
  /** Significance level, after Holm's correction across the compared metrics */
  alpha: z.number().gt(0).lt(1).default(0.05),
  /** Test for metrics that are not binary, and for latency and cost */
  test: z.enum(['t', 'wilcoxon']).default('t'),
  /** Seeds the bootstrap of the confidence intervals, so they are the same on every run */
  seed: z.union([z.number(), z.string()]).optional(),
  pairwise: PairwiseOptionsSchema.optional(),
});

export type ExpectedToolCall = z.output<typeof ExpectedToolCallSchema>;
export type EvalCase = z.output<typeof EvalCaseSchema>;
export type EvalCaseInput = z.input<typeof EvalCaseSchema>;
export type EvalSuiteConfig = z.output<typeof EvalSuiteConfigSchema>;
export type EvalSuiteConfigInput = z.input<typeof EvalSuiteConfigSchema>;
export type JudgeConfig = z.output<typeof JudgeConfigSchema>;
export type JudgeConfigInput = z.input<typeof JudgeConfigSchema>;
export type EvalComparisonConfig = z.output<typeof EvalComparisonConfigSchema>;
