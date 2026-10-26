import { describe, expect, it, vi } from 'vitest';
import Koa from 'koa';
import type { AddressInfo } from 'node:net';
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
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';
import { serve } from './local-server';

/** A run that streams `Hel`, `lo`, waits for `release()`, then streams ` again` and ends */
function gatedRuntime() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signal: AbortSignal | undefined;
  const run = async (_agent: unknown, options: RunOptions) => {
    signal = options.signal;
    options.onToken?.('Hel');
    options.onToken?.('lo');
    await Promise.race([
      released,
      new Promise<never>((_, reject) =>
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      ),
    ]);
    options.onToken?.(' again');
    return { ...conformanceRunResult(options.threadId ?? 'thread'), reasoning: undefined };
  };
  return {
    runtime: { run } as unknown as CogitatorAppOptions['cogitator'],
    release,
    signal: () => signal,
  };
}

async function listen(
  runtime: CogitatorAppOptions['cogitator'],
  resumableStreams?: boolean | ResumableStreamOptions,
  app = new Koa<CogitatorState>()
): Promise<string> {
  const router = cogitatorApp({
    cogitator: runtime,
    agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    sseHeartbeatMs: 0,
    auth: (ctx) => {
      const user = ctx.get('x-user');
      return user ? { userId: user } : {};
    },
    ...(resumableStreams !== undefined && { resumableStreams }),
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  const server = await serve(app);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/bot/stream`;
}

/** Starts a stream and reads `count` events of it, then drops the connection */
async function readThenDrop(url: string, count: number, headers: Record<string, string> = {}) {
  const client = new AbortController();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ input: 'hi' }),
    signal: client.signal,
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
  client.abort();
  return frames.slice(0, count);
}

async function reconnect(url: string, lastEventId: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Last-Event-ID': lastEventId, ...headers },
  });
  return { status: res.status, body: await res.text() };
}

describe('resumable streams', () => {
  it('goes on with the run when the client drops, and replays the rest to its reconnect', async () => {
    const { runtime, release, signal } = gatedRuntime();
    const url = await listen(runtime, true);

    const before = await readThenDrop(url, 3);
    release();
    const rest = await reconnect(url, before.at(-1)!.id!);

    expect(signal()?.aborted).toBe(false);
    expect(rest.status).toBe(200);
    expect(parseSseFrames(rest.body).map((frame) => frame.event.type)).toEqual([
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(rest.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('stops the run on a disconnect where streams are not resumable', async () => {
    const { runtime, signal } = gatedRuntime();
    const url = await listen(runtime);

    const before = await readThenDrop(url, 3);

    await vi.waitFor(() => expect(signal()?.aborted).toBe(true));
    expect(before.every((frame) => frame.id === undefined)).toBe(true);
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
    expect((await reconnect(url, id, { 'x-user': 'alice' })).status).toBe(200);
  });

  it('lets go of a stream whose client left while the store created it', async () => {
    const { runtime, signal } = gatedRuntime();
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
    const app = new Koa<CogitatorState>();
    let closedResponse!: () => void;
    const closed = new Promise<void>((resolve) => (closedResponse = resolve));
    app.use(async (ctx, next) => {
      ctx.res.on('close', () => closedResponse());
      await next();
    });
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
    await answer;

    await vi.waitFor(() => expect(signal()?.aborted).toBe(true));
  });
});
