import { describe, it, expect, vi } from 'vitest';
import { withRetry, retryable } from '../utils/retry';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

function retryableError(message: string): CogitatorError {
  return new CogitatorError({
    message,
    code: ErrorCode.LLM_RATE_LIMITED,
    retryable: true,
  });
}

describe('withRetry', () => {
  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error and succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError('rate limit'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('always fails'));

    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 10 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should abort via AbortSignal', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(retryableError('fail'));

    setTimeout(() => controller.abort(), 50);

    await expect(
      withRetry(fn, { maxRetries: 10, baseDelay: 100, signal: controller.signal })
    ).rejects.toThrow('Retry aborted');
  });

  it('should call onRetry callback before each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(retryableError('err')).mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, baseDelay: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, expect.any(Number));
  });

  describe('regression: abort listener cleanup', () => {
    it('should use { once: true } for abort listeners to prevent memory leaks', async () => {
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');

      const fn = vi.fn().mockRejectedValueOnce(retryableError('temporary')).mockResolvedValue('ok');

      await withRetry(fn, { maxRetries: 3, baseDelay: 10, signal: controller.signal });

      const abortAddCalls = addSpy.mock.calls.filter(([event]) => event === 'abort');
      expect(abortAddCalls.length).toBeGreaterThan(0);

      for (const call of abortAddCalls) {
        expect(call[2]).toEqual(expect.objectContaining({ once: true }));
      }

      addSpy.mockRestore();
    });

    it('should not leak listeners when retrying multiple times', async () => {
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');

      const fn = vi
        .fn()
        .mockRejectedValueOnce(retryableError('err1'))
        .mockRejectedValueOnce(retryableError('err2'))
        .mockResolvedValue('ok');

      await withRetry(fn, { maxRetries: 5, baseDelay: 10, signal: controller.signal });

      const abortListeners = addSpy.mock.calls.filter(([event]) => event === 'abort');
      for (const call of abortListeners) {
        expect(call[2]).toEqual(expect.objectContaining({ once: true }));
      }

      addSpy.mockRestore();
    });

    it('should clean up timer on abort', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(retryableError('fail'));

      setTimeout(() => controller.abort(), 30);

      await expect(
        withRetry(fn, { maxRetries: 10, baseDelay: 200, signal: controller.signal })
      ).rejects.toThrow('Retry aborted');

      expect(fn.mock.calls.length).toBeLessThan(10);
    });
  });
});

describe('retryable', () => {
  it('should wrap a function with retry behavior', async () => {
    const fn = vi.fn().mockRejectedValueOnce(retryableError('err')).mockResolvedValue(42);

    const retryableFn = retryable(fn, { maxRetries: 3, baseDelay: 10 });
    const result = await retryableFn();
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
