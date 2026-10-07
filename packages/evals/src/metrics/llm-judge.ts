import { z } from 'zod';
import type { JudgeCogitator, JudgeConfig } from '../schema';
import type { MetricFn, EvalCaseResult, MetricScore, MetricOptions, MetricUsage } from './types';

export interface JudgeContext {
  cogitator: {
    run: (opts: { input: string }) => Promise<{ output: string; usage?: MetricUsage }>;
  };
  judgeConfig: JudgeConfig;
}

export interface LLMMetricFn extends MetricFn {
  readonly requiresJudge: true;
  readonly __judgeSystemPrompt: string;
  readonly __judgeName: string;
}

const FENCED_BLOCK = /```[a-z]*\s*([\s\S]*?)```/gi;
const JSON_OBJECT = /\{[\s\S]*\}/;
const LABELLED_SCORE =
  /\bscore\b["']?\s*(?:is|of|[:=])?\s*["']?(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/gi;

const JudgeVerdict = z.object({ score: z.number(), reasoning: z.string() });

const JUDGE_INSTRUCTIONS =
  'You are an impartial evaluator. Score the response with the rubric in the request. Reply with JSON: {"score": <number from 0 to 1>, "reasoning": "<explanation>"}.';

const UNPARSEABLE = 'could not parse judge response';

interface Verdict {
  score: number;
  reasoning?: string;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function verdictOf(value: unknown): Verdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { score, reasoning } = value as { score?: unknown; reasoning?: unknown };
  const parsed = finiteNumber(score);
  if (parsed === undefined) return undefined;
  return { score: parsed, ...(typeof reasoning === 'string' && { reasoning }) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The texts that may hold the JSON verdict: the whole answer, each fenced block, the outer braces */
function jsonCandidates(raw: string): string[] {
  const fenced = [...raw.matchAll(FENCED_BLOCK)].map((match) => match[1]);
  const braces = JSON_OBJECT.exec(raw)?.[0];
  return [raw, ...fenced, ...(braces === undefined ? [] : [braces])];
}

/** The last `score: X` (or `score is X`, `score: X/N`) the judge wrote, as a 0 - 1 number */
function labelledScore(raw: string): number | undefined {
  let last: RegExpMatchArray | undefined;
  for (const match of raw.matchAll(LABELLED_SCORE)) last = match;
  if (!last) return undefined;
  const value = Number(last[1]);
  if (last[2] === undefined) return value;
  const scale = Number(last[2]);
  return scale > 0 ? value / scale : undefined;
}

/**
 * Reads the judge's verdict: a `{ score, reasoning }` JSON object (bare, fenced, or inside prose,
 * with a number or a numeric string as score), else the last labelled score in the text.
 */
function parseJudgeOutput(raw: string): Verdict | undefined {
  for (const candidate of jsonCandidates(raw)) {
    const verdict = verdictOf(parseJson(candidate));
    if (verdict) return verdict;
  }
  const score = labelledScore(raw);
  return score === undefined ? undefined : { score };
}

function usageOf(value: unknown): MetricUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { inputTokens, outputTokens, totalTokens, cost } = value as Record<string, unknown>;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return undefined;
  const tokens = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  return {
    inputTokens: tokens(inputTokens),
    outputTokens: tokens(outputTokens),
    totalTokens: tokens(totalTokens),
    cost,
  };
}

/**
 * A judge context that runs the judge as a Cogitator agent on `judgeConfig.model`,
 * asking for a `{ score, reasoning }` JSON answer.
 */
export function judgeContextFor(cogitator: JudgeCogitator, judgeConfig: JudgeConfig): JudgeContext {
  let judgeAgent: Promise<unknown> | undefined;
  const agent = () =>
    (judgeAgent ??= import('@cogitator-ai/core').then(
      ({ Agent }) =>
        new Agent({
          name: 'eval-judge',
          model: judgeConfig.model,
          instructions: JUDGE_INSTRUCTIONS,
          temperature: judgeConfig.temperature,
          ...(judgeConfig.maxTokens !== undefined && { maxTokens: judgeConfig.maxTokens }),
          maxIterations: 1,
          responseFormat: { type: 'json_schema', schema: JudgeVerdict },
        }),
      (error: unknown) => {
        throw new Error(
          `The LLM judge needs @cogitator-ai/core: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    ));

  return {
    judgeConfig,
    cogitator: {
      run: async ({ input }) => {
        const result = await cogitator.run(await agent(), { input, useMemory: false });
        const usage = usageOf(result.usage);
        return {
          output:
            result.structured !== undefined ? JSON.stringify(result.structured) : result.output,
          ...(usage && { usage }),
        };
      },
    },
  };
}

function createJudgeMetric(name: string, systemPrompt: string): LLMMetricFn {
  const fn = (async (_result: EvalCaseResult): Promise<MetricScore> => {
    return { name, score: 0, details: 'unbound judge metric — call bindJudgeContext first' };
  }) as LLMMetricFn;

  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  Object.defineProperty(fn, 'requiresJudge', { value: true, writable: false });
  Object.defineProperty(fn, '__judgeSystemPrompt', { value: systemPrompt, writable: false });
  Object.defineProperty(fn, '__judgeName', { value: name, writable: false });

  return fn;
}

function contextText(context: Record<string, unknown>): string {
  return Object.entries(context)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`
    )
    .join('\n');
}

/**
 * What the judge reads: the input, the case's context when it has one (source documents, a
 * dossier, retrieved passages), the expected answer and the response.
 */
function buildUserMessage(result: EvalCaseResult): string {
  const expected = result.case.expected || 'N/A';
  const context = result.case.context;
  const contextBlock =
    context && Object.keys(context).length > 0 ? `\nContext:\n${contextText(context)}` : '';
  return `Input: ${result.case.input}${contextBlock}\nExpected: ${expected}\nResponse: ${result.output}`;
}

export function bindJudgeContext(metric: LLMMetricFn, context: JudgeContext): MetricFn {
  const name = metric.__judgeName;
  const systemPrompt = metric.__judgeSystemPrompt;

  const bound = (async (result: EvalCaseResult): Promise<MetricScore> => {
    try {
      const userMessage = buildUserMessage(result);
      const prompt = `${systemPrompt}\n\n${userMessage}`;

      const runResult = await context.cogitator.run({ input: prompt });
      const usage = usageOf(runResult.usage);
      const parsed = parseJudgeOutput(runResult.output);

      if (!parsed) {
        return {
          name,
          score: 0,
          details: UNPARSEABLE,
          error: UNPARSEABLE,
          ...(usage && { usage }),
        };
      }

      const clamped = Math.max(0, Math.min(1, parsed.score));

      return {
        name,
        score: clamped,
        ...(parsed.reasoning !== undefined && { details: parsed.reasoning }),
        ...(usage && { usage }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name,
        score: 0,
        details: `judge error: ${message}`,
        error: message,
      };
    }
  }) as MetricFn;

  Object.defineProperty(bound, 'metricName', { value: name, writable: false });

  return bound;
}

export function faithfulness(opts?: MetricOptions): LLMMetricFn {
  return createJudgeMetric(
    opts?.name ?? 'faithfulness',
    'You are evaluating the faithfulness of an AI assistant\'s response.\n\nGiven the input, the context when there is one, and the response, rate how faithful the response is to the facts and information in the input and the context. Claims that neither supports count against it.\n\nScore from 0.0 (completely unfaithful) to 1.0 (perfectly faithful).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function relevance(opts?: MetricOptions): LLMMetricFn {
  return createJudgeMetric(
    opts?.name ?? 'relevance',
    'You are evaluating the relevance of an AI assistant\'s response.\n\nGiven the input and the response, rate how relevant the response is to the question asked.\n\nScore from 0.0 (completely irrelevant) to 1.0 (perfectly relevant).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function coherence(opts?: MetricOptions): LLMMetricFn {
  return createJudgeMetric(
    opts?.name ?? 'coherence',
    'You are evaluating the coherence of an AI assistant\'s response.\n\nGiven the input and the response, rate how coherent, logical, and well-structured the response is.\n\nScore from 0.0 (completely incoherent) to 1.0 (perfectly coherent).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function helpfulness(opts?: MetricOptions): LLMMetricFn {
  return createJudgeMetric(
    opts?.name ?? 'helpfulness',
    'You are evaluating the helpfulness of an AI assistant\'s response.\n\nGiven the input and the response, rate how helpful and useful the response would be to the user.\n\nScore from 0.0 (completely unhelpful) to 1.0 (perfectly helpful).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function llmMetric(opts: { name: string; prompt: string }): LLMMetricFn {
  return createJudgeMetric(
    opts.name,
    `${opts.prompt}\n\nScore from 0.0 to 1.0.\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}`
  );
}
