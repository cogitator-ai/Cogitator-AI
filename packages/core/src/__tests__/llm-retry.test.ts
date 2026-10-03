import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  LLMRetryEvent,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { RetryingBackend, withLLMRetry } from '../llm/retry';
import { createLLMError, llmUnavailable, retryAfterFromHeaders } from '../llm/errors';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';

const ctx = { provider: 'openai', model: 'gpt-6-luna' };
const request: ChatRequest = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] };

const ok = (content = 'done'): ChatResponse => ({
  id: 'r',
  content,
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

/** A backend whose calls fail with `failures`, in order, and then answer. */
function flakyBackend(failures: unknown[], answer = ok()) {
  const queue = [...failures];
  const chat = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => {
    const failure = queue.shift();
    if (failure !== undefined) throw failure;
    return answer;
  });
  const chatStream = vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
    const failure = queue.shift();
    if (failure !== undefined) throw failure;
    yield { id: 's', delta: { content: answer.content } };
    yield { id: 's', delta: {}, finishReason: 'stop' };
  });
  const backend: LLMBackend = { provider: 'openai', chat, chatStream };
  return { backend, chat, chatStream };
}

const unavailable = () => createLLMError(ctx, 503, 'overloaded');
const fast = { baseDelay: 1, maxDelay: 2 };

async function collect(stream: AsyncGenerator<ChatStreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk.delta.content ?? '';
  return text;
}

describe('RetryingBackend', () => {
  it('retries retryable errors until a call succeeds', async () => {
    const { backend, chat } = flakyBackend([unavailable(), unavailable()]);

    const response = await new RetryingBackend(backend, fast).chat(request);

    expect(response.content).toBe('done');
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const last = unavailable();
    const { backend, chat } = flakyBackend([unavailable(), unavailable(), last]);

    const error = await new RetryingBackend(backend, fast).chat(request).catch((e: unknown) => e);

    expect(error).toBe(last);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('does not retry errors that are not retryable', async () => {
    const auth = createLLMError(ctx, 401, 'bad key');
    const { backend, chat } = flakyBackend([auth]);

    await expect(new RetryingBackend(backend, fast).chat(request)).rejects.toBe(auth);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('waits as long as the provider asks', async () => {
    const limited = createLLMError(ctx, 429, '', { retryAfterOverride: 20 });
    const { backend } = flakyBackend([limited]);
    const events: LLMRetryEvent[] = [];

    const started = Date.now();
    await new RetryingBackend(backend, { ...fast, onRetry: (e) => events.push(e) }).chat(request);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(events).toEqual([
      { provider: 'openai', model: 'gpt-6-luna', attempt: 1, delay: 20, error: limited },
    ]);
  });

  it('fails at once when the provider asks to wait longer than maxRetryAfter', async () => {
    const limited = createLLMError(ctx, 429, '', { retryAfterOverride: 120_000 });
    const { backend, chat } = flakyBackend([limited]);

    await expect(new RetryingBackend(backend, fast).chat(request)).rejects.toBe(limited);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially up to maxDelay when the provider names no wait', async () => {
    const { backend } = flakyBackend([unavailable(), unavailable(), unavailable()]);
    const delays: number[] = [];

    await new RetryingBackend(backend, {
      maxRetries: 3,
      baseDelay: 10,
      maxDelay: 25,
      onRetry: (e) => delays.push(e.delay),
    }).chat(request);

    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(8);
    expect(delays[0]).toBeLessThanOrEqual(12);
    expect(delays[1]).toBeGreaterThanOrEqual(16);
    expect(delays[1]).toBeLessThanOrEqual(24);
    expect(delays[2]).toBeGreaterThanOrEqual(20);
    expect(delays[2]).toBeLessThanOrEqual(30);
  });

  it('stops waiting when the request is aborted', async () => {
    const limited = createLLMError(ctx, 429, '', { retryAfterOverride: 10_000 });
    const { backend, chat } = flakyBackend([limited]);
    const controller = new AbortController();
    const reason = new Error('run cancelled');

    const pending = new RetryingBackend(backend).chat({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 5);

    await expect(pending).rejects.toBe(reason);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { backend, chat } = flakyBackend([llmUnavailable(ctx, 'connection reset')]);

    await expect(
      new RetryingBackend(backend, fast).chat({ ...request, signal: controller.signal })
    ).rejects.toThrow('connection reset');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('retries a stream that fails before its first chunk', async () => {
    const { backend, chatStream } = flakyBackend([unavailable()]);

    const text = await collect(new RetryingBackend(backend, fast).chatStream(request));

    expect(text).toBe('done');
    expect(chatStream).toHaveBeenCalledTimes(2);
  });

  it('passes on an error that breaks a stream midway', async () => {
    const broken = unavailable();
    const chatStream = vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: 'par' } };
      throw broken;
    });
    const backend: LLMBackend = { provider: 'openai', chat: vi.fn(), chatStream };
    const seen: string[] = [];

    const error = await (async () => {
      for await (const chunk of new RetryingBackend(backend, fast).chatStream(request)) {
        seen.push(chunk.delta.content ?? '');
      }
    })().catch((e: unknown) => e);

    expect(error).toBe(broken);
    expect(seen).toEqual(['par']);
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it('retries complete() when the backend has it', async () => {
    const complete = vi
      .fn<NonNullable<LLMBackend['complete']>>()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(ok('completed'));
    const backend: LLMBackend = { ...flakyBackend([]).backend, complete };

    const retrying = new RetryingBackend(backend, fast);

    expect((await retrying.complete?.({ messages: [] }))?.content).toBe('completed');
    expect(new RetryingBackend(flakyBackend([]).backend).complete).toBeUndefined();
  });

  it('is skipped by withLLMRetry when retries are off or already on', () => {
    const { backend } = flakyBackend([]);
    const retrying = withLLMRetry(backend, {});

    expect(withLLMRetry(backend, false)).toBe(backend);
    expect(retrying).toBeInstanceOf(RetryingBackend);
    expect(withLLMRetry(retrying, {})).toBe(retrying);
  });
});

describe('agent runs on a flaky provider', () => {
  const agent = new Agent({ name: 'a', model: 'flaky/m', instructions: 'x' });

  it('survives transient provider errors', async () => {
    const { backend, chat } = flakyBackend([unavailable()], ok('recovered'));
    const cog = new Cogitator({ llm: { backends: { flaky: backend }, retry: fast } });

    const result = await cog.run(agent, { input: 'hi' });

    expect(result.output).toBe('recovered');
    expect(chat).toHaveBeenCalledTimes(2);
    await cog.close();
  });

  it('streams the answer of the attempt that succeeded', async () => {
    const { backend } = flakyBackend([unavailable()], ok('streamed'));
    const cog = new Cogitator({ llm: { backends: { flaky: backend }, retry: fast } });
    const tokens: string[] = [];

    const result = await cog.run(agent, {
      input: 'hi',
      stream: true,
      onToken: (t) => tokens.push(t),
    });

    expect(result.output).toBe('streamed');
    expect(tokens).toEqual(['streamed']);
    await cog.close();
  });

  it('fails on the first error when retries are off', async () => {
    const { backend, chat } = flakyBackend([unavailable()]);
    const cog = new Cogitator({ llm: { backends: { flaky: backend }, retry: false } });

    await expect(cog.run(agent, { input: 'hi' })).rejects.toBeInstanceOf(CogitatorError);
    expect(chat).toHaveBeenCalledTimes(1);
    await cog.close();
  });
});

describe('provider wait hints', () => {
  it('reads retry-after-ms, retry-after seconds and HTTP dates', () => {
    expect(retryAfterFromHeaders(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': '7' }))).toBe(7000);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const fromDate = retryAfterFromHeaders(new Headers({ 'retry-after': inTenSeconds }));
    expect(fromDate).toBeGreaterThan(8000);
    expect(fromDate).toBeLessThanOrEqual(10_000);
    expect(retryAfterFromHeaders(new Headers())).toBeUndefined();
  });

  it("reads Google's RetryInfo from an error body", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
        ],
      },
    });

    expect(createLLMError(ctx, 429, body).retryAfter).toBe(37_000);
  });

  it('names no wait when the provider names none', () => {
    const limited = createLLMError(ctx, 429, 'slow down');

    expect(limited.retryable).toBe(true);
    expect(limited.code).toBe(ErrorCode.LLM_RATE_LIMITED);
    expect(limited.retryAfter).toBeUndefined();
    expect(createLLMError(ctx, 503, 'down').retryAfter).toBeUndefined();
    expect(createLLMError(ctx, 503, 'down', { retryAfterOverride: 3000 }).retryAfter).toBe(3000);
  });
});
