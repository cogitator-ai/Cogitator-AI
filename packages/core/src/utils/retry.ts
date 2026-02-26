/**
 * Retry utility with exponential backoff
 */

import { CogitatorError, ErrorCode, isRetryableError, getRetryDelay } from '@cogitator-ai/types';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Backoff strategy (default: 'exponential') */
  backoff?: 'exponential' | 'linear' | 'constant';
  /** Jitter factor 0-1 to randomize delays (default: 0.1) */
  jitter?: number;
  /** Custom function to determine if error should be retried */
  retryIf?: (error: Error, attempt: number) => boolean;
  /** Called before each retry attempt */
  onRetry?: (error: Error, attempt: number, delay: number) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryIf' | 'onRetry' | 'signal'>> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential',
  jitter: 0.1,
};

/**
 * Calculate delay for a given attempt
 */
function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  backoff: 'exponential' | 'linear' | 'constant',
  jitter: number
): number {
  let delay: number;

  switch (backoff) {
    case 'exponential':
      delay = baseDelay * Math.pow(2, attempt - 1);
      break;
    case 'linear':
      delay = baseDelay * attempt;
      break;
    case 'constant':
      delay = baseDelay;
      break;
  }

  delay = Math.min(delay, maxDelay);

  if (jitter > 0) {
    const jitterAmount = delay * jitter;
    delay = delay + (Math.random() * 2 - 1) * jitterAmount;
  }

  return Math.floor(delay);
}

/**
 * Sleep for a given duration with optional abort signal
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Retry aborted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Retry aborted'));
    };

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute a function with automatic retries on failure
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchFromAPI(),
 *   {
 *     maxRetries: 5,
 *     baseDelay: 1000,
 *     backoff: 'exponential',
 *     onRetry: (error, attempt) => {
 *       console.log(`Retry ${attempt}: ${error.message}`);
 *     },
 *   }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isLastAttempt = attempt > opts.maxRetries;
      const shouldRetry = opts.retryIf
        ? opts.retryIf(lastError, attempt)
        : isRetryableError(lastError);

      if (isLastAttempt || !shouldRetry) {
        throw lastError;
      }

      const errorDelay = getRetryDelay(lastError, 0);
      const calculatedDelay = calculateDelay(
        attempt,
        opts.baseDelay,
        opts.maxDelay,
        opts.backoff,
        opts.jitter
      );
      const delay = errorDelay > 0 ? errorDelay : calculatedDelay;

      opts.onRetry?.(lastError, attempt, delay);

      await sleep(delay, opts.signal);
    }
  }

  throw (
    lastError ??
    new CogitatorError({
      message: 'Retry exhausted',
      code: ErrorCode.INTERNAL_ERROR,
    })
  );
}

/**
 * Create a retryable version of a function
 *
 * @example
 * ```typescript
 * const retryableFetch = retryable(fetchFromAPI, { maxRetries: 3 });
 * const result = await retryableFetch(url);
 * ```
 */
export function retryable<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: RetryOptions = {}
): (...args: T) => Promise<R> {
  return (...args: T) => withRetry(() => fn(...args), options);
}
