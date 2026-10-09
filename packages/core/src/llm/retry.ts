import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  LLMBackendProvider,
  LLMRetryConfig,
} from '@cogitator-ai/types';
import { CogitatorError, isRetryableError } from '@cogitator-ai/types';
import { llmTimeout, type LLMError } from './errors';

export const DEFAULT_LLM_RETRY = {
  maxRetries: 2,
  baseDelay: 1000,
  maxDelay: 30_000,
  maxRetryAfter: 60_000,
} as const satisfies Required<Omit<LLMRetryConfig, 'onRetry' | 'requestTimeout'>>;

type ResolvedRetryConfig = Required<Omit<LLMRetryConfig, 'onRetry' | 'requestTimeout'>> &
  Pick<LLMRetryConfig, 'onRetry' | 'requestTimeout'>;

/**
 * The retry policy of LLM calls: retryable errors are retried, a provider's
 * `Retry-After` honoured up to `maxRetryAfter`, otherwise the delay grows
 * exponentially from `baseDelay` up to `maxDelay`. The caller's `signal` stops
 * both the calls and the waits between them. With `requestTimeout`, a call
 * that has not answered in time is aborted and retried as `LLM_TIMEOUT`.
 */
export class LLMRetryPolicy {
  readonly config: ResolvedRetryConfig;

  constructor(
    readonly provider: LLMBackendProvider,
    config: LLMRetryConfig = {}
  ) {
    this.config = {
      maxRetries: config.maxRetries ?? DEFAULT_LLM_RETRY.maxRetries,
      baseDelay: config.baseDelay ?? DEFAULT_LLM_RETRY.baseDelay,
      maxDelay: config.maxDelay ?? DEFAULT_LLM_RETRY.maxDelay,
      maxRetryAfter: config.maxRetryAfter ?? DEFAULT_LLM_RETRY.maxRetryAfter,
      onRetry: config.onRetry,
      requestTimeout: config.requestTimeout,
    };
  }

  /** Runs `call` until it succeeds, fails for good or runs out of retries. */
  async run<T>(
    model: string,
    signal: AbortSignal | undefined,
    call: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.timed(model, signal, call);
      } catch (error) {
        await this.beforeRetry(error, attempt, model, signal);
      }
    }
  }

  /** One call, aborted with a retryable `LLM_TIMEOUT` when it outlasts `requestTimeout`. */
  async timed<T>(
    model: string,
    signal: AbortSignal | undefined,
    call: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    const limit = this.config.requestTimeout;
    if (limit === undefined) return call(signal);
    const attempt = new AttemptSignal(signal);
    try {
      return await Promise.race([
        call(attempt.signal),
        attempt.expire(limit, this.timeoutError(model, limit)),
      ]);
    } finally {
      attempt.dispose();
    }
  }

  timeoutError(model: string, limit: number): LLMError {
    return llmTimeout({ provider: this.provider, model }, limit);
  }

  /** Waits out the delay before retry number `attempt`, or rethrows `error` when it should not be retried. */
  async beforeRetry(
    error: unknown,
    attempt: number,
    model: string,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const delay = this.delayBefore(attempt, error, signal);
    if (delay === undefined) throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    this.config.onRetry?.({ provider: this.provider, model, attempt, delay, error: cause });
    await sleep(delay, signal, cause);
  }

  private delayBefore(attempt: number, error: unknown, signal?: AbortSignal): number | undefined {
    if (attempt > this.config.maxRetries || signal?.aborted || !isRetryableError(error)) {
      return undefined;
    }
    const requested = error instanceof CogitatorError ? error.retryAfter : undefined;
    if (requested !== undefined) {
      return requested <= this.config.maxRetryAfter ? requested : undefined;
    }
    const backoff = Math.min(this.config.baseDelay * 2 ** (attempt - 1), this.config.maxDelay);
    return Math.round(backoff * (0.8 + Math.random() * 0.4));
  }
}

/**
 * Runs a provider call that is not chat, such as a decision model, with the
 * retry policy LLM backends get; `false` calls it once.
 */
export function retryLLMCall<T>(
  config: LLMRetryConfig | false | undefined,
  target: { provider: LLMBackendProvider; model: string; signal?: AbortSignal },
  call: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  if (config === false) return call(target.signal);
  return new LLMRetryPolicy(target.provider, config).run(target.model, target.signal, call);
}

/**
 * An LLM backend that retries the calls of another one on retryable errors,
 * by `LLMRetryPolicy`. A stream is retried only before its first chunk: after
 * that the caller has already seen part of the answer, so the error is passed
 * on. With `requestTimeout`, a stream gets that long for each chunk.
 */
export class RetryingBackend implements LLMBackend {
  readonly provider: LLMBackendProvider;
  readonly complete?: LLMBackend['complete'];
  private readonly policy: LLMRetryPolicy;

  constructor(
    readonly inner: LLMBackend,
    config: LLMRetryConfig = {}
  ) {
    this.provider = inner.provider;
    this.policy = new LLMRetryPolicy(inner.provider, config);
    const complete = inner.complete?.bind(inner);
    if (complete) {
      this.complete = (request) =>
        this.policy.run(request.model ?? '', request.signal, (signal) =>
          complete(withSignal(request, signal))
        );
    }
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.policy.run(request.model, request.signal, (signal) =>
      this.inner.chat(withSignal(request, signal))
    );
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    for (let attempt = 1; ; attempt++) {
      let started = false;
      try {
        for await (const chunk of this.timedStream(request)) {
          started = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (started) throw error;
        await this.policy.beforeRetry(error, attempt, request.model, request.signal);
      }
    }
  }

  /** The inner stream, with `requestTimeout` for each chunk. */
  private async *timedStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const limit = this.policy.config.requestTimeout;
    if (limit === undefined) {
      yield* this.inner.chatStream(request);
      return;
    }
    const attempt = new AttemptSignal(request.signal);
    const chunks = this.inner.chatStream(withSignal(request, attempt.signal));
    try {
      for (;;) {
        const next = await Promise.race([
          chunks.next(),
          attempt.expire(limit, this.policy.timeoutError(request.model, limit)),
        ]);
        attempt.settle();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      attempt.dispose();
      chunks.return(undefined).catch(() => undefined);
    }
  }
}

/** `backend` with retries per `config`, or `backend` itself when `config` is `false`. */
export function withLLMRetry(
  backend: LLMBackend,
  config: LLMRetryConfig | false | undefined
): LLMBackend {
  if (config === false || backend instanceof RetryingBackend) return backend;
  return new RetryingBackend(backend, config);
}

/** `request` sent with `signal` in place of its own, when there is one. */
function withSignal<T extends { signal?: AbortSignal }>(
  request: T,
  signal: AbortSignal | undefined
): T {
  return signal && signal !== request.signal ? { ...request, signal } : request;
}

/**
 * The signal of one attempt: aborted with the caller's signal, or when the attempt runs out of
 * time. `expire` arms the timer and rejects with the given error when it fires.
 */
class AttemptSignal {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAbort = () => this.controller.abort(this.parent?.reason);

  constructor(private readonly parent: AbortSignal | undefined) {
    if (parent?.aborted) this.controller.abort(parent.reason);
    else parent?.addEventListener('abort', this.onAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  expire(ms: number, error: Error): Promise<never> {
    this.settle();
    return new Promise<never>((_, reject) => {
      this.timer = setTimeout(() => {
        this.controller.abort(error);
        reject(error);
      }, ms);
    });
  }

  settle(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.settle();
    this.parent?.removeEventListener('abort', this.onAbort);
  }
}

function sleep(ms: number, signal: AbortSignal | undefined, error: Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
