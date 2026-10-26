import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { RunOptions } from '@cogitator-ai/types';
import {
  InMemoryStreamReplayStore,
  conformanceRunResult,
  parseSseFrames,
  type NewStreamRecord,
  type StreamReplayStore,
  type ResumableStreamOptions,
  type StreamFrame,
} from '@cogitator-ai/server-shared';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

type Cogitator = CogitatorServerConfig['cogitator'];
type Agents = NonNullable<CogitatorServerConfig['agents']>;

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

/** A run that streams `Hel`, `lo`, waits for `release()`, then streams ` again` and ends */
function gatedRuntime() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: (signal: AbortSignal) => void;
  const running = new Promise<AbortSignal>((resolve) => (started = resolve));
  const runtime = {
    run: async (_agent: unknown, options: RunOptions) => {
      const signal = options.signal!;
      started(signal);
      options.onToken?.('Hel');
      options.onToken?.('lo');
      await Promise.race([
        released,
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        ),
      ]);
      options.onToken?.(' again');
      return { ...conformanceRunResult(options.threadId ?? 'thread'), reasoning: undefined };
    },
  };
  return { runtime, release, running };
}

/** A store whose `create` waits for `release()`, telling when a request reached it */
function slowStore() {
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
  return { store, creating, release };
}

/** Resolves once a response of the app closed, before or after it ended */
function closedResponses(app: express.Express): Promise<void> {
  return new Promise((resolve) => {
    app.use((_req, res, next) => {
      res.on('close', () => resolve());
      next();
    });
  });
}

async function listen(
  runtime: unknown,
  resumableStreams?: boolean | ResumableStreamOptions,
  app = express()
): Promise<string> {
  const cogitatorServer = new CogitatorServer({
    app,
    cogitator: runtime as Cogitator,
    agents: { assistant: { name: 'assistant', config: { tools: [] } } } as unknown as Agents,
    config: {
      basePath: '/api',
      enableSwagger: false,
      sseHeartbeatMs: 0,
      auth: (req) => {
        const user = req.get('x-user');
        return user ? { userId: user } : {};
      },
      ...(resumableStreams !== undefined && { resumableStreams }),
    },
  });
  await cogitatorServer.init();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/assistant/stream`;
}

/** Starts a stream and reads `count` events of it, then drops the connection */
async function readThenDrop(url: string, count: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ input: 'hi' }),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let frames: StreamFrame[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    frames = parseSseFrames(text.slice(0, text.lastIndexOf('\n\n') + 2));
  }
  controller.abort();
  return frames.slice(0, count);
}

async function reconnect(url: string, lastEventId: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Last-Event-ID': lastEventId, ...headers },
  });
  return { status: res.status, body: await res.text() };
}

const events = (body: string) => parseSseFrames(body).map((frame) => frame.event.type);

describe('resumable streams', () => {
  it('goes on with the run when the client drops, and replays the rest to its reconnect', async () => {
    const { runtime, release, running } = gatedRuntime();
    const url = await listen(runtime, true);

    const before = await readThenDrop(url, 3);
    const signal = await running;
    release();

    const rest = await reconnect(url, before.at(-1)!.id!);
    expect(signal.aborted).toBe(false);
    expect(rest.status).toBe(200);
    expect(events(rest.body)).toEqual(['text-delta', 'text-delta', 'text-end', 'finish']);
    expect(parseSseFrames(rest.body)[0]?.id).toBe(before[0]!.id!.replace(/:1$/, ':4'));
    expect(rest.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('follows a run that is still going after the replay, reading no body', async () => {
    const { runtime, release } = gatedRuntime();
    const url = await listen(runtime, true);

    const before = await readThenDrop(url, 2);
    const reading = reconnect(url, before.at(-1)!.id!);
    setTimeout(release, 0);

    const rest = await reading;
    expect(events(rest.body)).toEqual([
      'text-delta',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('stops the run on a disconnect where streams are not resumable, and sends no ids', async () => {
    const { runtime, running } = gatedRuntime();
    const url = await listen(runtime);

    const before = await readThenDrop(url, 3);
    const signal = await running;
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    expect(signal.aborted).toBe(true);
    expect(before.every((frame) => frame.id === undefined)).toBe(true);
  });

  it('starts a new run for a Last-Event-ID where streams are not resumable', async () => {
    const { runtime, release } = gatedRuntime();
    const url = await listen(runtime);
    release();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Last-Event-ID': 'stream_x:1' },
      body: JSON.stringify({ input: 'hi' }),
    });
    expect(events(await res.text())).toContain('start');
  });

  it('lets only the user who started the stream reconnect to it', async () => {
    const { runtime, release } = gatedRuntime();
    const url = await listen(runtime, true);
    const before = await readThenDrop(url, 1, { 'x-user': 'alice' });
    release();
    const id = before[0]!.id!;

    const strangers: Array<Record<string, string>> = [{ 'x-user': 'mallory' }, {}];
    for (const headers of strangers) {
      const refused = await reconnect(url, id, headers);
      expect(refused.status).toBe(404);
      expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'STREAM_NOT_FOUND' } });
    }
    const allowed = await reconnect(url, id, { 'x-user': 'alice' });
    expect(allowed.status).toBe(200);
    expect(events(allowed.body).at(-1)).toBe('finish');
  });

  it('stops a run nobody follows after detachedTimeoutMs, and tells a late reconnect', async () => {
    const { runtime, running } = gatedRuntime();
    const url = await listen(runtime, { detachedTimeoutMs: 1 });

    const before = await readThenDrop(url, 1);
    const signal = await running;
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    const rest = await reconnect(url, before[0]!.id!);
    const last = parseSseFrames(rest.body).at(-1)?.event;
    expect(last).toMatchObject({ type: 'error', code: 'STREAM_ABORTED' });
  });

  it('stops the runs of resumable streams when until aborts, as a server that shuts down', async () => {
    const { runtime, running } = gatedRuntime();
    const shutdown = new AbortController();
    const url = await listen(runtime, { until: shutdown.signal });

    const before = await readThenDrop(url, 1);
    const signal = await running;
    shutdown.abort();

    expect(signal.aborted).toBe(true);
    const rest = await reconnect(url, before[0]!.id!);
    expect(parseSseFrames(rest.body).at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'STREAM_ABORTED',
    });
  });

  it('cancels a run on DELETE /agents/:name/stream/:streamId', async () => {
    const { runtime, running } = gatedRuntime();
    const url = await listen(runtime, true);
    const before = await readThenDrop(url, 1, { 'x-user': 'alice' });
    const signal = await running;
    const streamId = before[0]!.id!.split(':')[0];
    const cancel = (headers: Record<string, string>) =>
      fetch(`${url}/${streamId}`, { method: 'DELETE', headers });

    expect((await cancel({ 'x-user': 'mallory' })).status).toBe(404);
    expect(signal.aborted).toBe(false);
    expect((await cancel({ 'x-user': 'alice' })).status).toBe(204);
    expect(signal.aborted).toBe(true);
  });

  it('refuses a malformed Last-Event-ID with 400 before streaming', async () => {
    const url = await listen(gatedRuntime().runtime, true);
    const refused = await reconnect(url, 'garbage');
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('lets go of a stream whose client left while the store created it', async () => {
    const { runtime, running } = gatedRuntime();
    const { store, creating, release } = slowStore();
    const app = express();
    const closed = closedResponses(app);
    const url = await listen(runtime, { store, detachedTimeoutMs: 1 }, app);
    const client = new AbortController();
    const answer = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
