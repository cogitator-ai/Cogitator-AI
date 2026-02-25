import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type { HonoEnv, AuthContext } from '../types.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createContextMiddleware } from '../middleware/context.js';
import { errorHandler } from '../middleware/error-handler.js';

const mockCogitator = {} as HonoEnv['Variables']['cogitator']['runtime'];

function buildApp(opts?: { auth?: Parameters<typeof createAuthMiddleware>[0] }) {
  const app = new Hono<HonoEnv>();

  app.use(
    '*',
    createContextMiddleware({
      cogitator: mockCogitator,
      agents: { myAgent: {} as never },
      workflows: { myWorkflow: {} as never },
      swarms: { mySwarm: {} as never },
    })
  );

  if (opts?.auth) {
    app.use('*', createAuthMiddleware(opts.auth));
  }

  app.onError(errorHandler);

  app.get('/test', (c) => {
    return c.json({
      auth: c.get('cogitatorAuth'),
      requestId: c.get('cogitatorRequestId'),
      startTime: c.get('cogitatorStartTime'),
      ctx: c.get('cogitator'),
    });
  });

  app.get('/throw-cogitator', () => {
    throw new CogitatorError({
      message: 'agent not found',
      code: ErrorCode.AGENT_NOT_FOUND,
    });
  });

  app.get('/throw-unknown', () => {
    throw new Error('unexpected boom');
  });

  return app;
}

describe('createContextMiddleware', () => {
  it('sets cogitator context with runtime, agents, workflows, swarms', async () => {
    const app = buildApp();
    const res = await app.request('/test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ctx.runtime).toEqual({});
    expect(body.ctx.agents).toEqual({ myAgent: {} });
    expect(body.ctx.workflows).toEqual({ myWorkflow: {} });
    expect(body.ctx.swarms).toEqual({ mySwarm: {} });
  });

  it('defaults agents/workflows/swarms to empty objects when not provided', async () => {
    const app = new Hono<HonoEnv>();
    app.use('*', createContextMiddleware({ cogitator: mockCogitator }));
    app.get('/test', (c) => c.json(c.get('cogitator')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.agents).toEqual({});
    expect(body.workflows).toEqual({});
    expect(body.swarms).toEqual({});
  });

  it('sets cogitatorRequestId starting with req_', async () => {
    const app = buildApp();
    const res = await app.request('/test');
    const body = await res.json();
    expect(body.requestId).toMatch(/^req_/);
    expect(body.requestId.length).toBeGreaterThan(4);
  });

  it('generates unique request ids', async () => {
    const app = buildApp();
    const [res1, res2] = await Promise.all([app.request('/test'), app.request('/test')]);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.requestId).not.toBe(body2.requestId);
  });

  it('sets cogitatorStartTime close to Date.now()', async () => {
    const app = buildApp();
    const before = Date.now();
    const res = await app.request('/test');
    const after = Date.now();
    const body = await res.json();
    expect(body.startTime).toBeGreaterThanOrEqual(before);
    expect(body.startTime).toBeLessThanOrEqual(after);
  });
});

describe('createAuthMiddleware', () => {
  it('sets auth context when authFn succeeds', async () => {
    const authFn = vi.fn().mockResolvedValue({ userId: 'u1', roles: ['admin'] });
    const app = buildApp({ auth: authFn });

    const res = await app.request('/test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth).toEqual({ userId: 'u1', roles: ['admin'] });
  });

  it('returns 401 when authFn throws', async () => {
    const authFn = vi.fn().mockRejectedValue(new Error('invalid token'));
    const app = buildApp({ auth: authFn });

    const res = await app.request('/test');
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toEqual({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
  });

  it('passes through when no auth middleware is configured', async () => {
    const app = buildApp();
    const res = await app.request('/test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth).toBeUndefined();
  });

  it('sets auth to undefined when authFn returns undefined', async () => {
    const authFn = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ auth: authFn });

    const res = await app.request('/test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth).toBeUndefined();
  });

  it('authFn receives Hono Context and can read headers', async () => {
    const authFn = vi.fn().mockImplementation(async (c) => {
      const header = c.req.header('authorization');
      if (header === 'Bearer valid-token') {
        return { userId: 'from-header' } satisfies AuthContext;
      }
      throw new Error('bad token');
    });
    const app = buildApp({ auth: authFn });

    const okRes = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).auth).toEqual({ userId: 'from-header' });

    const failRes = await app.request('/test', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(failRes.status).toBe(401);
  });

  it('authFn is called for every request', async () => {
    const authFn = vi.fn().mockResolvedValue({ userId: 'u1' });
    const app = buildApp({ auth: authFn });

    await app.request('/test');
    await app.request('/test');
    await app.request('/test');

    expect(authFn).toHaveBeenCalledTimes(3);
  });
});

describe('errorHandler', () => {
  it('returns proper status and message for CogitatorError', async () => {
    const app = buildApp();
    const res = await app.request('/throw-cogitator');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({
      error: { message: 'agent not found', code: ErrorCode.AGENT_NOT_FOUND },
    });
  });

  it('returns 500 with generic message for unknown errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp();

    const res = await app.request('/throw-unknown');
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({
      error: { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR },
    });

    consoleSpy.mockRestore();
  });

  it('maps different CogitatorError codes to correct HTTP status', async () => {
    const cases: Array<{ code: ErrorCode; expectedStatus: number }> = [
      { code: ErrorCode.VALIDATION_ERROR, expectedStatus: 400 },
      { code: ErrorCode.TOOL_NOT_FOUND, expectedStatus: 404 },
      { code: ErrorCode.LLM_RATE_LIMITED, expectedStatus: 429 },
      { code: ErrorCode.INTERNAL_ERROR, expectedStatus: 500 },
      { code: ErrorCode.LLM_UNAVAILABLE, expectedStatus: 503 },
    ];

    for (const { code, expectedStatus } of cases) {
      const app = new Hono<HonoEnv>();
      app.onError(errorHandler);
      app.get('/err', () => {
        throw new CogitatorError({ message: `error: ${code}`, code });
      });

      const res = await app.request('/err');
      expect(res.status).toBe(expectedStatus);

      const body = await res.json();
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(`error: ${code}`);
    }
  });

  it('does not leak internal error details to the client', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = new Hono<HonoEnv>();
    app.onError(errorHandler);
    app.get('/err', () => {
      throw new Error('database connection string: postgres://user:pass@host/db');
    });

    const res = await app.request('/err');
    const body = await res.json();
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('postgres://');

    consoleSpy.mockRestore();
  });
});
