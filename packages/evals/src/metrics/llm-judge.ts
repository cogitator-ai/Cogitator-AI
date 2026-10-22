import { z } from 'zod';
import type { JudgeCache, JudgeCogitator, JudgeConfig } from '../schema';
import type {
  MetricFn,
  EvalCaseResult,
  MetricScore,
  MetricOptions,
  MetricUsage,
  Passage,
} from './types';

export interface JudgeContext {
  cogitator: {
    run: (opts: { input: string }) => Promise<{ output: string; usage?: MetricUsage }>;
  };
  judgeConfig: JudgeConfig;
}

/** What the judge is asked about a case, or why the case is not judged and scores 0 */
export type JudgeMessage = { message: string } | { skip: string };

export interface LLMMetricFn extends MetricFn {
  readonly requiresJudge: true;
  readonly __judgeSystemPrompt: string;
  readonly __judgeName: string;
  /** Builds what the judge reads about a case. Default: input, context, expected and response */
  readonly __judgeMessage?: (result: EvalCaseResult) => JudgeMessage;
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
  const cache = judgeConfig.cache === true ? memoryCache() : judgeConfig.cache || undefined;
  const slots =
    judgeConfig.concurrency === undefined ? undefined : limiter(judgeConfig.concurrency);
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

  const judge = async (input: string) => {
    const result = await cogitator.run(await agent(), { input, useMemory: false });
    const usage = usageOf(result.usage);
    return {
      output: result.structured !== undefined ? JSON.stringify(result.structured) : result.output,
      ...(usage && { usage }),
    };
  };

  const limited = (input: string) => (slots ? slots(() => judge(input)) : judge(input));
  const inFlight = new Map<string, Promise<{ output: string; usage?: MetricUsage }>>();

  const lookup = async (input: string, key: string) => {
    const hit = await cacheRead(cache!, key);
    if (hit !== undefined && parseJudgeOutput(hit)) return { output: hit };
    const answered = await limited(input);
    if (parseJudgeOutput(answered.output)) await cacheWrite(cache!, key, answered.output);
    return answered;
  };

  const cached = async (input: string) => {
    const key = cacheKey(judgeConfig, input);
    const running = inFlight.get(key);
    if (running) return { output: (await running).output };
    const verdict = lookup(input, key).finally(() => inFlight.delete(key));
    inFlight.set(key, verdict);
    return verdict;
  };

  return {
    judgeConfig,
    cogitator: { run: ({ input }) => (cache ? cached(input) : limited(input)) },
  };
}

/** A cached verdict, none on a miss or when the cache cannot be read: the judge then runs */
async function cacheRead(cache: JudgeCache, key: string): Promise<string | undefined> {
  try {
    const hit: unknown = await cache.get(key);
    return typeof hit === 'string' ? hit : undefined;
  } catch (error) {
    warnCache('read', error);
    return undefined;
  }
}

/** Keeps a verdict, warning instead of failing the score when the cache cannot be written */
async function cacheWrite(cache: JudgeCache, key: string, verdict: string): Promise<void> {
  try {
    await cache.set(key, verdict);
  } catch (error) {
    warnCache('write', error);
  }
}

function warnCache(action: 'read' | 'write', error: unknown): void {
  process.emitWarning(
    `The judge cache could not ${action} a verdict: ${error instanceof Error ? error.message : String(error)}`,
    { code: 'COGITATOR_EVALS_JUDGE_CACHE' }
  );
}

/** Bumped whenever how the judge is asked changes, so kept verdicts of an older judge go unused */
const CACHE_KEY_VERSION = 1;

/**
 * The key of a verdict: what the judge was asked (its instructions and the whole prompt), by
 * which model and with which settings
 */
function cacheKey(judgeConfig: JudgeConfig, input: string): string {
  return JSON.stringify([
    CACHE_KEY_VERSION,
    JUDGE_INSTRUCTIONS,
    judgeConfig.model,
    judgeConfig.temperature,
    judgeConfig.maxTokens ?? null,
    input,
  ]);
}

function memoryCache(): JudgeCache {
  const verdicts = new Map<string, string>();
  return {
    get: (key) => verdicts.get(key),
    set: (key, verdict) => void verdicts.set(key, verdict),
  };
}

/** Runs at most `limit` tasks at once, the rest waiting in order: a task that ends hands its slot on */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

function createJudgeMetric(
  name: string,
  systemPrompt: string,
  message?: (result: EvalCaseResult) => JudgeMessage
): LLMMetricFn {
  const fn = (async (_result: EvalCaseResult): Promise<MetricScore> => {
    return { name, score: 0, details: 'unbound judge metric — call bindJudgeContext first' };
  }) as LLMMetricFn;

  Object.defineProperty(fn, 'metricName', { value: name, writable: false });
  Object.defineProperty(fn, 'requiresJudge', { value: true, writable: false });
  Object.defineProperty(fn, '__judgeSystemPrompt', { value: systemPrompt, writable: false });
  Object.defineProperty(fn, '__judgeName', { value: name, writable: false });
  if (message) Object.defineProperty(fn, '__judgeMessage', { value: message, writable: false });

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

function passagesText(passages: readonly Passage[]): string {
  return passages
    .map((p, i) => `[${i + 1}]${p.source ? ` (${p.source})` : ''} ${p.content}`)
    .join('\n');
}

/**
 * The evidence of a case: its retrieved passages when it has any and `preferRetrieved` is set,
 * else its context, else nothing
 */
function evidenceBlock(result: EvalCaseResult, preferRetrieved: boolean): string | undefined {
  if (preferRetrieved && result.retrieved && result.retrieved.length > 0) {
    return `Retrieved passages:\n${passagesText(result.retrieved)}`;
  }
  const context = result.case.context;
  return context && Object.keys(context).length > 0
    ? `Context:\n${contextText(context)}`
    : undefined;
}

/**
 * What the judge reads: the input, the case's evidence when it has some (its context, or the
 * retrieved passages for metrics that prefer them), the expected answer and the response.
 */
function buildUserMessage(result: EvalCaseResult, preferRetrieved = false): string {
  const expected = result.case.expected || 'N/A';
  const evidence = evidenceBlock(result, preferRetrieved);
  const evidenceText = evidence === undefined ? '' : `\n${evidence}`;
  return `Input: ${result.case.input}${evidenceText}\nExpected: ${expected}\nResponse: ${result.output}`;
}

export function bindJudgeContext(metric: LLMMetricFn, context: JudgeContext): MetricFn {
  const name = metric.__judgeName;
  const systemPrompt = metric.__judgeSystemPrompt;

  const bound = (async (result: EvalCaseResult): Promise<MetricScore> => {
    try {
      const message = metric.__judgeMessage?.(result) ?? { message: buildUserMessage(result) };
      if ('skip' in message) return { name, score: 0, details: message.skip };
      const prompt = `${systemPrompt}\n\n${message.message}`;

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

/**
 * How faithful the response is to the input and the evidence: the passages the run retrieved
 * when the case has any, its `context` otherwise.
 */
export function faithfulness(opts?: MetricOptions): LLMMetricFn {
  return createJudgeMetric(
    opts?.name ?? 'faithfulness',
    'You are evaluating the faithfulness of an AI assistant\'s response.\n\nGiven the input, the context or retrieved passages when there are some, and the response, rate how faithful the response is to the facts and information in the input and the context. Claims that neither supports count against it.\n\nScore from 0.0 (completely unfaithful) to 1.0 (perfectly faithful).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}',
    (result) => ({ message: buildUserMessage(result, true) })
  );
}

/**
 * Whether the passages the run retrieved are relevant to the input, judged on the input and the
 * passages alone (the case's `context` when nothing was retrieved). A case with neither scores 0
 * without a judge call.
 */
export function contextRelevance(opts?: MetricOptions): LLMMetricFn {
  return createJudgeMetric(
    opts?.name ?? 'contextRelevance',
    'You are evaluating the context an AI assistant retrieved to answer a request.\n\nGiven the input and the retrieved passages (or context), rate how relevant they are to the input: whether they hold the information needed to answer it, with little that is off topic.\n\nScore from 0.0 (completely irrelevant) to 1.0 (perfectly relevant).\n\nRespond with JSON: {"score": <number>, "reasoning": "<explanation>"}',
    (result) => {
      const evidence = evidenceBlock(result, true);
      if (evidence === undefined) return { skip: 'no retrieved passages or context to judge' };
      return { message: `Input: ${result.case.input}\n${evidence}` };
    }
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
