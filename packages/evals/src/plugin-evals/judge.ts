import {
  bindJudgeContext,
  createJudgeMetric,
  judgeContextFor,
  type JudgeRunOptions,
  type JudgeVerdict,
} from '../metrics/llm-judge';
import { tagged } from '../metrics/judge-prompt';
import { JudgeConfigSchema, type JudgeCogitator } from '../schema';
import type { PluginEvalVote } from './types';

/** Votes per `llm` or `baseline` grader: the grader passes on a majority of PASS votes */
export const JUDGE_VOTES = 3;

/** What a judge grader asks */
export type JudgeQuestion =
  | { kind: 'llm'; criteria: string; evidence: string; prompt: string }
  | { kind: 'baseline'; criteria: string; reference: string; run: string; prompt: string };

/** The judge's answer: every vote and what the votes cost */
export interface JudgeAnswer {
  votes: PluginEvalVote[];
  costUsd: number;
}

/** Asks the judge model, three votes per question */
export interface PluginEvalJudge {
  /** Asks `question`, its judge runs aborted with `signal` */
  ask(question: JudgeQuestion, signal?: AbortSignal): Promise<JudgeAnswer>;
}

const LLM_INSTRUCTIONS = `You grade one run of an AI agent against a rubric. Read the <rubric> and the <evidence> from the run (and the <task> the agent was given), then decide whether the evidence meets the rubric.

Respond with JSON: {"score": 1 for PASS or 0 for FAIL, "reasoning": "<one or two sentences>"}`;

const BASELINE_INSTRUCTIONS = `You compare one run of an AI agent with a reference run of the same <task>. Read the <criteria>, the <reference> transcript and the <run> transcript, then decide whether the run satisfies the criteria at least as well as the reference does.

Respond with JSON: {"score": 1 for PASS (at least as well) or 0 for FAIL (worse), "reasoning": "<one or two sentences>"}`;

function verdictScore(verdict: JudgeVerdict): { score: number } | { error: string } {
  if (verdict.score === 1 || verdict.score === 0) return { score: verdict.score };
  return { error: `the judge gave ${verdict.score}, which is neither 1 (PASS) nor 0 (FAIL)` };
}

function messageOf(question: JudgeQuestion): string {
  const task = tagged('task', question.prompt);
  if (question.kind === 'llm') {
    return `${task}\n${tagged('rubric', question.criteria)}\n${tagged('evidence', question.evidence)}`;
  }
  return `${task}\n${tagged('criteria', question.criteria)}\n${tagged('reference', question.reference)}\n${tagged('run', question.run)}`;
}

interface SampleRecord {
  score?: unknown;
  reasoning?: unknown;
  error?: unknown;
}

function votesOf(
  metadata: Record<string, unknown> | undefined,
  fallback: string
): PluginEvalVote[] {
  const samples = metadata?.samples;
  if (!Array.isArray(samples))
    return Array.from({ length: JUDGE_VOTES }, () => ({ verdict: 'ERROR', reasoning: fallback }));
  return samples.map((sample: SampleRecord) => {
    if (typeof sample.score !== 'number') {
      return {
        verdict: 'ERROR',
        reasoning: typeof sample.error === 'string' ? sample.error : fallback,
      };
    }
    return {
      verdict: sample.score === 1 ? 'PASS' : 'FAIL',
      ...(typeof sample.reasoning === 'string' && { reasoning: sample.reasoning }),
    };
  });
}

/**
 * A judge on `model`, run by `cogitator`: each question is asked three times as a judge metric of
 * this package, at temperature 1 so the votes are independent samples
 */
export function createPluginEvalJudge(cogitator: JudgeCogitator, model: string): PluginEvalJudge {
  const context = judgeContextFor(
    cogitator,
    JudgeConfigSchema.parse({ model, temperature: 1, samples: JUDGE_VOTES })
  );
  return {
    async ask(question, signal) {
      const message = messageOf(question);
      const metric = createJudgeMetric(
        question.kind === 'llm' ? 'llm' : 'baseline',
        question.kind === 'llm' ? LLM_INSTRUCTIONS : BASELINE_INSTRUCTIONS,
        { message: () => ({ message }), score: verdictScore }
      );
      signal?.throwIfAborted();
      const scoped = signal
        ? {
            ...context,
            cogitator: {
              run: (options: JudgeRunOptions) => context.cogitator.run({ ...options, signal }),
            },
          }
        : context;
      const scored = await bindJudgeContext(
        metric,
        scoped
      )({
        case: { input: question.prompt },
        output: '',
        duration: 0,
      });
      signal?.throwIfAborted();
      return {
        votes: votesOf(scored.metadata, scored.error ?? scored.details ?? 'no verdict'),
        costUsd: scored.usage?.cost ?? 0,
      };
    },
  };
}
