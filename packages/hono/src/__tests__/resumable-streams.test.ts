import { describe, expect, it, vi } from 'vitest';
import type { RunOptions } from '@cogitator-ai/types';
import {
  conformanceRunResult,
  parseSseFrames,
  type ResumableStreamOptions,
  type StreamFrame,
} from '@cogitator-ai/server-shared';
import { cogitatorApp, type CogitatorAppOptions } from '../index';

const URL = 'http://localhost/agents/bot/stream';

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

function appOf(
  runtime: CogitatorAppOptions['cogitator'],
  resumableStreams?: boolean | ResumableStreamOptions
) {
  return cogitatorApp({
    cogitator: runtime,
    agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    sseHeartbeatMs: 0,
    auth: (c) => {
      const user = c.req.header('x-user');
      return user ? { userId: user } : {};
    },
    ...(resumableStreams !== undefined && { resumableStreams }),
  });
}

/** Starts a stream and reads `count` events of it, then drops the connection */
async function readThenDrop(
  app: ReturnType<typeof appOf>,
  count: number,
  headers: Record<string, string> = {}
): Promise<StreamFrame[]> {
  const client = new AbortController();
  const res = await app.fetch(
    new Request(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ input: 'hi' }),
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
  app: ReturnType<typeof appOf>,
  lastEventId: string,
  headers: Record<string, string> = {}
) {
  const res = await app.fetch(
    new Request(URL, { method: 'POST', headers: { 'Last-Event-ID': lastEventId, ...headers } })
  );
  return { status: res.status, body: await res.text() };
}

describe('resumable streams', () => {
  it('goes on with the run when the client drops, and replays the rest to its reconnect', async () => {
    const { runtime, release, signal } = gatedRuntime();
    const app = appOf(runtime, true);

    const before = await readThenDrop(app, 3);
    release();
    const rest = await reconnect(app, before.at(-1)!.id!);

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
    const app = appOf(runtime);

    const before = await readThenDrop(app, 3);

    await vi.waitFor(() => expect(signal()?.aborted).toBe(true));
    expect(before.every((frame) => frame.id === undefined)).toBe(true);
  });

  it('lets only the user who started the stream reconnect to it', async () => {
    const { runtime, release } = gatedRuntime();
    const app = appOf(runtime, true);
    const before = await readThenDrop(app, 1, { 'x-user': 'alice' });
    release();
    const id = before[0]!.id!;

    const strangers: Array<Record<string, string>> = [{ 'x-user': 'mallory' }, {}];
    for (const headers of strangers) {
      const refused = await reconnect(app, id, headers);
      expect(refused.status).toBe(404);
      expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'STREAM_NOT_FOUND' } });
    }
    expect((await reconnect(app, id, { 'x-user': 'alice' })).status).toBe(200);
  });
});
