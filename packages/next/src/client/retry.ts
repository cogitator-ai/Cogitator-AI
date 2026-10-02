import type { RetryConfig } from '../types.js';
import { HttpError } from './http-error.js';

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 0,
  delay: 1000,
  backoff: 'exponential',
};

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

function getDelay(attempt: number, config: Required<RetryConfig>): number {
  if (config.backoff === 'linear') {
    return config.delay * attempt;
  }
  return config.delay * Math.pow(2, attempt - 1);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return RETRYABLE_STATUSES.has(error.status);
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') return false;
    if (error instanceof TypeError) return true;

    const message = error.message.toLowerCase();
    if (message.includes('network') || message.includes('fetch')) return true;
    if (message.includes('timeout')) return true;
    if (message.includes('502') || message.includes('503') || message.includes('504')) return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  signal?: AbortSignal
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const maxRetries = Number.isFinite(cfg.maxRetries) ? Math.max(0, Math.floor(cfg.maxRetries)) : 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || signal?.aborted || !isRetryableError(error)) {
        throw error;
      }
      await sleep(getDelay(attempt + 1, cfg), signal);
    }
  }
}
