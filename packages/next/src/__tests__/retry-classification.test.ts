import { describe, it, expect, vi } from 'vitest';
import { isRetryableError, withRetry } from '../client/retry.js';
import { HttpError } from '../client/http-error.js';

describe('isRetryableError', () => {
  it.each([408, 429, 502, 503, 504])('retries HTTP %i', (status) => {
    expect(isRetryableError(new HttpError(status, 'x'))).toBe(true);
  });

  it.each([400, 401, 404, 500])('does not retry HTTP %i', (status) => {
    expect(
      isRetryableError(new HttpError(status, `Request failed: ${status} - fetch blew up`))
    ).toBe(false);
  });

  it('retries fetch network TypeErrors', () => {
    expect(isRetryableError(new TypeError('Load failed'))).toBe(true);
  });
});

describe('withRetry', () => {
  it('retries an HttpError 503 whose body does not mention the status', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, 'Request failed: 503 - maintenance'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { maxRetries: 1, delay: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops waiting between attempts when aborted', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('network error'));
    const promise = withRetry(fn, { maxRetries: 3, delay: 10_000 }, controller.signal);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(withRetry(fn, { maxRetries: 3, delay: 1 }, controller.signal)).rejects.toThrow(
      'network error'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats a non-finite maxRetries as no retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(withRetry(fn, { maxRetries: Number.NaN, delay: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
