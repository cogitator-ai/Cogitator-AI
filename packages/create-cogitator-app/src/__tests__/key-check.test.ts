import { describe, it, expect, vi } from 'vitest';
import { checkApiKey, describeKeyCheck } from '../kit/key-check.js';

function answering(status: number) {
  return vi.fn(async () => new Response('{}', { status }));
}

describe('checkApiKey', () => {
  it('sends the key in a header, never in the URL', async () => {
    for (const provider of ['openai', 'anthropic', 'google'] as const) {
      const fetcher = answering(200);
      await checkApiKey(provider, 'secret-key', { fetch: fetcher });
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).not.toContain('secret-key');
      expect(JSON.stringify(init.headers)).toContain('secret-key');
    }
  });

  it('tells a valid, rejected, rate limited and unexpected answer apart', async () => {
    expect(await checkApiKey('openai', 'k', { fetch: answering(200) })).toEqual({
      status: 'valid',
    });
    expect(await checkApiKey('openai', 'k', { fetch: answering(401) })).toEqual({
      status: 'invalid',
      httpStatus: 401,
    });
    expect(await checkApiKey('anthropic', 'k', { fetch: answering(403) })).toEqual({
      status: 'invalid',
      httpStatus: 403,
    });
    expect(await checkApiKey('google', 'k', { fetch: answering(429) })).toEqual({
      status: 'rate-limited',
    });
    expect(await checkApiKey('google', 'k', { fetch: answering(500) })).toEqual({
      status: 'unexpected',
      httpStatus: 500,
    });
  });

  it('reports an unreachable provider and a timeout', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await checkApiKey('openai', 'k', { fetch: offline })).toEqual({
      status: 'unreachable',
      reason: 'the provider could not be reached',
    });

    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'))
          );
        })
    );
    expect(await checkApiKey('openai', 'k', { fetch: slow, timeoutMs: 20 })).toEqual({
      status: 'unreachable',
      reason: 'the request timed out',
    });
  });

  it('describes the result without the key', () => {
    expect(describeKeyCheck('OPENAI_API_KEY', { status: 'valid' })).toBe('OPENAI_API_KEY works');
    expect(describeKeyCheck('OPENAI_API_KEY', { status: 'invalid', httpStatus: 401 })).toBe(
      'OPENAI_API_KEY was rejected (HTTP 401): check the key in .env'
    );
  });
});
