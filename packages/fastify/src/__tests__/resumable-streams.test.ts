import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConformanceRuntime, parseSseFrames } from '@cogitator-ai/server-shared';
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function register(options: Partial<CogitatorPluginOptions> = {}) {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator: new ConformanceRuntime() as unknown as CogitatorPluginOptions['cogitator'],
    agents: {
      assistant: { name: 'assistant', config: { tools: [] } },
    } as unknown as CogitatorPluginOptions['agents'],
    prefix: '/api',
    sseHeartbeatMs: 0,
    auth: (request) => {
      const user = request.headers['x-user'];
      return typeof user === 'string' ? { userId: user } : {};
    },
    resumableStreams: true,
    ...options,
  });
  return app;
}

async function stream(server: FastifyInstance, headers: Record<string, string> = {}) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/agents/assistant/stream',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ input: 'hi' }),
  });
  return parseSseFrames(res.body);
}

describe('resumable streams', () => {
  it('reconnects a request with no body, which the body schema would refuse', async () => {
    const server = await register();
    const frames = await stream(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/agents/assistant/stream',
      headers: { 'last-event-id': frames[4]!.id! },
    });

    expect(res.statusCode).toBe(200);
    expect(parseSseFrames(res.body)).toEqual(frames.slice(5));
  });

  it('answers 404 NOT_FOUND for a reconnect to an agent it does not have', async () => {
    const server = await register();
    const frames = await stream(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/agents/nobody/stream',
      headers: { 'last-event-id': frames[0]!.id! },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('lets only the user who started the stream reconnect to it', async () => {
    const server = await register();
    const frames = await stream(server, { 'x-user': 'alice' });
    const reconnect = (headers: Record<string, string>) =>
      server.inject({
        method: 'POST',
        url: `/api/agents/assistant/stream?lastEventId=${encodeURIComponent(frames[0]!.id!)}`,
        headers,
      });

    const refused = await reconnect({ 'x-user': 'mallory' });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: { code: 'STREAM_NOT_FOUND' } });
    expect((await reconnect({ 'x-user': 'alice' })).statusCode).toBe(200);
  });
});
