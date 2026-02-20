import type { JudgeConfig } from '../schema';
import type { MetricFn, EvalCaseResult, MetricScore } from './types';

export interface JudgeContext {
  cogitator: { run: (opts: { input: string }) => Promise<{ output: string }> };
  judgeConfig: JudgeConfig;
}

export interface LLMMetricFn extends MetricFn {
  readonly requiresJudge: true;
  readonly __judgeSystemPrompt: string;
  readonly __judgeName: string;
}

const SCORE_REGEX = /\b(0(?:\.\d+)?|1(?:\.0+)?)\b/;

function parseJudgeOutput(raw: string): { score: number; reasoning?: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.score === 'number') {
      return { score: parsed.score, reasoning: parsed.reasoning };
    }
    return null;
  } catch {
    const match = raw.match(SCORE_REGEX);
    if (match) {
      return { score: parseFloat(match[1]) };
    }
    return null;
  }
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

function buildUserMessage(result: EvalCaseResult): string {
  const expected = result.case.expected || 'N/A';
  return `Input: ${result.case.input}\nExpected: ${expected}\nResponse: ${result.output}`;
}

export function bindJudgeContext(metric: LLMMetricFn, context: JudgeContext): MetricFn {
  const name = metric.__judgeName;
  const systemPrompt = metric.__judgeSystemPrompt;

  const bound = (async (result: EvalCaseResult): Promise<MetricScore> => {
    try {
      const userMessage = buildUserMessage(result);
      const prompt = `${systemPrompt}\n\n${userMessage}`;

      const runResult = await context.cogitator.run({ input: prompt });
      const parsed = parseJudgeOutput(runResult.output);

      if (!parsed) {
        return { name, score: 0, details: 'could not parse judge response' };
      }

      const clamped = Math.max(0, Math.min(1, parsed.score));

      return {
        name,
        score: clamped,
        ...(parsed.reasoning !== undefined && { details: parsed.reasoning }),
      };
    } catch (err) {
      return {
        name,
        score: 0,
        details: `judge error: ${(err as Error).message}`,
      };
    }
  }) as MetricFn;

  Object.defineProperty(bound, 'metricName', { value: name, writable: false });

  return bound;
}

export function faithfulness(): LLMMetricFn {
  return createJudgeMetric(
    'faithfulness',
    'You are evaluating the faithfulness of an AI assistant\'s response.\n\nGiven the input and the response, rate how faithful the response is to the facts and information in the input.\n\nScore from 0.0 (completely unfaithful) to 1.0 (perfectly faithful).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function relevance(): LLMMetricFn {
  return createJudgeMetric(
    'relevance',
    'You are evaluating the relevance of an AI assistant\'s response.\n\nGiven the input and the response, rate how relevant the response is to the question asked.\n\nScore from 0.0 (completely irrelevant) to 1.0 (perfectly relevant).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function coherence(): LLMMetricFn {
  return createJudgeMetric(
    'coherence',
    'You are evaluating the coherence of an AI assistant\'s response.\n\nGiven the input and the response, rate how coherent, logical, and well-structured the response is.\n\nScore from 0.0 (completely incoherent) to 1.0 (perfectly coherent).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function helpfulness(): LLMMetricFn {
  return createJudgeMetric(
    'helpfulness',
    'You are evaluating the helpfulness of an AI assistant\'s response.\n\nGiven the input and the response, rate how helpful and useful the response would be to the user.\n\nScore from 0.0 (completely unhelpful) to 1.0 (perfectly helpful).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}'
  );
}

export function llmMetric(opts: { name: string; prompt: string }): LLMMetricFn {
  return createJudgeMetric(
    opts.name,
    `${opts.prompt}\n\nScore from 0.0 to 1.0.\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}`
  );
}
