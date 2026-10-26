import { describe, expect, it, vi } from 'vitest';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { RunOptions } from '@cogitator-ai/types';
import {
  InMemoryStreamReplayStore,
  conformanceRunResult,
  parseSseFrames,
  type NewStreamRecord,
  type StreamFrame,
  type StreamReplayStore,
} from '@cogitator-ai/server-shared';
import { createChatHandler } from '../handlers/chat.js';
import type { ChatHandlerOptions } from '../types.js';

const agent = { name: 'assistant', config: { tools: [] } } as unknown as Agent;
const BODY = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

/** A run that streams `Hel`, `lo`, waits for `release()`, then streams ` again` and ends */
function gatedRuntime() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signal: AbortSignal | undefined;
  let lastRun: RunOptions | undefined;
  const run = async (_agent: unknown, options: RunOptions) => {
    signal = options.signal;
    lastRun = options;
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
    cogitator: { run } as unknown as Cogitator,
    release,
    signal: () => signal,
    run: () => lastRun,
  };
}

const userOf = (req: Request | undefined) => req?.headers.get('x-user') ?? undefined;

function handlerOf(cogitator: Cogitator, options: ChatHandlerOptions = {}) {
  return createChatHandler(cogitator, agent, {
    sseHeartbeatMs: 0,
    resumableStreams: { owner: userOf },
    beforeRun: async (req) => {
      const user = userOf(req);
      return user ? { userId: user } : undefined;
    },
    ...options,
  });
}

/** Starts a stream and reads `count` events of it, then drops the connection */
async function readThenDrop(
  handler: (req: Request) => Promise<Response>,
  count: number,
  headers: Record<string, string> = {}
): Promise<StreamFrame[]> {
  const client = new AbortController();
  const res = await handler(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: BODY,
      signal: client.signal,
    })
  );
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
  handler: (req: Request) => Promise<Response>,
  lastEventId: string,
  headers: Record<string, string> = {}
) {
  const res = await handler(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Last-Event-ID': lastEventId, ...headers },
    })
  );
  return { status: res.status, body: await res.text() };
}

describe('resumable chat streams', () => {
  it('goes on with the run when the client drops, and replays the rest to its reconnect', async () => {
    const { cogitator, release, signal } = gatedRuntime();
    const handler = handlerOf(cogitator);

    const before = await readThenDrop(handler, 3);
    release();
    const rest = await reconnect(handler, before.at(-1)!.id!);

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

  it('lets only the user beforeRun named for the run reconnect to it', async () => {
    const { cogitator, release } = gatedRuntime();
    const handler = handlerOf(cogitator);
    const before = await readThenDrop(handler, 1, { 'x-user': 'alice' });
    release();
    const id = before[0]!.id!;

    const strangers: Array<Record<string, string>> = [{ 'x-user': 'mallory' }, {}];
    for (const headers of strangers) {
      const refused = await reconnect(handler, id, headers);
      expect(refused.status).toBe(404);
      expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'STREAM_NOT_FOUND' } });
    }
    expect((await reconnect(handler, id, { 'x-user': 'alice' })).status).toBe(200);
  });

  it('still stops the run when the signal beforeRun returned aborts', async () => {
    const { cogitator, signal } = gatedRuntime();
    const stop = new AbortController();
    const handler = handlerOf(cogitator, {
      beforeRun: async () => ({ signal: stop.signal }),
      resumableStreams: { owner: () => undefined },
    });

    const before = await readThenDrop(handler, 1);
    stop.abort();
    const rest = await reconnect(handler, before[0]!.id!);

    expect(signal()?.aborted).toBe(true);
    expect(parseSseFrames(rest.body).at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'STREAM_ABORTED',
    });
  });

  it('runs neither beforeRun nor deps for a reconnect or a cancel', async () => {
    const { cogitator, release } = gatedRuntime();
    const beforeRun = vi.fn(async (req: Request) => ({ userId: userOf(req) }));
    const deps = vi.fn(() => ({ tenant: 'acme' }));
    const handler = handlerOf(cogitator, { beforeRun, deps });
    const before = await readThenDrop(handler, 1, { 'x-user': 'alice' });
    release();
    await reconnect(handler, before[0]!.id!, { 'x-user': 'alice' });
    const streamId = before[0]!.id!.split(':')[0];
    await handler(
      new Request(`http://localhost/api/chat?streamId=${streamId}`, {
        method: 'DELETE',
        headers: { 'x-user': 'alice' },
      })
    );

    expect(beforeRun).toHaveBeenCalledTimes(1);
    expect(deps).toHaveBeenCalledTimes(1);
  });

  it('cancels a run on DELETE with ?streamId=, for its owner only', async () => {
    const { cogitator, signal } = gatedRuntime();
    const handler = handlerOf(cogitator);
    const before = await readThenDrop(handler, 1, { 'x-user': 'alice' });
    const streamId = before[0]!.id!.split(':')[0];
    const cancel = (user: string) =>
      handler(
        new Request(`http://localhost/api/chat?streamId=${streamId}`, {
          method: 'DELETE',
          headers: { 'x-user': user },
        })
      );

    expect((await cancel('mallory')).status).toBe(404);
    expect(signal()?.aborted).toBe(false);
    expect((await cancel('alice')).status).toBe(204);
    expect(signal()?.aborted).toBe(true);
  });

  it('refuses resumableStreams next to beforeRun without an owner', () => {
    const { cogitator } = gatedRuntime();
    expect(() =>
      createChatHandler(cogitator, agent, {
        resumableStreams: true,
        beforeRun: async () => ({ userId: 'alice' }),
      })
    ).toThrow(/owner/);
  });

  it('binds the stream to the thread beforeRun returned, which reconnects authorize', async () => {
    const { cogitator, release, run } = gatedRuntime();
    const asked: string[] = [];
    const handler = createChatHandler(cogitator, agent, {
      sseHeartbeatMs: 0,
      beforeRun: async () => ({ threadId: 'thread-from-hook' }),
      authorizeThread: (_req, threadId) => {
        asked.push(threadId);
        return true;
      },
      resumableStreams: { owner: () => undefined },
    });
    const res = await handler(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
          threadId: 'thread-asked',
        }),
      })
    );
    release();
    const frames = parseSseFrames(await res.text());
    await reconnect(handler, frames[0]!.id!);

    expect(frames[0]?.event).toMatchObject({ type: 'start', threadId: 'thread-from-hook' });
    expect(run()?.threadId).toBe('thread-from-hook');
    expect(asked).toEqual(['thread-from-hook', 'thread-from-hook']);
  });

  it('lets the stream go when the client cancels the body, so the run counts as detached', async () => {
    const { cogitator, signal } = gatedRuntime();
    const handler = handlerOf(cogitator, {
      resumableStreams: { owner: userOf, detachedTimeoutMs: 1 },
    });
    const res = await handler(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: BODY,
      })
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (parseSseFrames(text).length < 4) {
      text += decoder.decode((await reader.read()).value, { stream: true });
    }
    await reader.cancel();

    await vi.waitFor(() => expect(signal()?.aborted).toBe(true));
  });

  it('lets go of a stream whose client left while the store created it', async () => {
    const { cogitator, signal } = gatedRuntime();
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
    const handler = handlerOf(cogitator, {
      resumableStreams: { owner: userOf, store, detachedTimeoutMs: 1 },
    });
    const client = new AbortController();
    const answer = handler(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: BODY,
        signal: client.signal,
      })
    );

    await creating;
    client.abort();
    release();
    await answer;

    await vi.waitFor(() => expect(signal()?.aborted).toBe(true));
  });
});
