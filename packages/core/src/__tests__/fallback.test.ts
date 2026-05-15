import { describe, it, expect, vi } from 'vitest';
import {
  withFallback,
  withGracefulDegradation,
  createLLMFallbackExecutor,
} from '../utils/fallback';
import { CircuitBreakerRegistry } from '../utils/circuit-breaker';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

describe('withFallback', () => {
  it('returns primary result on success', async () => {
    const result = await withFallback({
      primary: () => Promise.resolve('primary'),
      fallbacks: [{ name: 'backup', fn: () => Promise.resolve('backup') }],
    });
    expect(result).toBe('primary');
  });

  it('falls back when primary fails', async () => {
    const onFallback = vi.fn();
    const result = await withFallback({
      primary: () => Promise.reject(new Error('down')),
      fallbacks: [{ name: 'backup', fn: () => Promise.resolve('backup') }],
      onFallback,
    });

    expect(result).toBe('backup');
    expect(onFallback).toHaveBeenCalledWith('primary', 'backup', expect.any(Error));
  });

  it('tries fallbacks in order', async () => {
    const order: string[] = [];
    const result = await withFallback({
      primary: () => {
        order.push('primary');
        return Promise.reject(new Error('fail'));
      },
      fallbacks: [
        {
          name: 'first',
          fn: () => {
            order.push('first');
            return Promise.reject(new Error('fail'));
          },
        },
        {
          name: 'second',
          fn: () => {
            order.push('second');
            return Promise.resolve('ok');
          },
        },
      ],
    });

    expect(result).toBe('ok');
    expect(order).toEqual(['primary', 'first', 'second']);
  });

  it('throws when all fail', async () => {
    await expect(
      withFallback({
        primary: () => Promise.reject(new Error('p-fail')),
        fallbacks: [{ name: 'backup', fn: () => Promise.reject(new Error('b-fail')) }],
      })
    ).rejects.toThrow('All fallback options exhausted');
  });
});

describe('withGracefulDegradation', () => {
  it('returns primary on success', async () => {
    const result = await withGracefulDegradation(() => Promise.resolve('data'), {
      defaultValue: 'fallback',
    });
    expect(result).toBe('data');
  });

  it('returns degraded result on failure', async () => {
    const onDegraded = vi.fn();
    const result = await withGracefulDegradation(() => Promise.reject(new Error('boom')), {
      defaultValue: 'cached',
      onDegraded,
    });

    expect(result).toBe('cached');
    expect(onDegraded).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('createLLMFallbackExecutor', () => {
  it('tries models in order', async () => {
    const registry = new CircuitBreakerRegistry();
    const executor = createLLMFallbackExecutor(
      {
        providers: [
          { provider: 'openai', model: 'gpt-4' },
          { provider: 'anthropic', model: 'claude-3' },
        ],
      },
      registry
    );

    const calls: string[] = [];
    const result = await executor(async (provider, model) => {
      calls.push(`${provider}:${model}`);
      if (provider === 'openai')
        throw new CogitatorError({
          message: 'rate limited',
          code: ErrorCode.LLM_RATE_LIMITED,
          retryable: true,
        });
      return `response from ${provider}`;
    });

    expect(result).toBe('response from anthropic');
    expect(calls.filter((c) => c.startsWith('openai')).length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain('anthropic:claude-3');
  });
});
