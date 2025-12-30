import { describe, it, expect } from 'vitest';
import { httpRequest } from '../tools/http.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('httpRequest tool', () => {
  it('makes GET request', async () => {
    const result = await httpRequest.execute(
      { url: 'https://httpbin.org/get' },
      mockContext
    );
    expect(result).toHaveProperty('status', 200);
    expect(result).toHaveProperty('method', 'GET');
    expect(result).toHaveProperty('body');
    expect(result).toHaveProperty('headers');
  });

  it('makes POST request with body', async () => {
    const result = await httpRequest.execute(
      {
        url: 'https://httpbin.org/post',
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
    const result = await httpRequest.execute(
      {
        url: 'https://httpbin.org/headers',
        headers: { 'X-Custom-Header': 'test-value' },
      },
      mockContext
    );
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
    const result = await httpRequest.execute(
      { url: 'https://httpbin.org/delay/10', timeout: 1000 },
      mockContext
    );
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('timed out');
  });

  it('returns response headers', async () => {
    const result = await httpRequest.execute(
      { url: 'https://httpbin.org/response-headers?X-Test=hello' },
      mockContext
    );
    const headers = (result as { headers: Record<string, string> }).headers;
    expect(headers['x-test']).toBe('hello');
  });

  it('handles non-2xx status codes', async () => {
    const result = await httpRequest.execute(
      { url: 'https://httpbin.org/status/404' },
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
