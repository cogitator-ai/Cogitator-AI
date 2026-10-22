import { z } from 'zod';
import { EvalCaseSchema } from '../schema';

/** The `format` every run file carries */
export const EVAL_RUN_FORMAT = 'cogitator.eval-run';

/** The version of the run file format this package writes and reads */
export const EVAL_RUN_VERSION = 1;

/** A figure JSON writes as `null` when it is not a finite number, such as an unscored mean */
const figure = z
  .number()
  .nullable()
  .transform((value) => value ?? Number.NaN);

export const RunPromptSchema = z.object({
  key: z.string().min(1),
  versionId: z.string().optional(),
  version: z.number().optional(),
  abTest: z.object({ id: z.string(), variant: z.enum(['control', 'treatment']) }).optional(),
});

const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cost: z.number(),
});

const ScoreSchema = z.object({
  name: z.string(),
  score: z.number(),
  details: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  usage: UsageSchema.optional(),
});

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

const TurnSchema = z.object({
  input: z.string(),
  output: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  traceId: z.string().optional(),
  prompt: RunPromptSchema.optional(),
  error: z.string().optional(),
});

const CaseResultSchema = z.object({
  case: EvalCaseSchema,
  output: z.string(),
  duration: z.number(),
  error: z.string().optional(),
  attempts: z.number().int().optional(),
  usage: UsageSchema.extend({ duration: z.number() }).optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolResults: z
    .array(
      z.object({
        callId: z.string(),
        name: z.string(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  retrieved: z
    .array(
      z.object({
        id: z.string().optional(),
        content: z.string(),
        score: z.number().optional(),
        source: z.string().optional(),
      })
    )
    .optional(),
  turns: z.array(TurnSchema).optional(),
  traceId: z.string().optional(),
  prompt: RunPromptSchema.optional(),
  truncated: z.boolean().optional(),
  iterationLimitReached: z.boolean().optional(),
  paused: z.boolean().optional(),
  scores: z.array(ScoreSchema),
});

const RunCaseSchema = CaseResultSchema.extend({
  /** SHA-256 of the canonical JSON of the case's `{ input, turns, expected }` */
  caseKey: z.string().regex(/^[0-9a-f]{64}$/),
  trials: z.array(CaseResultSchema).optional(),
});

const RunConfigSchema = z.object({
  metrics: z.array(z.string()),
  statisticalMetrics: z.array(z.string()),
  judge: z
    .object({
      model: z.string(),
      temperature: z.number(),
      samples: z.number().int().positive().optional(),
    })
    .optional(),
  trials: z.number().int().min(1),
  concurrency: z.number().int().min(1),
  target: z.object({
    kind: z.enum(['fn', 'agent']),
    /** The agent's name, for an agent target */
    name: z.string().optional(),
    /** The agent's model, for an agent target that sets one */
    model: z.string().optional(),
  }),
});

const AggregatedSchema = z.object({
  name: z.string(),
  mean: figure,
  median: figure,
  min: figure,
  max: figure,
  stdDev: figure,
  p50: figure,
  p95: figure,
  p99: figure,
  count: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const AssertionSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  message: z.string(),
  actual: figure.optional(),
  expected: figure.optional(),
});

const StatsSchema = z.object({
  total: z.number().int(),
  errors: z.number().int(),
  metricErrors: z.number().int(),
  duration: z.number(),
  cost: z.number(),
  targetCost: z.number(),
  judgeCost: z.number(),
});

/** JSON-serializable metadata: object keys holding `undefined` are dropped, as JSON drops them */
export const JsonMetadataSchema = z.preprocess(withoutUndefined, z.record(z.string(), z.json()));

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (typeof value !== 'object' || value === null) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)])
  );
}

export const EvalRunSchema = z.object({
  format: z.literal(EVAL_RUN_FORMAT),
  version: z.literal(EVAL_RUN_VERSION),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  name: z.string().optional(),
  metadata: JsonMetadataSchema.optional(),
  dataset: z.object({
    /** SHA-256 of the canonical JSON of the cases run, in order */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    cases: z.number().int().min(0),
  }),
  config: RunConfigSchema,
  /** The distinct versioned instructions the agent runs used */
  prompts: z.array(RunPromptSchema),
  results: z.array(RunCaseSchema),
  aggregated: z.record(z.string(), AggregatedSchema),
  assertions: z.array(AssertionSchema),
  stats: StatsSchema,
});

/** A saved suite run, as `loadRun()` returns it */
export type EvalRun = z.output<typeof EvalRunSchema>;
/** A case result of a saved run, with its `caseKey` */
export type EvalRunCase = z.output<typeof RunCaseSchema>;
/** What a saved run records of the suite's configuration */
export type EvalRunConfig = z.output<typeof RunConfigSchema>;
/** JSON-serializable metadata of an experiment */
export type JsonMetadata = z.output<typeof JsonMetadataSchema>;

/** The options of a suite that describe the experiment it runs */
export const ExperimentOptionsSchema = z.object({
  name: z.string().trim().min(1, 'name must not be empty').optional(),
  metadata: JsonMetadataSchema.optional(),
});
