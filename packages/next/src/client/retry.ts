import type { RetryConfig } from '../types.js';

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 0,
  delay: 1000,
  backoff: 'exponential',
};

function getDelay(attempt: number, config: Required<RetryConfig>): number {
  if (config.backoff === 'linear') {
    return config.delay * attempt;
  }
  return config.delay * Math.pow(2, attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return false;

    const message = error.message.toLowerCase();
    if (message.includes('network') || message.includes('fetch')) return true;
    if (message.includes('timeout')) return true;
    if (message.includes('502') || message.includes('503') || message.includes('504')) return true;
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, config?: RetryConfig): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };

  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === cfg.maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const delay = getDelay(attempt + 1, cfg);
      await sleep(delay);
    }
  }

  throw lastError;
}
