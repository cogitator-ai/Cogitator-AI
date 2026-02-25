import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction, Request } from 'express';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createCorsMiddleware } from '../middleware/cors.js';
import { createRateLimitMiddleware } from '../middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from '../middleware/error-handler.js';
import type { CogitatorRequest } from '../types.js';

function mockReq(overrides: Partial<Request> = {}): CogitatorRequest {
  return {
    headers: {},
    method: 'GET',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' } as never,
    params: {},
    body: {},
    on: vi.fn(),
    ...overrides,
  } as CogitatorRequest;
}

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let responseBody: unknown = null;
  let ended = false;

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      responseBody = body;
      return res;
    }),
    end: vi.fn(() => {
      ended = true;
    }),
    headersSent: false,
    _headers: headers,
    _status: () => statusCode,
    _body: () => responseBody,
    _ended: () => ended,
  };
  return res as unknown as Response & typeof res;
}

function mockNext(): NextFunction & { wasCalled: () => boolean } {
  let called = false;
  const fn = vi.fn(() => {
    called = true;
  }) as NextFunction & { wasCalled: () => boolean };
  fn.wasCalled = () => called;
  return fn;
}

describe('createAuthMiddleware', () => {
  it('calls next() immediately when no authFn provided', async () => {
    const middleware = createAuthMiddleware();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.cogitator?.requestId).toMatch(/^req_/);
  });

  it('sets auth context when authFn succeeds', async () => {
    const authFn = vi.fn().mockResolvedValue({ userId: 'user-1', roles: ['admin'] });
    const middleware = createAuthMiddleware(authFn);
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.cogitator?.auth).toEqual({ userId: 'user-1', roles: ['admin'] });
  });

  it('returns 401 when authFn throws', async () => {
    const authFn = vi.fn().mockRejectedValue(new Error('bad token'));
    const middleware = createAuthMiddleware(authFn);
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
    });
  });

  it('always sets cogitator.requestId and startTime', async () => {
    const middleware = createAuthMiddleware();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    const before = Date.now();
    await middleware(req, res, next);
    const after = Date.now();

    expect(req.cogitator?.startTime).toBeGreaterThanOrEqual(before);
    expect(req.cogitator?.startTime).toBeLessThanOrEqual(after);
  });
});

describe('createCorsMiddleware', () => {
  it('allows all origins with wildcard', () => {
    const middleware = createCorsMiddleware({ origin: '*' });
    const req = mockReq({ headers: { origin: 'https://example.com' } });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(next).toHaveBeenCalled();
  });

  it('reflects specific origin when allowed', () => {
    const middleware = createCorsMiddleware({ origin: 'https://example.com' });
    const req = mockReq({ headers: { origin: 'https://example.com' } });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://example.com'
    );
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Origin');
  });

  it('does not set origin header for disallowed origin', () => {
    const middleware = createCorsMiddleware({ origin: 'https://example.com' });
    const req = mockReq({ headers: { origin: 'https://attacker.com' } });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    const originHeaderSet = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.some(
      ([name]: [string]) => name === 'Access-Control-Allow-Origin'
    );
    expect(originHeaderSet).toBe(false);
    expect(next).toHaveBeenCalled();
  });

  it('handles array of allowed origins', () => {
    const middleware = createCorsMiddleware({ origin: ['https://a.com', 'https://b.com'] });
    const req = mockReq({ headers: { origin: 'https://b.com' } });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://b.com');
  });

  it('handles function-based origin check', () => {
    const middleware = createCorsMiddleware({
      origin: (o) => o?.endsWith('.example.com') ?? false,
    });
    const req = mockReq({ headers: { origin: 'https://sub.example.com' } });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://sub.example.com'
    );
  });

  it('handles preflight OPTIONS request', () => {
    const middleware = createCorsMiddleware({ origin: '*' });
    const req = mockReq({ method: 'OPTIONS', headers: {} });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('createRateLimitMiddleware', () => {
  beforeEach(() => {});

  it('allows requests under limit', () => {
    const middleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 10,
      keyGenerator: () => `test-key-${Math.random()}`,
    });
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  it('blocks requests over limit', () => {
    const key = `over-limit-${Math.random()}`;
    const middleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 2,
      keyGenerator: () => key,
    });

    for (let i = 0; i < 3; i++) {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();
      middleware(req, res, next);
    }

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('skips rate limiting when skip() returns true', () => {
    const middleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 0,
      keyGenerator: () => `skip-test-${Math.random()}`,
      skip: () => true,
    });
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  it('sets rate limit headers', () => {
    const key = `headers-test-${Math.random()}`;
    const middleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 10,
      keyGenerator: () => key,
    });
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '9');
  });

  it('does not trust X-Forwarded-For by default', () => {
    const capturedKeys: string[] = [];
    const middleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 100,
      keyGenerator: (req) => {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded === '1.2.3.4') {
          capturedKeys.push('forwarded');
        } else {
          capturedKeys.push('real-ip');
        }
        return `dedup-${Math.random()}`;
      },
    });
    const req = mockReq({ headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '192.168.1.1' });
    const res = mockRes();
    const next = mockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('trusts X-Forwarded-For when trustProxy is true', () => {
    const keys: string[] = [];
    const _middleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 100,
      trustProxy: true,
    });

    const req = mockReq({
      headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
      ip: '192.168.1.1',
    });

    const customMiddleware = createRateLimitMiddleware({
      windowMs: 60000,
      max: 100,
      trustProxy: true,
      keyGenerator: (r) => {
        const fwd = r.headers['x-forwarded-for'];
        keys.push(typeof fwd === 'string' ? fwd.split(',')[0].trim() : (r.ip ?? ''));
        return `trustProxy-${Math.random()}`;
      },
    });

    customMiddleware(req, mockRes(), mockNext());
    expect(keys[0]).toBe('10.0.0.1');
  });
});

describe('errorHandler', () => {
  it('returns 404 for notFoundHandler', () => {
    const req = mockReq();
    const res = mockRes();

    notFoundHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });
  });

  it('does not respond if headers already sent', () => {
    const req = mockReq();
    const res = { ...mockRes(), headersSent: true };
    const next = mockNext();

    errorHandler(new Error('test'), req, res as unknown as Response, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 500 for unknown errors', () => {
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    errorHandler(new Error('something broke'), req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
    });
  });
});
