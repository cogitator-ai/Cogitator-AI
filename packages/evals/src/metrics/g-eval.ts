import { z } from 'zod';
import { parseOptions } from '../options';
import { JudgeUsageError, createJudgeMetric, usageOf } from './llm-judge';
import type { JudgeContext, JudgeSetup, JudgeVerdict, JudgeScore, LLMMetricFn } from './llm-judge';

export interface GEvalOptions {
  name: string;
  /** What a good response does, in your words */
  criteria: string;
  /** The evaluation steps the judge follows. Default: the judge writes them from `criteria` */
  steps?: readonly string[];
  /** The scale the judge scores on, `[min, max]`, normalized to 0 - 1. Default `[1, 5]` */
  scale?: readonly [number, number];
}

const GEvalOptionsSchema = z.object({
  name: z.string().trim().min(1, 'name must not be empty'),
  criteria: z.string().trim().min(1, 'criteria must not be empty'),
  steps: z
    .array(z.string().trim().min(1, 'a step must not be empty'))
    .min(1, 'give at least one step, or leave steps out for the judge to write them')
    .optional(),
  scale: z
    .tuple([z.number(), z.number()])
    .refine(([min, max]) => min < max, 'scale must be [min, max] with min below max')
    .default([1, 5]),
});

const STEP_LINE = /^\s*(?:(?:step\s*)?\d+\s*[.):-]|[-*\u2022])\s*(.*\S)\s*$/i;

/**
 * The steps of a numbered or bulleted list, in order: `1. ...`, `1) ...`, `Step 1: ...`,
 * `- ...`, with Markdown bold (`**1.** ...`, `**Step 1:** ...`) taken off
 */
export function stepsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => STEP_LINE.exec(line.replace(/\*\*|__/g, ''))?.[1])
    .filter((step): step is string => step !== undefined);
}

const hasSteps = (output: string) => stepsOf(output).length > 0;

function stepsRequest(criteria: string): string {
  return `Criteria for evaluating an assistant's response to an input:\n${criteria}\n\nWrite the evaluation steps a careful grader follows to score a response on these criteria, 3 to 6 short steps. Reply with a numbered list, one step per line, and nothing else.`;
}

function scoringPrompt(criteria: string, steps: readonly string[], [min, max]: [number, number]) {
  const numbered = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
  return `You are evaluating an assistant's response on the criteria below.\n\nCriteria:\n${criteria}\n\nEvaluation steps:\n${numbered}\n\nFollow the evaluation steps, then score the <response> from ${min} (does not meet the criteria at all) to ${max} (fully meets them).\n\nRespond with JSON: {"score": <number from ${min} to ${max}>, "reasoning": "<explanation>"}`;
}

/**
 * G-Eval: the judge scores each case on `scale` following evaluation steps, the score normalized
 * to 0 - 1. Without `steps`, the judge writes them from `criteria` once per metric instance,
 * before the first case it scores, and every later case reuses them. A failed generation scores
 * the cases waiting on it as judge errors, and the next case tries again.
 *
 * The original G-Eval weights each score of the scale by the probability of its token, which not
 * every provider exposes. Set `judge.samples` (with a `temperature` above 0) to average several
 * verdicts instead.
 */
export function gEval(opts: GEvalOptions): LLMMetricFn {
  const { name, criteria, steps, scale } = parseOptions(GEvalOptionsSchema, opts, 'gEval');
  const [min, max] = scale;
  let generating: Promise<JudgeSetup> | undefined;

  const generate = async (context: JudgeContext): Promise<JudgeSetup> => {
    const answered = await context.cogitator.run({
      input: stepsRequest(criteria),
      format: 'text',
      accept: hasSteps,
    });
    const usage = usageOf(answered.usage);
    const written = stepsOf(answered.output);
    if (written.length === 0) {
      throw new JudgeUsageError(
        'could not read evaluation steps from the judge, it gave no numbered list',
        usage
      );
    }
    return { systemPrompt: scoringPrompt(criteria, written, scale), ...(usage && { usage }) };
  };

  const setup = async (context: JudgeContext): Promise<JudgeSetup> => {
    if (steps) return { systemPrompt: scoringPrompt(criteria, steps, scale) };
    if (generating) {
      try {
        return { systemPrompt: (await generating).systemPrompt };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
      }
    }
    const started = generate(context).catch((error: unknown) => {
      if (generating === started) generating = undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new JudgeUsageError(
        `gEval could not generate its evaluation steps: ${message}`,
        error instanceof JudgeUsageError ? error.usage : undefined,
        { cause: error }
      );
    });
    generating = started;
    return started;
  };

  const score = ({ score: raw }: JudgeVerdict): JudgeScore => ({
    score: (Math.max(min, Math.min(max, raw)) - min) / (max - min),
  });

  return createJudgeMetric(name, scoringPrompt(criteria, steps ?? [], scale), { setup, score });
}
