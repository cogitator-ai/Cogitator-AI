import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  LLMErrorKind,
  ModelFallbackEvent,
  Span,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { createLLMError } from '../llm/errors';
import { fallsBackOn } from '../llm/model-fallback';

type Step = ChatResponse | Error | 'stream-then-fail';

const answer = (content: string): ChatResponse => ({
  id: 'r',
  content,
  finishReason: 'stop',
  usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
});

function failure(provider: string, status: number, kind: LLMErrorKind): Error {
  return createLLMError({ provider, model: 'm' }, status, `{"error":{"message":"${kind}"}}`, {
    kind,
  });
}

/** A backend that answers each call with the next step, or `fallback` once the steps run out. */
function scriptedBackend(name: string, steps: Step[], fallback: Step = answer(`${name} answer`)) {
  const queue = [...steps];
  const next = () => queue.shift() ?? fallback;
  const chat = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => {
    const step = next();
    if (step instanceof Error) throw step;
    if (step === 'stream-then-fail') throw new Error('not a stream');
    return step;
  });
  const chatStream = vi.fn(async function* (
    _request: ChatRequest
  ): AsyncGenerator<ChatStreamChunk> {
    const step = next();
    if (step instanceof Error) throw step;
    if (step === 'stream-then-fail') {
      yield { id: 's', delta: { content: 'partial ' } };
      throw failure('openai', 503, 'overloaded');
    }
    yield { id: 's', delta: { content: step.content } };
    yield { id: 's', delta: {}, finishReason: 'stop', usage: step.usage };
  });
  const backend: LLMBackend = { provider: 'openai', chat, chatStream };
  return { backend, chat, chatStream };
}

function setup(primarySteps: Step[], backupSteps: Step[] = []) {
  const primary = scriptedBackend('primary', primarySteps);
  const backup = scriptedBackend('backup', backupSteps);
  const cog = new Cogitator({
    llm: {
      backends: { primary: primary.backend, backup: backup.backend },
      retry: { baseDelay: 1, maxDelay: 2 },
      pricing: {
        'primary/fast': { input: 1, output: 1 },
        'backup/steady': { input: 10, output: 10 },
      },
    },
  });
  return { cog, agent: writer(), primary, backup };
}

function writer(): Agent {
  return new Agent({
    name: 'writer',
    model: 'primary/fast',
    fallbackModels: ['backup/steady'],
    instructions: 'Write.',
  });
}

describe('model fallback in a run', () => {
  it('moves a turn to the next model once the primary is down after its retries', async () => {
    const down = () => failure('openai', 503, 'overloaded');
    const { cog, agent, primary, backup } = setup([down(), down(), down()]);
    const events: ModelFallbackEvent[] = [];
    const spans: Span[] = [];

    const result = await cog.run(agent, {
      input: 'Draft the lede',
      onModelFallback: (event) => events.push(event),
      onSpan: (span) => spans.push(span),
    });

    expect(result.output).toBe('backup answer');
    expect(primary.chat).toHaveBeenCalledTimes(3);
    expect(backup.chat).toHaveBeenCalledTimes(1);
    expect(backup.chat.mock.calls[0][0].model).toBe('steady');
    expect(events).toEqual([
      expect.objectContaining({ from: 'primary/fast', to: 'backup/steady' }),
    ]);
    expect(events[0].error).toBeInstanceOf(CogitatorError);
    expect(result.modelUsed).toBe('backup/steady');
    expect(spans.find((s) => s.name === 'llm.fallback')?.attributes).toMatchObject({
      'llm.fallback.from': 'primary/fast',
      'llm.fallback.to': 'backup/steady',
    });
    expect(spans.find((s) => s.name === 'llm.chat')?.attributes['llm.model']).toBe('steady');
  });

  it('prices a fallback turn at the model that answered it', async () => {
    const { cog, agent } = setup([failure('openai', 401, 'authentication')]);

    const result = await cog.run(agent, { input: 'Draft the lede' });

    expect(result.usage.cost).toBeCloseTo(0.02, 6);
  });

  it('falls back at once on a lasting failure and skips that model in later runs', async () => {
    const { cog, agent, primary, backup } = setup([failure('openai', 429, 'quota')]);

    await cog.run(agent, { input: 'First' });
    const second = await cog.run(agent, { input: 'Second' });

    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(backup.chat).toHaveBeenCalledTimes(2);
    expect(second.modelUsed).toBe('backup/steady');
  });

  it('retries a rate limit on the same model before falling back', async () => {
    const { cog, agent, primary, backup } = setup([failure('openai', 429, 'rate_limit')]);

    const result = await cog.run(agent, { input: 'Draft the lede' });

    expect(result.output).toBe('primary answer');
    expect(primary.chat).toHaveBeenCalledTimes(2);
    expect(backup.chat).not.toHaveBeenCalled();
    expect(result.modelUsed).toBeUndefined();
  });

  it.each<LLMErrorKind>(['content_filter', 'invalid_request'])(
    'keeps a %s failure on the model that raised it',
    async (kind) => {
      const refused = failure('openai', 400, kind);
      const { cog, agent, backup } = setup([refused]);

      await expect(cog.run(agent, { input: 'Draft the lede' })).rejects.toBe(refused);
      expect(backup.chat).not.toHaveBeenCalled();
    }
  );

  it('fails with every attempt when all models fail', async () => {
    const { cog, agent } = setup(
      [failure('openai', 401, 'authentication')],
      [failure('openai', 404, 'not_found')]
    );

    const error = await cog.run(agent, { input: 'Draft the lede' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CogitatorError);
    const failed = error as CogitatorError;
    expect(failed.code).toBe(ErrorCode.LLM_UNAVAILABLE);
    expect(failed.details?.attempts).toEqual([
      expect.objectContaining({ model: 'primary/fast', kind: 'authentication' }),
      expect.objectContaining({ model: 'backup/steady', kind: 'not_found' }),
    ]);
    expect(failed.cause).toBeInstanceOf(CogitatorError);
  });

  it('skips a model whose breaker opened after repeated failures', async () => {
    const down = () => failure('openai', 503, 'overloaded');
    const primary = scriptedBackend('primary', [down(), down(), down()]);
    const backup = scriptedBackend('backup', []);
    const cog = new Cogitator({
      llm: {
        backends: { primary: primary.backend, backup: backup.backend },
        retry: false,
        modelCircuitBreaker: { failureThreshold: 2 },
      },
    });
    const agent = writer();

    await cog.run(agent, { input: 'One' });
    await cog.run(agent, { input: 'Two' });
    await cog.run(agent, { input: 'Three' });

    expect(primary.chat).toHaveBeenCalledTimes(2);
    expect(backup.chat).toHaveBeenCalledTimes(3);
  });

  it('starts every turn from the primary model again', async () => {
    const primary = scriptedBackend('primary', [failure('openai', 504, 'timeout')]);
    const backup = scriptedBackend('backup', []);
    const cog = new Cogitator({
      llm: { backends: { primary: primary.backend, backup: backup.backend }, retry: false },
    });
    const agent = writer();

    const first = await cog.run(agent, { input: 'One' });
    const second = await cog.run(agent, { input: 'Two' });

    expect(first.modelUsed).toBe('backup/steady');
    expect(second.modelUsed).toBeUndefined();
    expect(second.output).toBe('primary answer');
  });

  it('falls back on a stream that failed before its first token', async () => {
    const { cog, agent, backup } = setup([failure('openai', 401, 'authentication')]);
    const tokens: string[] = [];

    const result = await cog.run(agent, {
      input: 'Draft the lede',
      stream: true,
      onToken: (token) => tokens.push(token),
    });

    expect(result.output).toBe('backup answer');
    expect(tokens.join('')).toBe('backup answer');
    expect(backup.chatStream).toHaveBeenCalledTimes(1);
  });

  it('keeps a stream on its model once tokens reached the caller', async () => {
    const primary = scriptedBackend('primary', ['stream-then-fail']);
    const backup = scriptedBackend('backup', []);
    const cog = new Cogitator({
      llm: { backends: { primary: primary.backend, backup: backup.backend }, retry: false },
    });
    const tokens: string[] = [];

    const error = await cog
      .run(writer(), { input: 'Draft the lede', stream: true, onToken: (t) => tokens.push(t) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CogitatorError);
    expect((error as CogitatorError).code).toBe(ErrorCode.LLM_UNAVAILABLE);
    expect((error as CogitatorError).details?.attempts).toBeUndefined();
    expect(tokens).toEqual(['partial ']);
    expect(backup.chatStream).not.toHaveBeenCalled();
  });

  it('does not fall back when the run is aborted', async () => {
    const controller = new AbortController();
    const primary: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(
        (request: ChatRequest) =>
          new Promise<ChatResponse>((_, reject) => {
            const signal = request.signal;
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
              { once: true }
            );
            setTimeout(() => controller.abort(new Error('user left')), 1);
          })
      ),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {}),
    };
    const backup = scriptedBackend('backup', []);
    const cog = new Cogitator({
      llm: { backends: { primary, backup: backup.backend }, retry: false },
    });
    const agent = new Agent({
      name: 'writer',
      model: 'primary/fast',
      fallbackModels: ['backup/steady'],
      instructions: 'Write.',
    });

    await expect(
      cog.run(agent, { input: 'Draft the lede', signal: controller.signal })
    ).rejects.toThrow('user left');
    expect(backup.chat).not.toHaveBeenCalled();
  });

  it('leaves the error as it is for an agent without fallback models', async () => {
    const quota = failure('openai', 429, 'quota');
    const { cog, primary } = setup([quota]);
    const agent = new Agent({ name: 'solo', model: 'primary/fast', instructions: 'Write.' });

    await expect(cog.run(agent, { input: 'Draft' })).rejects.toBe(quota);
    await expect(cog.run(agent, { input: 'Draft again' })).resolves.toMatchObject({
      output: 'primary answer',
    });
    expect(primary.chat).toHaveBeenCalledTimes(2);
  });

  it('accepts a fallback given as a model with its provider', async () => {
    const { cog, primary, backup } = setup([failure('openai', 401, 'authentication')]);
    const agent = new Agent({
      name: 'writer',
      model: 'primary/fast',
      fallbackModels: [{ model: 'steady', provider: 'backup' }],
      instructions: 'Write.',
    });

    const result = await cog.run(agent, { input: 'Draft' });

    expect(result.modelUsed).toBe('backup/steady');
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(backup.chat.mock.calls[0][0].model).toBe('steady');
  });

  it('runs a handed-over agent on its own fallback models', async () => {
    const { cog, primary, backup } = setup([]);
    const specialist = new Agent({
      name: 'specialist',
      model: 'primary/fast',
      fallbackModels: ['backup/steady'],
      instructions: 'Specialise.',
    });
    const triage = new Agent({
      name: 'triage',
      model: 'primary/fast',
      instructions: 'Route.',
      handoffs: [specialist],
    });
    primary.chat.mockResolvedValueOnce({
      id: 'h',
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'transfer_to_specialist', arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    primary.chat.mockRejectedValueOnce(failure('openai', 401, 'authentication'));

    const result = await cog.run(triage, { input: 'Help' });

    expect(result.output).toBe('backup answer');
    expect(result.modelUsed).toBe('backup/steady');
    expect(backup.chat).toHaveBeenCalledTimes(1);
  });
});

describe('fallsBackOn', () => {
  it.each<[LLMErrorKind, boolean]>([
    ['rate_limit', true],
    ['quota', true],
    ['authentication', true],
    ['permission', true],
    ['not_found', true],
    ['context_overflow', true],
    ['overloaded', true],
    ['server_error', true],
    ['timeout', true],
    ['network', true],
    ['invalid_response', true],
    ['content_filter', false],
    ['invalid_request', false],
  ])('%s -> %s', (kind, expected) => {
    expect(fallsBackOn(failure('openai', 500, kind))).toBe(expected);
  });

  it('leaves errors that are not a provider failure alone', () => {
    expect(
      fallsBackOn(new CogitatorError({ message: 'bad', code: ErrorCode.CONFIGURATION_ERROR }))
    ).toBe(false);
    expect(fallsBackOn(new TypeError('x is undefined'))).toBe(false);
    expect(fallsBackOn(new Error('connect ECONNREFUSED'))).toBe(true);
  });
});
