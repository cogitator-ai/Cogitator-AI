import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitBreakerRegistry } from '../utils/circuit-breaker';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

function retryableError(message: string): CogitatorError {
  return new CogitatorError({
    message,
    code: ErrorCode.LLM_RATE_LIMITED,
    retryable: true,
  });
}

async function rejectRetryable(message: string): Promise<never> {
  throw retryableError(message);
}

describe('CircuitBreaker', () => {
  it('initial state is closed', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe('closed');
  });

  it('stays closed on success', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    await breaker.execute(() => Promise.resolve('ok'));
    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after threshold failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => rejectRetryable('fail')).catch(() => {});
    }

    expect(breaker.getState()).toBe('open');
  });

  it('rejects calls when open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    await breaker.execute(() => rejectRetryable('fail')).catch(() => {});

    expect(breaker.getState()).toBe('open');

    await expect(breaker.execute(() => Promise.resolve('nope'))).rejects.toThrow(
      'Circuit breaker is open'
    );
  });

  it('transitions to half-open after timeout', async () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 100,
      onStateChange,
    });

    await breaker.execute(() => rejectRetryable('fail')).catch(() => {});
    expect(breaker.getState()).toBe('open');

    vi.advanceTimersByTime(100);

    const fn = vi.fn().mockResolvedValue('recovered');
    await breaker.execute(fn);

    expect(breaker.getState()).not.toBe('open');
    expect(fn).toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith('open', 'half-open');

    vi.useRealTimers();
  });

  it('closes from half-open on success', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 100,
      halfOpenRequests: 2,
    });

    await breaker.execute(() => rejectRetryable('fail')).catch(() => {});
    vi.advanceTimersByTime(100);

    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.getState()).toBe('half-open');

    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.getState()).toBe('closed');

    vi.useRealTimers();
  });

  it('re-opens from half-open on failure', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 100,
      halfOpenRequests: 3,
    });

    await breaker.execute(() => rejectRetryable('fail')).catch(() => {});
    vi.advanceTimersByTime(100);

    await breaker.execute(() => rejectRetryable('still broken')).catch(() => {});
    expect(breaker.getState()).toBe('open');

    vi.useRealTimers();
  });

  it('getStats returns accurate stats', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5 });

    await breaker.execute(() => Promise.resolve('ok'));
    await breaker.execute(() => rejectRetryable('err')).catch(() => {});

    const stats = breaker.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
    expect(stats.totalRequests).toBe(2);
    expect(stats.lastSuccess).toBeInstanceOf(Date);
    expect(stats.lastFailure).toBeInstanceOf(Date);
  });

  it('reset() restores closed state', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    await breaker.execute(() => rejectRetryable('fail')).catch(() => {});
    expect(breaker.getState()).toBe('open');

    breaker.reset();

    const stats = breaker.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.failures).toBe(0);
    expect(stats.successes).toBe(0);
    expect(stats.totalRequests).toBe(0);
    expect(stats.lastFailure).toBeUndefined();
    expect(stats.lastSuccess).toBeUndefined();
  });
});

describe('CircuitBreakerRegistry', () => {
  it('creates and retrieves circuit breakers by name', async () => {
    const registry = new CircuitBreakerRegistry();
    const breaker1 = registry.get('service-a');
    const breaker2 = registry.get('service-b');
    const breaker1Again = registry.get('service-a');

    expect(breaker1).toBeInstanceOf(CircuitBreaker);
    expect(breaker2).toBeInstanceOf(CircuitBreaker);
    expect(breaker1Again).toBe(breaker1);
    expect(breaker1).not.toBe(breaker2);
  });

  it('getStats returns all breaker stats', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1 });
    const a = registry.get('a');
    const b = registry.get('b');

    await a.execute(() => Promise.resolve('ok'));
    await b.execute(() => rejectRetryable('err')).catch(() => {});

    const stats = registry.getAllStats();
    expect(Object.keys(stats)).toEqual(['a', 'b']);
    expect(stats.a.successes).toBe(1);
    expect(stats.b.failures).toBe(1);
    expect(stats.b.state).toBe('open');
  });
});
