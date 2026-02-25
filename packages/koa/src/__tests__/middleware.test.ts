import { describe, it, expect, vi } from 'vitest';
import Koa from 'koa';
import Router from '@koa/router';
import request from 'supertest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { createBodyParser } from '../middleware/body-parser.js';
import { createErrorHandler } from '../middleware/error-handler.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createContextMiddleware } from '../middleware/context.js';
import type { CogitatorState, RouteContext } from '../types.js';

const mockCogitator = {} as RouteContext['runtime'];

function buildApp(opts?: {
  auth?: Parameters<typeof createAuthMiddleware>[0];
  withContext?: boolean;
}) {
  const app = new Koa();
  const router = new Router();

  app.use(createErrorHandler());
  app.use(createBodyParser());

  if (opts?.withContext !== false) {
    app.use(
      createContextMiddleware({
        cogitator: mockCogitator,
        agents: { myAgent: {} as never },
        workflows: { myWorkflow: {} as never },
        swarms: { mySwarm: {} as never },
      })
    );
  }

  if (opts?.auth) {
    app.use(createAuthMiddleware(opts.auth));
  }

  router.get('/test', (ctx) => {
    const state = ctx.state as CogitatorState;
    ctx.body = {
      auth: state.auth,
      requestId: state.requestId,
      startTime: state.startTime,
      ctx: state.cogitator,
    };
  });

  router.post('/echo', (ctx) => {
    ctx.body = { received: (ctx.request as unknown as { body: unknown }).body };
  });

  router.put('/echo', (ctx) => {
    ctx.body = { received: (ctx.request as unknown as { body: unknown }).body };
  });

  router.patch('/echo', (ctx) => {
    ctx.body = { received: (ctx.request as unknown as { body: unknown }).body };
  });

  router.get('/throw-cogitator', () => {
    throw new CogitatorError({
      message: 'agent not found',
      code: ErrorCode.AGENT_NOT_FOUND,
    });
  });

  router.get('/throw-unknown', () => {
    throw new Error('database connection string: postgres://user:pass@host/db');
  });

  router.get('/throw-413', () => {
    const err = new Error('Payload too large') as Error & { status: number };
    err.status = 413;
    throw err;
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}

describe('createBodyParser', () => {
  it('parses valid JSON body on POST', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ hello: 'world' });
  });

  it('parses valid JSON body on PUT', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .put('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ method: 'put' }));

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ method: 'put' });
  });

  it('parses valid JSON body on PATCH', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .patch('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ method: 'patch' }));

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ method: 'patch' });
  });

  it('returns 400 for invalid JSON', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{not valid json}');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' },
    });
  });

  it('skips body parsing for GET requests', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/test').set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
  });

  it('skips body parsing for non-JSON content types', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .post('/echo')
      .set('Content-Type', 'text/plain')
      .send('plain text');

    expect(res.status).toBe(200);
    expect(res.body.received).toBeUndefined();
  });

  it('rejects payloads exceeding 1MB', async () => {
    const app = buildApp();
    const largeBody = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) });

    await expect(
      request(app.callback()).post('/echo').set('Content-Type', 'application/json').send(largeBody)
    ).rejects.toThrow(/socket hang up|ECONNRESET/);
  });
});

describe('createErrorHandler', () => {
  it('returns proper status and message for CogitatorError', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/throw-cogitator');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { message: 'agent not found', code: ErrorCode.AGENT_NOT_FOUND },
    });
  });

  it('returns 500 with generic message for unknown errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp();
    const res = await request(app.callback()).get('/throw-unknown');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR },
    });

    consoleSpy.mockRestore();
  });

  it('does not leak internal error details to the client', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp();
    const res = await request(app.callback()).get('/throw-unknown');

    expect(JSON.stringify(res.body)).not.toContain('postgres://');
    consoleSpy.mockRestore();
  });

  it('handles status 413 PayloadTooLargeError', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/throw-413');

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: { message: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('skips response when headers already sent', async () => {
    const app = new Koa();
    const router = new Router();

    app.use(createErrorHandler());

    router.get('/partial', (ctx) => {
      ctx.status = 200;
      ctx.res.write('partial');
      (ctx as unknown as { headerSent: boolean }).headerSent = true;
      throw new Error('after headers sent');
    });

    app.use(router.routes());

    const res = await request(app.callback()).get('/partial');
    expect(res.status).toBe(200);
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
      const app = new Koa();
      const router = new Router();

      app.use(createErrorHandler());
      router.get('/err', () => {
        throw new CogitatorError({ message: `error: ${code}`, code });
      });
      app.use(router.routes());

      const res = await request(app.callback()).get('/err');
      expect(res.status).toBe(expectedStatus);
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.message).toBe(`error: ${code}`);
    }
  });
});

describe('createAuthMiddleware', () => {
  it('sets auth context when authFn succeeds', async () => {
    const authFn = vi.fn().mockResolvedValue({ userId: 'u1', roles: ['admin'] });
    const app = buildApp({ auth: authFn });

    const res = await request(app.callback()).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ userId: 'u1', roles: ['admin'] });
  });

  it('returns 401 when authFn throws a non-server error', async () => {
    const authFn = vi.fn().mockRejectedValue(new Error('invalid token'));
    const app = buildApp({ auth: authFn });

    const res = await request(app.callback()).get('/test');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { message: 'invalid token', code: 'UNAUTHORIZED' },
    });
  });

  it('re-throws errors with status >= 500 to the error handler', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serverError = new Error('database down') as Error & { status: number };
    serverError.status = 500;
    const authFn = vi.fn().mockRejectedValue(serverError);
    const app = buildApp({ auth: authFn });

    const res = await request(app.callback()).get('/test');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR },
    });
    consoleSpy.mockRestore();
  });

  it('returns generic "Unauthorized" when error has no message', async () => {
    const authFn = vi.fn().mockRejectedValue('string error');
    const app = buildApp({ auth: authFn });

    const res = await request(app.callback()).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Unauthorized');
  });

  it('sets auth to undefined when authFn returns undefined', async () => {
    const authFn = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ auth: authFn });

    const res = await request(app.callback()).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.auth).toBeUndefined();
  });

  it('authFn is called for every request', async () => {
    const authFn = vi.fn().mockResolvedValue({ userId: 'u1' });
    const app = buildApp({ auth: authFn });
    const server = app.callback();

    await request(server).get('/test');
    await request(server).get('/test');
    await request(server).get('/test');

    expect(authFn).toHaveBeenCalledTimes(3);
  });

  it('authFn receives Koa context and can read headers', async () => {
    const authFn = vi.fn().mockImplementation(async (ctx: Koa.Context) => {
      const header = ctx.get('authorization');
      if (header === 'Bearer valid-token') {
        return { userId: 'from-header' };
      }
      throw new Error('bad token');
    });
    const app = buildApp({ auth: authFn });
    const server = app.callback();

    const okRes = await request(server).get('/test').set('Authorization', 'Bearer valid-token');
    expect(okRes.status).toBe(200);
    expect(okRes.body.auth).toEqual({ userId: 'from-header' });

    const failRes = await request(server).get('/test').set('Authorization', 'Bearer wrong');
    expect(failRes.status).toBe(401);
  });
});

describe('createContextMiddleware', () => {
  it('sets cogitator context with runtime, agents, workflows, swarms', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.ctx.runtime).toEqual({});
    expect(res.body.ctx.agents).toEqual({ myAgent: {} });
    expect(res.body.ctx.workflows).toEqual({ myWorkflow: {} });
    expect(res.body.ctx.swarms).toEqual({ mySwarm: {} });
  });

  it('defaults agents/workflows/swarms to empty objects when not provided', async () => {
    const app = new Koa();
    const router = new Router();

    app.use(createContextMiddleware({ cogitator: mockCogitator }));
    router.get('/test', (ctx) => {
      const state = ctx.state as CogitatorState;
      ctx.body = state.cogitator;
    });
    app.use(router.routes());

    const res = await request(app.callback()).get('/test');
    expect(res.body.agents).toEqual({});
    expect(res.body.workflows).toEqual({});
    expect(res.body.swarms).toEqual({});
  });

  it('generates requestId starting with req_', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/test');

    expect(res.body.requestId).toMatch(/^req_/);
    expect(res.body.requestId.length).toBeGreaterThan(4);
  });

  it('generates unique request ids across concurrent requests', async () => {
    const app = buildApp();
    const server = app.callback();

    const [res1, res2] = await Promise.all([
      request(server).get('/test'),
      request(server).get('/test'),
    ]);

    expect(res1.body.requestId).not.toBe(res2.body.requestId);
  });

  it('sets startTime close to Date.now()', async () => {
    const app = buildApp();
    const before = Date.now();
    const res = await request(app.callback()).get('/test');
    const after = Date.now();

    expect(res.body.startTime).toBeGreaterThanOrEqual(before);
    expect(res.body.startTime).toBeLessThanOrEqual(after);
  });
});
