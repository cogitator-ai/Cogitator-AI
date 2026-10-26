import { describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { parseSseFrames, type StreamFrame } from '@cogitator-ai/server-shared';
import type { RunOptions } from '@cogitator-ai/types';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';
import { chatAgent, deferred, fakeCogitator, json, runResult } from './helpers.js';

const PATH = '/cogitator/agents/chat/stream';

function serveCogitator(deps: CogitatorDeps) {
  return serve(
    createApp({ routes: group('/cogitator', { children: [cogitatorController(deps)] }) })
  );
}

/** A run that streams `Hel`, `lo`, waits for `release`, then streams ` again` and ends */
function gatedRun() {
  const release = deferred<void>();
  const started = deferred<AbortSignal>();
  const run = async (_agent: unknown, options: RunOptions) => {
    started.resolve(options.signal!);
    options.onToken?.('Hel');
    options.onToken?.('lo');
    await Promise.race([
      release.promise,
      new Promise<never>((_, reject) =>
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        })
      ),
    ]);
    options.onToken?.(' again');
    return runResult({ output: 'Hello again', threadId: options.threadId });
  };
  return { run, release: () => release.resolve(), started: started.promise };
}

/** Starts a stream and reads `count` events of it, then drops the connection */
async function readThenDrop(
  request: ReturnType<typeof serveCogitator>,
  count: number,
  headers: Record<string, string> = {}
): Promise<StreamFrame[]> {
  const client = new AbortController();
  const init = json({ input: 'hi' });
  const res = await request(PATH, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...headers },
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
  await reader.cancel().catch(() => undefined);
  return frames.slice(0, count);
}

async function reconnect(
  request: ReturnType<typeof serveCogitator>,
  lastEventId: string,
  headers: Record<string, string> = {}
) {
  const res = await request(PATH, {
    method: 'POST',
    headers: { 'last-event-id': lastEventId, ...headers },
  });
  return { status: res.status, body: await res.text() };
}

const auth: CogitatorDeps['auth'] = (ctx) => {
  const user = ctx.req.headers.get('x-user');
  return user ? { userId: user } : {};
};

describe('resumable streams', () => {
  test('goes on with the run when the client drops, and replays the rest to its reconnect', async () => {
    const { run, release, started } = gatedRun();
    const { cogitator } = fakeCogitator(run);
    const request = serveCogitator({
      cogitator,
      agents: { chat: chatAgent() },
      sseHeartbeatMs: 0,
      resumableStreams: true,
    });

    const before = await readThenDrop(request, 3);
    const signal = await started;
    release();
    const rest = await reconnect(request, before.at(-1)!.id!);

    expect(signal.aborted).toBe(false);
    expect(rest.status).toBe(200);
    expect(parseSseFrames(rest.body).map((frame) => frame.event.type)).toEqual([
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(rest.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('lets only the user who started the stream reconnect to it', async () => {
    const { run, release } = gatedRun();
    const { cogitator } = fakeCogitator(run);
    const request = serveCogitator({
      cogitator,
      agents: { chat: chatAgent() },
      auth,
      sseHeartbeatMs: 0,
      resumableStreams: true,
    });
    const before = await readThenDrop(request, 1, { 'x-user': 'alice' });
    release();
    const id = before[0]!.id!;

    const strangers: Array<Record<string, string>> = [{ 'x-user': 'mallory' }, {}];
    for (const headers of strangers) {
      const refused = await reconnect(request, id, headers);
      expect(refused.status).toBe(404);
      expect(JSON.parse(refused.body)).toMatchObject({ error: 'STREAM_NOT_FOUND' });
    }
    expect((await reconnect(request, id, { 'x-user': 'alice' })).status).toBe(200);
  });

  test('stops every run when the server shuts down', async () => {
    const { run, started } = gatedRun();
    const { cogitator } = fakeCogitator(run);
    const shutdown = new AbortController();
    const request = serveCogitator({
      cogitator,
      agents: { chat: chatAgent() },
      sseHeartbeatMs: 0,
      until: shutdown.signal,
      resumableStreams: true,
    });

    await readThenDrop(request, 1);
    const signal = await started;
    shutdown.abort();

    expect(signal.aborted).toBe(true);
  });
});
