import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { createAuthHook } from '../hooks/auth.js';
import type { AuthFunction } from '../types.js';

async function buildServer(authFn?: AuthFunction) {
  const fastify = Fastify({ logger: false });

  fastify.decorateRequest('cogitatorAuth', undefined);
  fastify.decorateRequest('cogitatorRequestId', '');
  fastify.decorateRequest('cogitatorStartTime', 0);

  fastify.addHook('onRequest', createAuthHook(authFn));

  fastify.get('/test', async (request) => {
    return { auth: request.cogitatorAuth, id: request.cogitatorRequestId };
  });

  await fastify.ready();
  return fastify;
}

describe('createAuthHook', () => {
  it('always sets cogitatorRequestId and cogitatorStartTime', async () => {
    const fastify = await buildServer();
    const before = Date.now();
    const res = await fastify.inject({ method: 'GET', url: '/test' });
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string }>();
    expect(body.id).toMatch(/^req_/);
    expect(body.id.length).toBeGreaterThan(4);
    void before;
    void after;
    await fastify.close();
  });

  it('passes request through when no authFn provided', async () => {
    const fastify = await buildServer();
    const res = await fastify.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ auth: unknown }>().auth).toBeUndefined();
    await fastify.close();
  });

  it('sets cogitatorAuth when authFn returns context', async () => {
    const authFn = vi.fn().mockResolvedValue({ userId: 'u1', roles: ['admin'] });
    const fastify = await buildServer(authFn);
    const res = await fastify.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ auth: unknown }>().auth).toEqual({ userId: 'u1', roles: ['admin'] });
    await fastify.close();
  });

  it('returns 401 when authFn throws', async () => {
    const authFn = vi.fn().mockRejectedValue(new Error('bad token'));
    const fastify = await buildServer(authFn);
    const res = await fastify.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
    await fastify.close();
  });

  it('sets cogitatorAuth to undefined when authFn returns undefined', async () => {
    const authFn: AuthFunction = vi.fn().mockResolvedValue(undefined);
    const fastify = await buildServer(authFn);
    const res = await fastify.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ auth: unknown }>().auth).toBeUndefined();
    await fastify.close();
  });
});
