/**
 * Retry module with exponential backoff and jitter
 *
 * Features:
 * - Configurable backoff strategies (constant, linear, exponential)
 * - Jitter to prevent thundering herd
 * - Retryable error detection
 * - Per-attempt hooks for logging/metrics
 */

import type { RetryConfig, BackoffStrategy } from '@cogitator-ai/types';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_BACKOFF: BackoffStrategy = 'exponential';
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_JITTER = 0.1;

/**
 * Internal delay config with all required fields
 */
interface DelayConfig {
  backoff: BackoffStrategy;
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: number;
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
]);

const RETRYABLE_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\bnetwork\b/i,
  /\bconnection\s+(reset|refused|closed|aborted)\b/i,
  /\bsocket\s+hang\s+up\b/i,
  /\brate[\s-]?limit/i,
  /\b(429|500|502|503|504)\b/,
];

/**
 * Default retryable error checker - retries on network/timeout errors
 */
function defaultIsRetryable(error: Error): boolean {
  const errorCode = (error as NodeJS.ErrnoException).code;
  if (errorCode && RETRYABLE_CODES.has(errorCode)) {
    return true;
  }

  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode && [429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }

  return RETRYABLE_PATTERNS.some((p) => p.test(error.message));
}

/**
 * Calculate delay with jitter
 */
function calculateDelay(attempt: number, config: DelayConfig): number {
  let baseDelay: number;

  switch (config.backoff) {
    case 'constant':
      baseDelay = config.initialDelay;
      break;

    case 'linear':
      baseDelay = config.initialDelay * attempt;
      break;

    case 'exponential':
    default:
      baseDelay = config.initialDelay * Math.pow(config.multiplier, attempt - 1);
      break;
  }

  baseDelay = Math.min(baseDelay, config.maxDelay);

  const jitterRange = baseDelay * config.jitter;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(baseDelay + jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Retry result with metadata
 */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalDuration: number;
  delays: number[];
}

/**
 * Attempt metadata passed to hooks
 */
export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
  delay: number;
  error?: Error;
  startTime: number;
  duration: number;
}

/**
 * Extended retry config with hooks
 */
export interface RetryOptions<T = unknown> extends Partial<RetryConfig> {
  onAttempt?: (info: AttemptInfo) => void;
  onRetry?: (info: AttemptInfo) => void;
  onSuccess?: (result: T, info: AttemptInfo) => void;
  onFailure?: (error: Error, info: AttemptInfo) => void;
  abortSignal?: AbortSignal;
}

/**
 * Execute function with retry logic
 */
export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions<T> = {}
): Promise<RetryResult<T>> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const initialDelay = options.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
  const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;
  const jitter = options.jitter ?? DEFAULT_JITTER;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  const delays: number[] = [];
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.abortSignal?.aborted) {
      return {
        success: false,
        error: new Error('Retry aborted'),
        attempts: attempt - 1,
        totalDuration: Date.now() - startTime,
        delays,
      };
    }

    const attemptStart = Date.now();

    try {
      const attemptInfo: AttemptInfo = {
        attempt,
        maxAttempts: maxRetries + 1,
        delay: 0,
        startTime: attemptStart,
        duration: 0,
      };

      options.onAttempt?.(attemptInfo);

      const result = await fn(attempt);
      const duration = Date.now() - attemptStart;

      options.onSuccess?.(result, { ...attemptInfo, duration });

      return {
        success: true,
        result,
        attempts: attempt,
        totalDuration: Date.now() - startTime,
        delays,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const duration = Date.now() - attemptStart;

      const canRetry = attempt <= maxRetries && isRetryable(lastError);

      if (!canRetry) {
        const attemptInfo: AttemptInfo = {
          attempt,
          maxAttempts: maxRetries + 1,
          delay: 0,
          error: lastError,
          startTime: attemptStart,
          duration,
        };
        options.onFailure?.(lastError, attemptInfo);
        break;
      }

      const delay = calculateDelay(attempt, {
        backoff,
        initialDelay,
        maxDelay,
        multiplier,
        jitter,
      });
      delays.push(delay);

      const attemptInfo: AttemptInfo = {
        attempt,
        maxAttempts: maxRetries + 1,
        delay,
        error: lastError,
        startTime: attemptStart,
        duration,
      };
      options.onRetry?.(attemptInfo);

      await sleep(delay, options.abortSignal);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: delays.length + 1,
    totalDuration: Date.now() - startTime,
    delays,
  };
}

/**
 * Create a retryable version of a function
 */
export function withRetry<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
  options: RetryOptions<T> = {}
): (...args: A) => Promise<T> {
  return async (...args: A): Promise<T> => {
    const result = await executeWithRetry(() => fn(...args), options);

    if (!result.success) {
      throw result.error ?? new Error('Retry failed');
    }

    return result.result as T;
  };
}

/**
 * Decorator for retryable class methods
 */
export function Retryable<T = unknown>(options: RetryOptions<T> = {}) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<T>;

    descriptor.value = async function (this: unknown, ...args: unknown[]): Promise<T> {
      const result = await executeWithRetry(() => originalMethod.apply(this, args), options);

      if (!result.success) {
        throw result.error ?? new Error('Retry failed');
      }

      return result.result as T;
    };

    return descriptor;
  };
}

/**
 * Calculate total expected retry time (for timeout estimation)
 */
export function estimateRetryDuration(config: Partial<RetryConfig> = {}): number {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = config.backoff ?? DEFAULT_BACKOFF;
  const initialDelay = config.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = config.maxDelay ?? DEFAULT_MAX_DELAY;
  const multiplier = config.multiplier ?? DEFAULT_MULTIPLIER;

  let total = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let delay: number;

    switch (backoff) {
      case 'constant':
        delay = initialDelay;
        break;
      case 'linear':
        delay = initialDelay * attempt;
        break;
      case 'exponential':
      default:
        delay = initialDelay * Math.pow(multiplier, attempt - 1);
        break;
    }

    total += Math.min(delay, maxDelay);
  }

  return total;
}
