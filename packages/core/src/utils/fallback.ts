/**
 * Fallback utilities for graceful degradation
 */

import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { type CircuitBreakerRegistry } from './circuit-breaker';
import { withRetry, type RetryOptions } from './retry';

/**
 * Fallback chain configuration
 */
export interface FallbackConfig<T> {
  /** Primary operation */
  primary: () => Promise<T>;
  /** Fallback operations in order of preference */
  fallbacks: {
    name: string;
    fn: () => Promise<T>;
  }[];
  /** Retry options for each operation */
  retry?: RetryOptions;
  /** Circuit breaker registry for tracking failures */
  circuitBreakers?: CircuitBreakerRegistry;
  /** Called when falling back */
  onFallback?: (from: string, to: string, error: Error) => void;
}

/**
 * Execute with fallback chain
 *
 * @example
 * ```typescript
 * const result = await withFallback({
 *   primary: () => ollamaBackend.chat(request),
 *   fallbacks: [
 *     { name: 'openai', fn: () => openaiBackend.chat(request) },
 *     { name: 'anthropic', fn: () => anthropicBackend.chat(request) },
 *   ],
 *   retry: { maxRetries: 2 },
 *   onFallback: (from, to, error) => {
 *     console.warn(`Falling back from ${from} to ${to}: ${error.message}`);
 *   },
 * });
 * ```
 */
export async function withFallback<T>(config: FallbackConfig<T>): Promise<T> {
  const { primary, fallbacks, retry, circuitBreakers, onFallback } = config;

  const operations = [
    { name: 'primary', fn: primary },
    ...fallbacks,
  ];

  let lastError: Error | undefined;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const breaker = circuitBreakers?.get(op.name);

    try {
      const execute = async () => {
        if (breaker) {
          return breaker.execute(op.fn);
        }
        return op.fn();
      };

      if (retry) {
        return await withRetry(execute, retry);
      }
      return await execute();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (i < operations.length - 1) {
        const nextOp = operations[i + 1];
        onFallback?.(op.name, nextOp.name, lastError);
      }
    }
  }

  throw new CogitatorError({
    message: `All fallback options exhausted: ${lastError?.message}`,
    code: ErrorCode.INTERNAL_ERROR,
    cause: lastError,
    details: {
      triedOperations: operations.map((op) => op.name),
    },
  });
}

/**
 * LLM fallback chain configuration
 */
export interface LLMFallbackConfig {
  providers: {
    provider: string;
    model: string;
  }[];
}

/**
 * Create an LLM request executor with automatic fallback
 */
export function createLLMFallbackExecutor(
  config: LLMFallbackConfig,
  circuitBreakers: CircuitBreakerRegistry
) {
  return async function executeLLMWithFallback<T>(
    request: (provider: string, model: string) => Promise<T>,
    onFallback?: (from: string, to: string, error: Error) => void
  ): Promise<T> {
    const [primary, ...fallbacks] = config.providers;

    return withFallback({
      primary: () => request(primary.provider, primary.model),
      fallbacks: fallbacks.map((fb) => ({
        name: `${fb.provider}:${fb.model}`,
        fn: () => request(fb.provider, fb.model),
      })),
      retry: { maxRetries: 2, baseDelay: 1000, backoff: 'exponential' },
      circuitBreakers,
      onFallback,
    });
  };
}

/**
 * Graceful degradation wrapper
 *
 * Returns a default value if operation fails after all retries
 */
export async function withGracefulDegradation<T>(
  fn: () => Promise<T>,
  options: {
    defaultValue: T;
    retry?: RetryOptions;
    onDegraded?: (error: Error) => void;
  }
): Promise<T> {
  try {
    if (options.retry) {
      return await withRetry(fn, options.retry);
    }
    return await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    options.onDegraded?.(err);
    return options.defaultValue;
  }
}
