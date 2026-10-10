import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ErrorCode, type DecisionBackend, type RunObserver, type Span } from '@cogitator-ai/types';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import {
  OPENROUTER_DECISIONS_URL,
  OpenRouterDecisionBackend,
  decisionsUrlFor,
} from '../decisions/openrouter';
import { decisionTool } from '../decisions/tool';
import { createToolContext } from './helpers/tool-context';

const JEV = 'openrouter/typesafe/jev-1.13';

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which team should answer this message?',
    criteria: {
      technical: 'Bugs, errors and how the product works',
      billing: 'Payments, invoices and refunds',
    },
  },
  spam: {
    type: 'noul',
    instructions: 'Is this message spam?',
    criteria: { true: 'Advertising or nonsense', false: 'A real reader writing' },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is it?',
    criteria: ['low', 'medium', 'high'],
  },
} as const;

/** A Decisions API answer in the documented shape. */
function answerBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gen-1',
    model: 'typesafe/jev-1.13',
    provider: 'TypeSafe',
    answers: {
      team: {
        type: 'choice',
        choice: 'technical',
        confidence: 0.91,
        probabilities: { technical: 0.91, billing: 0.09 },
      },
      spam: { type: 'noul', noul: 0.12 },
      urgency: {
        type: 'score',
        score: 2,
        confidence: 0.7,
        probabilities: { low: 0.1, medium: 0.2, high: 0.7 },
      },
    },
    usage: { input_tokens: 1200, output_tokens: 30, cost: 0.0000504 },
    ...overrides,
  };
}

function api(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { body: answerBody() };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

function cogitator(
  fetchImpl: typeof fetch,
  extra: {
    observers?: RunObserver[];
    retry?: false | { maxRetries?: number; baseDelay?: number };
  } = {}
) {
  vi.stubGlobal('fetch', fetchImpl);
  return new Cogitator({
    llm: {
      providers: { openrouter: { apiKey: 'or-key' } },
      ...(extra.retry !== undefined && { retry: extra.retry }),
    },
    ...(extra.observers && { observers: extra.observers }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterDecisionBackend', () => {
  it('posts the state and the questions to the Decisions API and reads the answers', async () => {
    const { calls, fetch } = api([{ body: answerBody() }]);
    const backend = new OpenRouterDecisionBackend({ apiKey: 'or-key', fetch });
    const response = await backend.decide({
      model: 'typesafe/jev-1.13',
      state: { message: 'The app crashes on start' },
      questions,
      sessionId: 'session-1',
      user: 'reader-7',
    });
    expect(calls[0].url).toBe(OPENROUTER_DECISIONS_URL);
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer or-key');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'typesafe/jev-1.13',
      state: { message: 'The app crashes on start' },
      questions: JSON.parse(JSON.stringify(questions)),
      session_id: 'session-1',
      user: 'reader-7',
    });
    expect(response).toMatchObject({
      id: 'gen-1',
      model: 'typesafe/jev-1.13',
      provider: 'TypeSafe',
      usage: { inputTokens: 1200, outputTokens: 30, cost: 0.0000504 },
    });
    expect(response.answers.spam).toEqual({ type: 'noul', noul: 0.12 });
  });

  it('turns its errors into LLM errors, retryable where waiting helps', async () => {
    const backend = (status: number, body: unknown, headers?: Record<string, string>) =>
      new OpenRouterDecisionBackend({
        apiKey: 'k',
        fetch: api([{ status, body, ...(headers && { headers }) }]).fetch,
      }).decide({ model: 'm', state: 's', questions });
    await expect(
      backend(402, { error: { message: 'Insufficient credits' } })
    ).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('Insufficient credits'),
    });
    await expect(
      backend(429, { error: { message: 'slow down' } }, { 'retry-after': '3' })
    ).rejects.toMatchObject({
      code: ErrorCode.LLM_RATE_LIMITED,
      retryable: true,
      retryAfter: 3000,
    });
    await expect(backend(529, { error: { message: 'overloaded' } })).rejects.toMatchObject({
      retryable: true,
    });
    await expect(backend(200, { answers: 'nope' })).rejects.toMatchObject({
      code: ErrorCode.LLM_INVALID_RESPONSE,
    });
  });

  it('finds the Decisions endpoint next to an OpenRouter base URL', () => {
    expect(decisionsUrlFor(undefined)).toBe(OPENROUTER_DECISIONS_URL);
    expect(decisionsUrlFor('https://proxy.example/api/v1/')).toBe(
      'https://proxy.example/api/alpha/decisions'
    );
  });
});

describe('cog.decide', () => {
  it('answers with typed values: a choice among its options, yes or no by the threshold, a score', async () => {
    const { fetch } = api([{ body: answerBody() }]);
    const result = await cogitator(fetch).decide({
      model: JEV,
      state: 'Reader asks about a new open-weights model',
      questions,
      threshold: 0.1,
    });
    expect(result.answers.team).toEqual({
      type: 'choice',
      choice: 'technical',
      confidence: 0.91,
      probabilities: { technical: 0.91, billing: 0.09 },
    });
    expect(result.answers.spam).toEqual({ type: 'noul', probability: 0.12, value: true });
    expect(result.answers.urgency).toMatchObject({ type: 'score', score: 2 });
    expect(result.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 30,
      cost: 0.0000504,
      priced: true,
    });
    expect(result).toMatchObject({ model: 'typesafe/jev-1.13', id: 'gen-1', provider: 'TypeSafe' });

    expectTypeOf(result.answers.team.choice).toEqualTypeOf<'technical' | 'billing'>();
    expectTypeOf(result.answers.spam.value).toEqualTypeOf<boolean>();
    expectTypeOf(result.answers.urgency.score).toEqualTypeOf<number>();
  });

  it('prices the answer from the model registry when OpenRouter reports no cost', async () => {
    const body = answerBody({ usage: { input_tokens: 1_000_000, output_tokens: 10 } });
    const result = await cogitator(api([{ body }]).fetch).decide({
      model: JEV,
      state: 'x',
      questions,
    });
    expect(result.usage.cost).toBeCloseTo(0.042);
    expect(result.usage.priced).toBe(true);
  });

  it('retries what can succeed later, as LLM calls are', async () => {
    const { calls, fetch } = api([
      { status: 503, body: { error: { message: 'busy' } } },
      { body: answerBody() },
    ]);
    const result = await cogitator(fetch, { retry: { maxRetries: 2, baseDelay: 1 } }).decide({
      model: JEV,
      state: 'x',
      questions,
    });
    expect(calls).toHaveLength(2);
    expect(result.answers.team.choice).toBe('technical');
  });

  it.each([
    ['no questions', { questions: {} }, 'at least one question'],
    [
      'a choice with one option',
      { questions: { q: { type: 'choice', instructions: 'x', criteria: { only: 'y' } } } },
      'two options',
    ],
    [
      'a yes or no question without criteria',
      { questions: { q: { type: 'noul', instructions: 'x', criteria: { true: '', false: 'n' } } } },
      'both true and false',
    ],
    ['a threshold above 1', { questions, threshold: 2 }, 'between 0 and 1'],
  ])('refuses %s before calling the model', async (_name, overrides, message) => {
    const { calls, fetch } = api([]);
    await expect(
      cogitator(fetch).decide(
        Object.assign({ model: JEV, state: 'x', questions }, overrides) as never
      )
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      message: expect.stringContaining(message),
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['leaves a question unanswered', { team: undefined }, 'unanswered'],
    [
      'answers in another type',
      { spam: { type: 'choice', choice: 'yes' } },
      'answered it as choice',
    ],
    [
      'picks an option the question does not have',
      { team: { type: 'choice', choice: 'sports' } },
      'not one of its options',
    ],
    ['gives a probability above 1', { spam: { type: 'noul', noul: 2 } }, 'outside 0 to 1'],
    [
      'gives a negative option probability',
      {
        team: {
          type: 'choice',
          choice: 'technical',
          probabilities: { technical: 1.1, billing: -0.1 },
        },
      },
      'outside 0 to 1',
    ],
    [
      'gives a confidence above 1',
      { urgency: { type: 'score', score: 1, confidence: 1.5 } },
      'outside 0 to 1',
    ],
  ])('fails when the model %s', async (_name, answers, message) => {
    const body = answerBody();
    const merged = { ...body.answers, ...answers };
    for (const key of Object.keys(merged))
      if (merged[key as keyof typeof merged] === undefined)
        delete merged[key as keyof typeof merged];
    await expect(
      cogitator(api([{ body: { ...body, answers: merged } }]).fetch, { retry: false }).decide({
        model: JEV,
        state: 'x',
        questions,
      })
    ).rejects.toMatchObject({
      code: ErrorCode.LLM_INVALID_RESPONSE,
      message: expect.stringContaining(message),
    });
  });

  it('reports each decision to the observers as a run with one llm.decide span', async () => {
    const events: string[] = [];
    const spans: Span[] = [];
    const observer: RunObserver = {
      onRunStart: (event) => void events.push(`start ${event.agentName} ${event.model}`),
      onSpan: (span) => void spans.push(span),
      onRunComplete: (result) => void events.push(`complete ${result.usage.cost}`),
      onRunError: (error) => void events.push(`error ${error.message}`),
    };
    const cog = cogitator(
      api([{ body: answerBody() }, { status: 400, body: { error: { message: 'bad' } } }]).fetch,
      {
        observers: [observer],
        retry: false,
      }
    );
    await cog.decide({ model: JEV, state: 'x', questions });
    await expect(cog.decide({ model: JEV, state: 'x', questions })).rejects.toThrow();
    expect(events[0]).toBe(`start decide ${JEV}`);
    expect(events[1]).toBe('complete 0.0000504');
    expect(events[2]).toBe(`start decide ${JEV}`);
    expect(events[3]).toMatch(/^error /);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'llm.decide',
      kind: 'client',
      attributes: {
        'llm.model': 'typesafe/jev-1.13',
        'llm.input_tokens': 1200,
        'decision.questions': 'team,spam,urgency',
      },
    });
  });

  it('runs on a decision backend of your own', async () => {
    const backend: DecisionBackend = {
      provider: 'acme',
      decide: vi.fn(async (request) => ({
        model: request.model,
        answers: { spam: { type: 'noul' as const, noul: 0.9 } },
        usage: { inputTokens: 5, outputTokens: 0 },
      })),
    };
    const cog = new Cogitator({
      llm: { backends: {}, decisionBackends: { acme: backend } },
    });
    const result = await cog.decide({
      model: 'acme/judge-1',
      state: 'Buy now!!!',
      questions: { spam: questions.spam },
    });
    expect(backend.decide).toHaveBeenCalledWith(expect.objectContaining({ model: 'judge-1' }));
    expect(result.answers.spam.value).toBe(true);
    expect(result.usage).toMatchObject({ cost: 0, priced: false });
  });

  it('says where decision models run and that they need a key', async () => {
    await expect(
      new Cogitator({ llm: { providers: { openai: { apiKey: 'k' } } } }).decide({
        model: 'openai/gpt-x',
        state: 'x',
        questions,
      })
    ).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
      message: expect.stringContaining('run on OpenRouter'),
    });
    await expect(
      new Cogitator().decide({ model: JEV, state: 'x', questions })
    ).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
      message: expect.stringContaining('OPENROUTER_API_KEY'),
    });
  });
});

describe('a decision model in a chat run', () => {
  it('fails clearly instead of a 400 from chat completions', async () => {
    const cog = new Cogitator({ llm: { providers: { openrouter: { apiKey: 'k' } } } });
    const agent = new Agent({ name: 'router', model: JEV, instructions: 'Route messages.' });
    await expect(cog.run(agent, { input: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
      message: expect.stringContaining('is a decision model'),
    });
    expect(cog.route('openrouter/openai/gpt-4o').model).toBe('openai/gpt-4o');
  });
});

describe('decisionTool', () => {
  it('asks the fixed questions about the state the agent passes', async () => {
    const { calls, fetch } = api([{ body: answerBody() }]);
    const tool = decisionTool(cogitator(fetch), {
      name: 'route_ticket',
      description: 'Decide which team answers a support message',
      model: JEV,
      questions,
    });
    expect(tool.name).toBe('route_ticket');
    expect(tool.parameters.safeParse({ state: { message: 'x' } }).success).toBe(true);
    expect(tool.parameters.safeParse({ state: 42 }).success).toBe(false);
    const result = await tool.execute({ state: 'A new chip' }, createToolContext());
    expect(result.answers.team.choice).toBe('technical');
    expect(result.cost).toBeCloseTo(0.0000504);
    expect(JSON.parse(String(calls[0].init.body)).state).toBe('A new chip');
    expectTypeOf(result.answers.team.choice).toEqualTypeOf<'technical' | 'billing'>();
  });
});
