import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './helpers/fake-react.js';
import type { StreamEvent } from '../streaming/protocol.js';
import type { UseChatOptions } from '../types.js';

vi.mock('react', async () => (await import('./helpers/fake-react.js')).reactApi);

const { useCogitatorChat } = await import('../client/use-chat.js');

const encoder = new TextEncoder();

interface Call {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  /** Sends an event, with `id` when given */
  push: (event: StreamEvent, id?: string) => void;
  /** Ends the body */
  close: () => void;
  /** Breaks the connection */
  drop: () => void;
}

type Respond = (call: Call, index: number) => Response | Promise<Response> | undefined;

function installFetch(respond: Respond) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    init.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {}
    });
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: String(init.body),
      headers: init.headers as Record<string, string>,
      push: (event, id) =>
        controller.enqueue(
          encoder.encode(
            `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`
          )
        ),
      close: () => controller.close(),
      drop: () => controller.error(new TypeError('network error')),
    };
    calls.push(call);
    const custom = await respond(call, calls.length - 1);
    return custom ?? new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const id = (seq: number) => `stream_abc:${seq}`;

/** The first half of an answer: `start`, a text part with `Hel`, ids 1 to 3 */
function firstHalf(call: Call) {
  call.push({ type: 'start', messageId: 'a1', threadId: 'thread_1' }, id(1));
  call.push({ type: 'text-start', id: 't1' }, id(2));
  call.push({ type: 'text-delta', id: 't1', delta: 'Hel' }, id(3));
}

/** The rest of it: `lo`, the end of the part and `finish`, ids 4 to 6 */
function secondHalf(call: Call) {
  call.push({ type: 'text-delta', id: 't1', delta: 'lo' }, id(4));
  call.push({ type: 'text-end', id: 't1' }, id(5));
  call.push({ type: 'finish', messageId: 'a1', threadId: 'thread_1' }, id(6));
  call.close();
}

function setup(options: Partial<UseChatOptions> = {}) {
  return renderHook(() =>
    useCogitatorChat({ api: '/api/chat', reconnect: { delayMs: 0 }, ...options })
  );
}

function errorAnswer(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useCogitatorChat reconnect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resumes a stream whose body ended before finish, continuing the message in place', async () => {
    const calls = installFetch((call, index) => {
      if (index === 0) {
        firstHalf(call);
        call.close();
      } else {
        secondHalf(call);
      }
      return undefined;
    });
    const onFinish = vi.fn();
    const hook = setup({ onFinish });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Last-Event-ID']).toBe(id(3));
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', content: 'Hello' }));
    expect(hook.result.current.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello'],
    ]);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('resumes a stream whose connection broke', async () => {
    const calls = installFetch((call, index) => {
      if (index === 0) {
        firstHalf(call);
        setTimeout(() => call.drop(), 0);
      } else {
        secondHalf(call);
      }
      return undefined;
    });
    const hook = setup();

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(2);
    expect(hook.result.current.messages.at(-1)?.content).toBe('Hello');
    expect(hook.result.current.error).toBeNull();
  });

  it('keeps reconnecting while each reconnect brings events', async () => {
    const calls = installFetch((call, index) => {
      if (index === 0) firstHalf(call);
      else if (index === 1) call.push({ type: 'text-delta', id: 't1', delta: 'l' }, id(4));
      else if (index === 2) call.push({ type: 'text-delta', id: 't1', delta: 'o' }, id(5));
      else if (index === 3) call.push({ type: 'text-delta', id: 't1', delta: '!' }, id(6));
      if (index < 4) {
        call.close();
      } else {
        call.push({ type: 'text-end', id: 't1' }, id(7));
        call.push({ type: 'finish', messageId: 'a1' }, id(8));
        call.close();
      }
      return undefined;
    });
    const hook = setup({ reconnect: { attempts: 1, delayMs: 0 } });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls.map((call) => call.headers['Last-Event-ID'])).toEqual([
      undefined,
      id(3),
      id(4),
      id(5),
      id(6),
    ]);
    expect(hook.result.current.messages.at(-1)?.content).toBe('Hello!');
  });

  it('ends a stream without ids as before, without reconnecting', async () => {
    const calls = installFetch((call) => {
      call.push({ type: 'start', messageId: 'a1' });
      call.push({ type: 'text-delta', id: 't1', delta: 'Hel' });
      call.close();
      return undefined;
    });
    const onFinish = vi.fn();
    const hook = setup({ onFinish });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(1);
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hel' }));
  });

  it('does not reconnect when turned off', async () => {
    const calls = installFetch((call) => {
      firstHalf(call);
      call.close();
      return undefined;
    });
    const hook = setup({ reconnect: false });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(1);
    expect(hook.result.current.messages.at(-1)?.content).toBe('Hel');
  });

  it('does not reconnect a stream the user stopped', async () => {
    const calls = installFetch((call) => {
      firstHalf(call);
      return undefined;
    });
    const hook = setup();

    const pending = hook.result.current.send('Hi');
    await vi.waitFor(() => expect(hook.result.current.messages.at(-1)?.content).toBe('Hel'));
    hook.result.current.stop();
    await pending;
    await hook.flush();

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', '/api/chat'],
      ['DELETE', '/api/chat?streamId=stream_abc'],
    ]);
    expect(hook.result.current.error).toBeNull();
  });

  it('cancels the run of the stream it leaves on reload, then starts the new one', async () => {
    const calls = installFetch((call, index) => {
      if (index === 0) firstHalf(call);
      if (index === 2) {
        firstHalf(call);
        secondHalf(call);
      }
      return undefined;
    });
    const hook = setup();

    const pending = hook.result.current.send('Hi');
    await vi.waitFor(() => expect(hook.result.current.messages.at(-1)?.content).toBe('Hel'));
    await hook.result.current.reload();
    await pending;
    await hook.flush();

    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE', 'POST']);
    expect(hook.result.current.messages.at(-1)?.content).toBe('Hello');
  });

  it('cancels no run of a stream without ids', async () => {
    const calls = installFetch((call) => {
      call.push({ type: 'start', messageId: 'a1' });
      return undefined;
    });
    const hook = setup();

    const pending = hook.result.current.send('Hi');
    await vi.waitFor(() => expect(hook.result.current.isLoading).toBe(true));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    hook.result.current.stop();
    await pending;

    expect(calls).toHaveLength(1);
  });

  it('ends with an error, not a finished message, when every reconnect ends before finish', async () => {
    const calls = installFetch((call, index) => {
      if (index === 0) firstHalf(call);
      call.close();
      return undefined;
    });
    const onError = vi.fn();
    const onFinish = vi.fn();
    const hook = setup({ onError, onFinish, reconnect: { attempts: 2, delayMs: 0 } });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(3);
    expect(onFinish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The stream ended before the run finished' })
    );
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('stops and shows the error when the server no longer keeps the stream', async () => {
    const calls = installFetch((call, index) => {
      if (index > 0) return errorAnswer(404, 'STREAM_NOT_FOUND', 'No stream has this event id');
      firstHalf(call);
      call.close();
      return undefined;
    });
    const onError = vi.fn();
    const hook = setup({ onError });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error?.message).toContain('No stream has this event id');
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('stops at STREAM_RESUME_GAP and shows the error', async () => {
    const calls = installFetch((call, index) => {
      if (index === 0) firstHalf(call);
      else
        call.push({
          type: 'error',
          message: 'The events after this id are no longer kept',
          code: 'STREAM_RESUME_GAP',
        });
      call.close();
      return undefined;
    });
    const onError = vi.fn();
    const hook = setup({ onError });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The events after this id are no longer kept' })
    );
  });

  it('gives up after the reconnect attempts fail, with the last error', async () => {
    const calls = installFetch((call, index) => {
      if (index > 0) throw new TypeError('Failed to fetch');
      firstHalf(call);
      call.close();
      return undefined;
    });
    const onError = vi.fn();
    const hook = setup({ onError, reconnect: { attempts: 2, delayMs: 0 } });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(3);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Failed to fetch' }));
    expect(hook.result.current.isLoading).toBe(false);
  });
});
