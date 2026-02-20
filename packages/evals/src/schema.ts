import { z } from 'zod';

export const EvalCaseSchema = z.object({
  input: z.string(),
  expected: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const EvalSuiteConfigSchema = z.object({
  concurrency: z.number().int().min(1).default(5),
  timeout: z.number().int().min(1000).default(30000),
  retries: z.number().int().min(0).max(10).default(0),
});

export const JudgeConfigSchema = z.object({
  model: z.string(),
  temperature: z.number().default(0),
  maxTokens: z.number().int().positive().optional(),
});

export const EvalComparisonConfigSchema = z.object({
  concurrency: z.number().int().min(1).default(5),
  timeout: z.number().int().min(1000).default(30000),
  retries: z.number().int().min(0).max(10).default(0),
});

export type EvalCase = z.output<typeof EvalCaseSchema>;
export type EvalCaseInput = z.input<typeof EvalCaseSchema>;
export type EvalSuiteConfig = z.output<typeof EvalSuiteConfigSchema>;
export type EvalSuiteConfigInput = z.input<typeof EvalSuiteConfigSchema>;
export type JudgeConfig = z.output<typeof JudgeConfigSchema>;
export type EvalComparisonConfig = z.output<typeof EvalComparisonConfigSchema>;
