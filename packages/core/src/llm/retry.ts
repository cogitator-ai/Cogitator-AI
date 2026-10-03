import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  LLMProvider,
  LLMRetryConfig,
} from '@cogitator-ai/types';
import { CogitatorError, isRetryableError } from '@cogitator-ai/types';

export const DEFAULT_LLM_RETRY = {
  maxRetries: 2,
  baseDelay: 1000,
  maxDelay: 30_000,
  maxRetryAfter: 60_000,
} as const satisfies Required<Omit<LLMRetryConfig, 'onRetry'>>;

/**
 * An LLM backend that retries the calls of another one on retryable errors.
 *
 * A provider's `Retry-After` is honoured up to `maxRetryAfter`; without one
 * the delay grows exponentially from `baseDelay` up to `maxDelay`. A stream is
 * retried only before its first chunk: after that the caller has already seen
 * part of the answer, so the error is passed on. The request's `signal` stops
 * both the calls and the waits between them.
 */
export class RetryingBackend implements LLMBackend {
  readonly provider: LLMProvider;
  readonly complete?: LLMBackend['complete'];
  private readonly config: Required<Omit<LLMRetryConfig, 'onRetry'>> &
    Pick<LLMRetryConfig, 'onRetry'>;

  constructor(
    readonly inner: LLMBackend,
    config: LLMRetryConfig = {}
  ) {
    this.provider = inner.provider;
    this.config = {
      maxRetries: config.maxRetries ?? DEFAULT_LLM_RETRY.maxRetries,
      baseDelay: config.baseDelay ?? DEFAULT_LLM_RETRY.baseDelay,
      maxDelay: config.maxDelay ?? DEFAULT_LLM_RETRY.maxDelay,
      maxRetryAfter: config.maxRetryAfter ?? DEFAULT_LLM_RETRY.maxRetryAfter,
      onRetry: config.onRetry,
    };
    const complete = inner.complete?.bind(inner);
    if (complete) {
      this.complete = (request) =>
        this.retrying(request.model ?? '', request.signal, () => complete(request));
    }
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.retrying(request.model, request.signal, () => this.inner.chat(request));
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    for (let attempt = 1; ; attempt++) {
      let started = false;
      try {
        for await (const chunk of this.inner.chatStream(request)) {
          started = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (started) throw error;
        await this.beforeRetry(error, attempt, request.model, request.signal);
      }
    }
  }

  private async retrying<T>(
    model: string,
    signal: AbortSignal | undefined,
    call: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        await this.beforeRetry(error, attempt, model, signal);
      }
    }
  }

  /** Waits out the delay before retry number `attempt`, or rethrows `error` when it should not be retried. */
  private async beforeRetry(
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

/** `backend` with retries per `config`, or `backend` itself when `config` is `false`. */
export function withLLMRetry(
  backend: LLMBackend,
  config: LLMRetryConfig | false | undefined
): LLMBackend {
  if (config === false || backend instanceof RetryingBackend) return backend;
  return new RetryingBackend(backend, config);
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
