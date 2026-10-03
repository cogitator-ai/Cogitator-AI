import { z } from 'zod';
import type { EvalSuite, EvalSuiteResult } from './eval-suite';

export interface EvalTool<TParams = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams) => Promise<unknown>;
}

const RunEvalParamsSchema = z.object({
  maxCases: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Run only the first N cases of the dataset'),
});

type RunEvalParams = z.infer<typeof RunEvalParamsSchema>;

function buildSummary(result: EvalSuiteResult) {
  const metrics: Record<string, number> = {};
  for (const [name, agg] of Object.entries(result.aggregated)) {
    metrics[name] = agg.mean;
  }

  return {
    success: true as const,
    total: result.stats.total,
    duration: result.stats.duration,
    cost: result.stats.cost,
    metrics,
    assertionsPassed: result.assertions.every((a) => a.passed),
  };
}

export function createRunEvalTool(suite: EvalSuite): EvalTool<RunEvalParams> {
  return {
    name: 'run_eval',
    description: 'Run an evaluation suite against the configured dataset and target',
    parameters: RunEvalParamsSchema,
    execute: async ({ maxCases }) => {
      try {
        const result = await suite.run({ maxCases });
        return buildSummary(result);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function evalTools(suite: EvalSuite): [EvalTool<RunEvalParams>] {
  return [createRunEvalTool(suite)];
}
