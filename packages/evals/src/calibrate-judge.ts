import { z } from 'zod';
import { isLLMMetric } from './eval-suite';
import type { EvalCaseResult, MetricFn } from './metrics/types';
import { nonFiniteScoreError } from './metrics/types';
import { bindJudgeContext, judgeContextFor } from './metrics/llm-judge';
import { JudgeConfigSchema } from './schema';
import type { JudgeConfigInput } from './schema';
import { parseOptions } from './options';
import { pearson, spearman } from './stats/correlation';
import { mean } from './stats/percentiles';

/** An answer labelled by a person, with the score the metric should give it, from 0 to 1 */
export interface CalibrationExample {
  input: string;
  output: string;
  expected?: string;
  context?: Record<string, unknown>;
  label: number;
}

export interface CalibrateJudgeOptions {
  /** Where a score or label counts as a pass for `kappa`, 0.5 by default */
  threshold?: number;
  /** Binds an unbound judge metric, run by `judge.cogitator` */
  judge?: JudgeConfigInput;
  /** Examples scored at once, 5 by default */
  concurrency?: number;
}

export interface CalibrationCase {
  /** Position of the example */
  index: number;
  label: number;
  /** The metric's score, absent when it failed */
  score?: number;
  details?: string;
  error?: string;
}

export interface JudgeCalibration {
  /** Examples the metric scored, those it failed on left out of the figures */
  n: number;
  /** Examples the metric failed on */
  errors: number;
  /** Pearson's correlation of scores and labels, NaN when either does not vary */
  pearson: number;
  /** Spearman's rank correlation of scores and labels */
  spearman: number;
  /** Mean absolute error of the scores against the labels */
  mae: number;
  /**
   * Cohen's kappa of pass and fail, a score or label passing at `threshold` or more. NaN when
   * agreement by chance is certain, every score and label being on one side
   */
  kappa: number;
  perCase: CalibrationCase[];
}

const CalibrationExampleSchema = z.object({
  input: z.string(),
  output: z.string(),
  expected: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  label: z.number().min(0).max(1),
});

const CalibrateJudgeOptionsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.5),
  concurrency: z.number().int().positive().default(5),
});

/** Cohen's kappa of two binary raters */
function binaryKappa(a: readonly boolean[], b: readonly boolean[]): number {
  const n = a.length;
  if (n === 0) return Number.NaN;
  let agree = 0;
  let aPass = 0;
  let bPass = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]) aPass++;
    if (b[i]) bPass++;
  }
  const observed = agree / n;
  const chance = (aPass / n) * (bPass / n) + (1 - aPass / n) * (1 - bPass / n);
  return chance === 1 ? Number.NaN : (observed - chance) / (1 - chance);
}

function bindMetric(metric: MetricFn, judge: JudgeConfigInput | undefined): MetricFn {
  if (!isLLMMetric(metric)) return metric;
  if (!judge) {
    throw new Error('calibrateJudge needs options.judge to run an unbound judge metric');
  }
  const config = JudgeConfigSchema.parse(judge);
  if (!config.cogitator) {
    throw new Error('calibrateJudge needs judge.cogitator to run the judge');
  }
  return bindJudgeContext(metric, judgeContextFor(config.cogitator, config));
}

async function scoreExample(
  metric: MetricFn,
  example: z.output<typeof CalibrationExampleSchema>,
  index: number
): Promise<CalibrationCase> {
  const result: EvalCaseResult = {
    case: {
      input: example.input,
      ...(example.expected !== undefined && { expected: example.expected }),
      ...(example.context !== undefined && { context: example.context }),
    },
    output: example.output,
    duration: 0,
  };
  try {
    const scored = await metric(result);
    const invalid = scored.error ?? nonFiniteScoreError(scored.score);
    if (invalid !== undefined) return { index, label: example.label, error: invalid };
    return {
      index,
      label: example.label,
      score: scored.score,
      ...(scored.details !== undefined && { details: scored.details }),
    };
  } catch (error) {
    return {
      index,
      label: example.label,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * How well a metric, usually an LLM judge, agrees with labels people gave: it scores each
 * labelled example and compares the scores with the labels. Bind a judge metric first with
 * `bindJudgeContext`, or pass `judge` with a `cogitator`. Examples the metric fails on are
 * reported and left out of the figures
 */
export async function calibrateJudge(
  metric: MetricFn,
  examples: readonly CalibrationExample[],
  options: CalibrateJudgeOptions = {}
): Promise<JudgeCalibration> {
  const { threshold, concurrency } = parseOptions(
    CalibrateJudgeOptionsSchema,
    { threshold: options.threshold, concurrency: options.concurrency },
    'calibrateJudge'
  );
  const parsed = parseOptions(
    z.array(CalibrationExampleSchema),
    examples,
    'calibrateJudge examples'
  );
  const bound = bindMetric(metric, options.judge);

  const perCase = new Array<CalibrationCase>(parsed.length);
  let next = 0;
  const worker = async () => {
    while (next < parsed.length) {
      const at = next++;
      perCase[at] = await scoreExample(bound, parsed[at], at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, parsed.length) }, worker));

  const scored = perCase.filter(
    (one): one is CalibrationCase & { score: number } => one.score !== undefined
  );
  const scores = scored.map((one) => one.score);
  const labels = scored.map((one) => one.label);
  return {
    n: scored.length,
    errors: perCase.length - scored.length,
    pearson: pearson(scores, labels),
    spearman: spearman(scores, labels),
    mae:
      scored.length === 0 ? Number.NaN : mean(scored.map((one) => Math.abs(one.score - one.label))),
    kappa: binaryKappa(
      scores.map((score) => score >= threshold),
      labels.map((label) => label >= threshold)
    ),
    perCase,
  };
}
