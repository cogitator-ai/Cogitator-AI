import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createCorsMiddleware } from '../middleware/cors.js';
import { createRateLimitMiddleware } from '../middleware/rate-limit.js';
import { errorHandler } from '../middleware/error-handler.js';

function req(headers: Record<string, string> = {}, method = 'GET'): Request {
  return {
    headers,
    method,
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as Request;
}

function res() {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  const response = {
    headersSent: false,
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: vi.fn((code: number) => {
      status = code;
      return response;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return response;
    }),
    end: vi.fn(),
  };
  return {
    res: response as unknown as Response,
    headers,
    status: () => status,
    body: () => body,
  };
}

const next = () => vi.fn() as unknown as NextFunction;

describe('createCorsMiddleware hardening', () => {
  it('does not grant credentials to every origin by default for a wildcard origin', () => {
    const r = res();
    createCorsMiddleware({ origin: '*' })(req({ origin: 'https://evil.example' }), r.res, next());

    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(r.headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('reflects the origin when credentials are explicitly enabled with a wildcard', () => {
    const r = res();
    createCorsMiddleware({ origin: '*', credentials: true })(
      req({ origin: 'https://app.example' }),
      r.res,
      next()
    );

    expect(r.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(r.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(r.headers.Vary).toBe('Origin');
  });

  it('sends no credential or preflight grants to disallowed origins', () => {
    const r = res();
    createCorsMiddleware({ origin: 'https://app.example' })(
      req({ origin: 'https://evil.example' }, 'OPTIONS'),
      r.res,
      next()
    );

    expect(r.status()).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(r.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(r.headers['Access-Control-Allow-Methods']).toBeUndefined();
    expect(r.headers.Vary).toBe('Origin');
  });
});

describe('createRateLimitMiddleware hardening', () => {
  it('keys trusted-proxy requests by the nearest hop so clients cannot spoof their IP', () => {
    const limiter = createRateLimitMiddleware({ windowMs: 60_000, max: 1, trustProxy: true });

    const first = res();
    limiter(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), first.res, next());
    const spoofed = res();
    limiter(req({ 'x-forwarded-for': '2.2.2.2, 203.0.113.9' }), spoofed.res, next());

    expect(first.status()).toBe(200);
    expect(spoofed.status()).toBe(429);
  });

  it('shares one bucket for requests without any address instead of disabling limiting', () => {
    const limiter = createRateLimitMiddleware({ windowMs: 60_000, max: 1 });
    const anonymous = () => ({ headers: {}, method: 'GET', socket: {} }) as unknown as Request;

    const first = res();
    limiter(anonymous(), first.res, next());
    const second = res();
    limiter(anonymous(), second.res, next());

    expect(second.status()).toBe(429);
  });

  it.each([
    [{ windowMs: 0, max: 1 }],
    [{ windowMs: Number.NaN, max: 1 }],
    [{ windowMs: 1000, max: -1 }],
  ])('rejects invalid configuration %o', (config) => {
    expect(() => createRateLimitMiddleware(config)).toThrow();
  });
});

describe('errorHandler client errors', () => {
  it('maps body-parser JSON errors to 400', () => {
    const r = res();
    const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      status: 400,
      type: 'entity.parse.failed',
    });
    errorHandler(err, req(), r.res, next());

    expect(r.status()).toBe(400);
    expect(r.body()).toEqual({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } });
  });

  it('maps payload-too-large errors to 413', () => {
    const r = res();
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });
    errorHandler(err, req(), r.res, next());

    expect(r.status()).toBe(413);
    expect(r.body()).toEqual({
      error: { message: 'request entity too large', code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('still hides details of 5xx errors', () => {
    const r = res();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorHandler(
      Object.assign(new Error('db password wrong'), { status: 503 }),
      req(),
      r.res,
      next()
    );
    spy.mockRestore();

    expect(r.status()).toBe(500);
    expect(JSON.stringify(r.body())).not.toContain('password');
  });
});
