import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../client/retry.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry by default (maxRetries=0)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(withRetry(fn)).rejects.toThrow('network error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable network error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('network error')).mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 2, delay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on timeout error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 1, delay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 1, delay: 10 });
    expect(result).toBe('ok');
  });

  it('does not retry AbortError', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    const fn = vi.fn().mockRejectedValue(abortError);
    await expect(withRetry(fn, { maxRetries: 3, delay: 10 })).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('validation failed'));
    await expect(withRetry(fn, { maxRetries: 3, delay: 10 })).rejects.toThrow('validation failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(withRetry(fn, { maxRetries: 2, delay: 10 })).rejects.toThrow('network error');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses linear backoff', async () => {
    const start = Date.now();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, delay: 50, backoff: 'linear' });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('uses exponential backoff by default', async () => {
    const start = Date.now();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 3, delay: 50, backoff: 'exponential' });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });
});
