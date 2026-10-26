import { describe, expect, it } from 'vitest';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { RunOptions } from '@cogitator-ai/types';
import {
  conformanceRunResult,
  parseSseFrames,
  type StreamFrame,
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
  return { cogitator: { run } as unknown as Cogitator, release, signal: () => signal };
}

function handlerOf(cogitator: Cogitator, options: ChatHandlerOptions = {}) {
  return createChatHandler(cogitator, agent, {
    sseHeartbeatMs: 0,
    resumableStreams: true,
    beforeRun: async (req) => {
      const user = req.headers.get('x-user');
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
      headers: { 'Content-Type': 'application/json', 'Last-Event-ID': lastEventId, ...headers },
      body: BODY,
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
    const handler = handlerOf(cogitator, { beforeRun: async () => ({ signal: stop.signal }) });

    const before = await readThenDrop(handler, 1);
    stop.abort();
    const rest = await reconnect(handler, before[0]!.id!);

    expect(signal()?.aborted).toBe(true);
    expect(parseSseFrames(rest.body).at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'STREAM_ABORTED',
    });
  });
});
