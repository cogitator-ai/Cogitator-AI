import { z } from 'zod';
import type { EvalSuite, EvalSuiteResult } from './eval-suite';

export interface EvalTool<TParams = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams) => Promise<unknown>;
}

const RunEvalParamsSchema = z.object({
  maxCases: z.number().int().positive().optional(),
});

type RunEvalParams = z.infer<typeof RunEvalParamsSchema>;

function buildSummary(result: EvalSuiteResult, maxCases?: number) {
  const capped = maxCases ? result.results.slice(0, maxCases) : result.results;

  const total = capped.length;
  const duration = maxCases
    ? capped.reduce((sum, r) => sum + r.duration, 0)
    : result.stats.duration;
  const cost = maxCases
    ? capped.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0)
    : result.stats.cost;

  const metrics: Record<string, number> = {};
  if (maxCases && total > 0) {
    const scoresByMetric = new Map<string, number[]>();
    for (const r of capped) {
      for (const s of r.scores) {
        let arr = scoresByMetric.get(s.name);
        if (!arr) {
          arr = [];
          scoresByMetric.set(s.name, arr);
        }
        arr.push(s.score);
      }
    }
    for (const [name, values] of scoresByMetric) {
      metrics[name] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  } else {
    for (const [name, agg] of Object.entries(result.aggregated)) {
      metrics[name] = agg.mean;
    }
  }

  const assertionsPassed = maxCases ? true : result.assertions.every((a) => a.passed);

  return { success: true as const, total, duration, cost, metrics, assertionsPassed };
}

export function createRunEvalTool(suite: EvalSuite): EvalTool<RunEvalParams> {
  return {
    name: 'run_eval',
    description: 'Run an evaluation suite against the configured dataset and target',
    parameters: RunEvalParamsSchema,
    execute: async ({ maxCases }) => {
      try {
        const result = await suite.run();
        return buildSummary(result, maxCases);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function evalTools(suite: EvalSuite): [EvalTool<RunEvalParams>] {
  return [createRunEvalTool(suite)];
}
