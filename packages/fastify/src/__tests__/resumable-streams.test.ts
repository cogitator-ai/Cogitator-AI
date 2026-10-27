import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ConformanceRuntime,
  InMemoryStreamReplayStore,
  parseSseFrames,
  type NewStreamRecord,
  type StreamReplayStore,
} from '@cogitator-ai/server-shared';
import type { RunOptions } from '@cogitator-ai/types';
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

  it('reconnects a request with an empty JSON body, as the other adapters do', async () => {
    const server = await register();
    const frames = await stream(server);

    const res = await server.inject({
      method: 'POST',
      url: '/api/agents/assistant/stream',
      headers: { 'content-type': 'application/json', 'last-event-id': frames[4]!.id! },
    });

    expect(res.statusCode).toBe(200);
    expect(parseSseFrames(res.body)).toEqual(frames.slice(5));
  });

  it('answers a store that fails a reconnect with 500, not an unhandled error', async () => {
    const failing = new InMemoryStreamReplayStore();
    failing.get = () => Promise.reject(new Error('redis down'));
    const server = await register({ resumableStreams: { store: failing } });

    const res = await server.inject({
      method: 'POST',
      url: '/api/agents/assistant/stream',
      headers: { 'last-event-id': 'stream_x:1' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('stops the runs of resumable streams when the server closes', async () => {
    let signal: AbortSignal | undefined;
    const held = {
      run: (_agent: unknown, options: RunOptions) =>
        new Promise((_, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const server = await register({
      cogitator: held as unknown as CogitatorPluginOptions['cogitator'],
    });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const client = new AbortController();
    const res = await fetch(`${address}/api/agents/assistant/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
      signal: client.signal,
    });
    await res.body!.getReader().read();
    client.abort();

    await server.close();
    app = undefined;
    expect(signal?.aborted).toBe(true);
  });

  it('stops resumable runs before closing, so a client that still reads does not hold the close', async () => {
    let signal: AbortSignal | undefined;
    const held = {
      run: (_agent: unknown, options: RunOptions) =>
        new Promise((_, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const server = await register({
      cogitator: held as unknown as CogitatorPluginOptions['cogitator'],
    });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/agents/assistant/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    const body = res.text();

    await server.close();
    app = undefined;

    expect(signal?.aborted).toBe(true);
    expect(parseSseFrames(await body).at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'STREAM_ABORTED',
    });
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

  it('lets go of a stream whose client left while the store created it', async () => {
    const memory = new InMemoryStreamReplayStore();
    let reached!: () => void;
    const creating = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const store: StreamReplayStore = Object.assign(Object.create(memory) as StreamReplayStore, {
      create: async (stream: NewStreamRecord) => {
        reached();
        await released;
        return memory.create(stream);
      },
    });
    let started!: (signal: AbortSignal) => void;
    const running = new Promise<AbortSignal>((resolve) => (started = resolve));
    const held = {
      run: (_agent: unknown, options: RunOptions) =>
        new Promise((_, reject) => {
          started(options.signal!);
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    app = Fastify({ logger: false });
    let closedResponse!: () => void;
    const closed = new Promise<void>((resolve) => (closedResponse = resolve));
    app.addHook('onRequest', async (_request, reply) => {
      reply.raw.on('close', () => closedResponse());
    });
    await app.register(cogitatorPlugin, {
      cogitator: held as unknown as CogitatorPluginOptions['cogitator'],
      agents: {
        assistant: { name: 'assistant', config: { tools: [] } },
      } as unknown as CogitatorPluginOptions['agents'],
      prefix: '/api',
      sseHeartbeatMs: 0,
      resumableStreams: { store, detachedTimeoutMs: 1 },
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new AbortController();
    const answer = fetch(`${address}/api/agents/assistant/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
      signal: client.signal,
    }).catch(() => undefined);

    await creating;
    client.abort();
    await closed;
    release();
    const signal = await running;
    await answer;

    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });
});
