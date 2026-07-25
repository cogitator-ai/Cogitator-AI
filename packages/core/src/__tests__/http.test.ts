import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpRequest } from '../tools/http';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

function mockFetchResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
) {
  const status = init?.status ?? 200;
  const headers = new Headers(init?.headers ?? { 'content-type': 'application/json' });
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpRequest tool', () => {
  it('makes GET request', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({ url: 'https://example.com/get', method: 'GET' }));

    const result = await httpRequest.execute({ url: 'https://example.com/get' }, mockContext);
    expect(result).toHaveProperty('status', 200);
    expect(result).toHaveProperty('method', 'GET');
    expect(result).toHaveProperty('body');
    expect(result).toHaveProperty('headers');
  });

  it('makes POST request with body', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({ json: { test: 'data' }, method: 'POST' }));

    const result = await httpRequest.execute(
      {
        url: 'https://example.com/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      },
      mockContext
    );
    expect(result).toHaveProperty('status', 200);
    expect(result).toHaveProperty('method', 'POST');
    const body = JSON.parse((result as { body: string }).body);
    expect(body.json).toEqual({ test: 'data' });
  });

  it('includes custom headers', async () => {
    const fetchMock = mockFetchResponse({
      headers: { 'X-Custom-Header': 'test-value' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await httpRequest.execute(
      {
        url: 'https://example.com/headers',
        headers: { 'X-Custom-Header': 'test-value' },
      },
      mockContext
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = requestInit.headers as Record<string, string>;
    expect(sentHeaders['X-Custom-Header']).toBe('test-value');

    const body = JSON.parse((result as { body: string }).body);
    expect(body.headers['X-Custom-Header']).toBe('test-value');
  });

  it('returns error for invalid URL', async () => {
    const result = await httpRequest.execute(
      { url: 'https://this-domain-does-not-exist-12345.com/' },
      mockContext
    );
    expect(result).toHaveProperty('error');
  });

  it('handles timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('The operation was aborted', 'AbortError'));
              return;
            }
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
        });
      })
    );

    const result = await httpRequest.execute(
      { url: 'https://example.com/delay/10', timeout: 1000 },
      mockContext
    );
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('timed out');
  });

  it('honors the tool context abort signal', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        expect(signal?.aborted).toBe(true);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      })
    );
    controller.abort();

    const result = await httpRequest.execute(
      { url: 'https://example.com' },
      { ...mockContext, signal: controller.signal }
    );

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('aborted');
  });

  it('returns response headers', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchResponse(
        { ok: true },
        { headers: { 'x-test': 'hello', 'content-type': 'application/json' } }
      )
    );

    const result = await httpRequest.execute(
      { url: 'https://example.com/response-headers' },
      mockContext
    );
    const headers = (result as { headers: Record<string, string> }).headers;
    expect(headers['x-test']).toBe('hello');
  });

  it('handles non-2xx status codes', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({ error: 'Not Found' }, { status: 404 }));

    const result = await httpRequest.execute(
      { url: 'https://example.com/status/404' },
      mockContext
    );
    expect(result).toHaveProperty('status', 404);
  });

  it('has sideEffects declared', () => {
    expect(httpRequest.sideEffects).toContain('network');
  });

  it('has correct metadata', () => {
    expect(httpRequest.name).toBe('http_request');
    const schema = httpRequest.toJSON();
    expect(schema.parameters.properties).toHaveProperty('url');
    expect(schema.parameters.properties).toHaveProperty('method');
  });
});
