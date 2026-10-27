import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '@cogitator-ai/types';
import {
  AgentStreamSession,
  InMemoryStreamReplayStore,
  ResumableStreams,
  STREAM_ABORTED,
  STREAM_CANCELLED,
  STREAM_LIMIT_REACHED,
  STREAM_NOT_FOUND,
  STREAM_RESUME_GAP,
  conformanceRunResult,
  createTextDeltaEvent,
  formatStreamEventId,
  lastEventIdOf,
  parseStreamEventId,
  type StreamFollower,
  type StreamFrame,
  type StoredStreamEvent,
  type StreamSubscriber,
  type StreamOpening,
  type StreamReplayStore,
} from '../index';

const describeError = (error: unknown) => ({
  message: error instanceof Error ? error.message : 'failed',
  code: 'TEST_FAILURE',
});

/** A run the test drives through the callbacks of its stream session */
function controlledRun() {
  let session: AgentStreamSession | undefined;
  let signal: AbortSignal | undefined;
  let settle: { finish: (result: RunResult) => void; fail: (error: unknown) => void } | undefined;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  return {
    running,
    execute: (runSession: AgentStreamSession, runSignal: AbortSignal) => {
      session = runSession;
      signal = runSignal;
      started();
      return new Promise<RunResult>((finish, fail) => {
        settle = { finish, fail };
        runSignal.addEventListener(
          'abort',
          () => fail(runSignal.reason instanceof Error ? runSignal.reason : new Error('aborted')),
          { once: true }
        );
      });
    },
    get callbacks() {
      if (!session) throw new Error('The run has not started');
      return session.callbacks;
    },
    get signal() {
      if (!signal) throw new Error('The run has not started');
      return signal;
    },
    finish() {
      settle?.finish({
        ...conformanceRunResult(session?.threadId ?? 'thread'),
        reasoning: undefined,
      });
    },
    fail(error: unknown) {
      settle?.fail(error);
    },
  };
}

/** Text, a tool call and its result, more text: events 2 to 11 after `start` */
function streamParts(run: ReturnType<typeof controlledRun>): void {
  run.callbacks.onToken('Hel');
  run.callbacks.onToken('lo');
  run.callbacks.onToolCall({ id: 'call_1', name: 'lookup', arguments: { query: 'order 42' } });
  run.callbacks.onToolResult({ callId: 'call_1', name: 'lookup', result: { found: true } });
  run.callbacks.onToken(' again');
}

/** Reads every frame of a follower until its stream ends */
async function readAll(follower: StreamFollower, signal = new AbortController().signal) {
  const frames: StreamFrame[] = [];
  for await (const frame of follower.frames(signal)) frames.push(frame);
  return frames;
}

/** Reads `count` frames, then leaves as a client that drops its connection */
async function readThenLeave(follower: StreamFollower, count: number) {
  const controller = new AbortController();
  const frames: StreamFrame[] = [];
  for await (const frame of follower.frames(controller.signal)) {
    frames.push(frame);
    if (frames.length === count) {
      controller.abort();
      break;
    }
  }
  return frames;
}

interface Auth {
  userId?: string;
  tenant?: string;
}

function opened<T>(opening: StreamOpening<T>): T {
  if (!opening.ok) throw new Error(`Refused: ${opening.error.code}`);
  return opening.stream;
}

async function startRun(hub: ResumableStreams<Auth>, auth?: Auth) {
  const run = controlledRun();
  const first = opened(await hub.startAgentRun({ auth, execute: run.execute, describeError }));
  await run.running;
  return { run, first };
}

async function reconnect(hub: ResumableStreams<Auth>, id: string | undefined, auth?: Auth) {
  return opened(await hub.reconnect(id ?? '', { auth }));
}

const seqOf = (frame: StreamFrame) => parseStreamEventId(frame.id ?? '')?.seq;

describe('stream event ids', () => {
  it('reads back what it formats', () => {
    expect(parseStreamEventId(formatStreamEventId('stream_abc-1', 42))).toEqual({
      streamId: 'stream_abc-1',
      seq: 42,
    });
  });

  it.each(['', 'stream_a', 'stream_a:', ':3', 'stream_a:-1', 'stream_a:1.5', 'a b:1', 'x:1e3'])(
    'refuses %j',
    (id) => {
      expect(parseStreamEventId(id)).toBeUndefined();
    }
  );

  it('takes the header before the query parameter, and an empty value as none', () => {
    expect(lastEventIdOf('stream_a:1', 'stream_b:2')).toBe('stream_a:1');
    expect(lastEventIdOf('', 'stream_b:2')).toBe('stream_b:2');
    expect(lastEventIdOf(undefined, undefined)).toBeUndefined();
    expect(lastEventIdOf(null, '  ')).toBeUndefined();
    expect(lastEventIdOf(undefined, ['stream_a:1', 'stream_b:2'])).toBe('stream_a:1,stream_b:2');
  });
});

describe('InMemoryStreamReplayStore', () => {
  const record = (id: string, createdAt = 0) => ({ id, threadId: 't', createdAt });
  const entry = (seq: number) => ({ seq, event: createTextDeltaEvent('txt', String(seq)) });

  async function filled(store: InMemoryStreamReplayStore, id: string, events: number) {
    await store.create(record(id));
    for (let seq = 1; seq <= events; seq++) await store.append(id, entry(seq));
  }

  it('reads the events after a sequence number, and whether the stream finished', async () => {
    const store = new InMemoryStreamReplayStore();
    await filled(store, 's', 3);

    const replay = await store.read('s', 1);
    expect(replay).toEqual({ events: [entry(2), entry(3)], gap: false, finished: false });

    await store.finish('s');
    expect((await store.read('s', 3))?.finished).toBe(true);
    expect(await store.read('unknown', 0)).toBeUndefined();
  });

  it('keeps the newest maxEvents events and reports a gap behind them', async () => {
    const store = new InMemoryStreamReplayStore({ maxEvents: 3 });
    await filled(store, 's', 5);

    expect(await store.read('s', 2)).toEqual({
      events: [entry(3), entry(4), entry(5)],
      gap: false,
      finished: false,
    });
    expect((await store.read('s', 1))?.gap).toBe(true);
    expect((await store.read('s', 0))?.gap).toBe(true);
  });

  it('refuses an event that does not follow the last one', async () => {
    const store = new InMemoryStreamReplayStore();
    await filled(store, 's', 2);
    await expect(store.append('s', entry(2))).rejects.toThrow(RangeError);
    await expect(store.append('s', entry(4))).rejects.toThrow(RangeError);
  });

  it('drops a finished stream once retentionMs passed, ending its subscriptions', async () => {
    let now = 1_000;
    const store = new InMemoryStreamReplayStore({ retentionMs: 100, now: () => now });
    await filled(store, 's', 1);
    await store.finish('s');
    const end = vi.fn();
    await store.subscribe('s', { event: () => undefined, end });

    now = 1_099;
    expect(await store.get('s')).toMatchObject({ finishedAt: 1_000, lastSeq: 1 });
    now = 1_100;
    expect(await store.get('s')).toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('keeps a stream whose run goes on for as long as it takes', async () => {
    let now = 0;
    const store = new InMemoryStreamReplayStore({ retentionMs: 100, now: () => now });
    await filled(store, 's', 1);
    now = 10_000_000;
    expect(await store.get('s')).toBeDefined();
  });

  it('makes room for a new stream by dropping the one that finished first', async () => {
    const store = new InMemoryStreamReplayStore({ maxStreams: 2 });
    await filled(store, 'a', 1);
    await filled(store, 'b', 1);
    await store.finish('b');
    await store.create(record('c'));

    expect(await store.get('a')).toBeDefined();
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('c')).toBeDefined();
  });

  it('never evicts a stream that goes on, refusing a new one instead', async () => {
    const store = new InMemoryStreamReplayStore({ maxStreams: 2 });
    await filled(store, 'a', 1);
    await filled(store, 'b', 1);
    const end = vi.fn();
    await store.subscribe('a', { event: () => undefined, end });

    expect(await store.create(record('c'))).toBe(false);
    expect(await store.get('a')).toBeDefined();
    expect(end).not.toHaveBeenCalled();

    await store.finish('a');
    expect(await store.create(record('c'))).toBe(true);
    expect(await store.get('a')).toBeUndefined();
  });

  it('tells the listeners of a stream about a cancel, also one asked before they listened', async () => {
    const store = new InMemoryStreamReplayStore();
    await filled(store, 's', 1);
    const early = vi.fn();
    await store.onCancel('s', early);
    await store.cancel('s');
    const late = vi.fn();
    await store.onCancel('s', late);

    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(await store.onCancel('unknown', vi.fn())).toBeUndefined();
  });

  it('counts the subscriptions of a stream and hands them every new event', async () => {
    const store = new InMemoryStreamReplayStore();
    await filled(store, 's', 1);
    const seen: number[] = [];
    const leave = await store.subscribe('s', { event: (e) => seen.push(e.seq), end: () => {} });
    expect((await store.get('s'))?.subscribers).toBe(1);

    await store.append('s', entry(2));
    await leave?.();
    await store.append('s', entry(3));

    expect(seen).toEqual([2]);
    expect((await store.get('s'))?.subscribers).toBe(0);
    expect(await store.subscribe('unknown', { event: () => {}, end: () => {} })).toBeUndefined();
  });

  it('refuses limits that are not positive whole numbers', () => {
    expect(() => new InMemoryStreamReplayStore({ maxEvents: 0 })).toThrow(RangeError);
    expect(() => new InMemoryStreamReplayStore({ retentionMs: 1.5 })).toThrow(RangeError);
    expect(() => new InMemoryStreamReplayStore({ maxStreams: -1 })).toThrow(RangeError);
  });
});

describe('ResumableStreams', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off unless asked for', () => {
    expect(ResumableStreams.from(undefined)).toBeUndefined();
    expect(ResumableStreams.from(false)).toBeUndefined();
    expect(ResumableStreams.from(true)).toBeInstanceOf(ResumableStreams);
    expect(ResumableStreams.from({ maxEvents: 10 })).toBeInstanceOf(ResumableStreams);
  });

  it('refuses the in-memory limits next to a store of its own, and bad timeouts', () => {
    const store = new InMemoryStreamReplayStore();
    expect(() => new ResumableStreams({ store, maxStreams: 10 })).toThrow(/your own store/);
    expect(() => new ResumableStreams({ store, retentionMs: 10 })).toThrow(/your own store/);
    expect(() => new ResumableStreams({ detachedTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new ResumableStreams({ detachedTimeoutMs: 3e9 })).toThrow(RangeError);
  });

  it('gives every event an id of its stream, from 1 up, ending with finish', async () => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    streamParts(run);
    run.finish();

    const frames = await readAll(first);
    expect(first.streamId).toMatch(/^stream_[0-9a-f-]{36}$/);
    expect(frames.map((frame) => frame.id)).toEqual(
      frames.map((_, at) => formatStreamEventId(first.streamId, at + 1))
    );
    expect(frames.map((frame) => frame.event.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('opens each stream under an id of its own', async () => {
    const hub = new ResumableStreams();
    const a = await startRun(hub);
    const b = await startRun(hub);
    expect(a.first.streamId).not.toBe(b.first.streamId);
    a.run.finish();
    b.run.finish();
  });

  it.each([
    ['after start', 1],
    ['in the middle of a text part', 3],
    ['after a tool result', 9],
    ['at the last event before the run ended', 11],
  ])('goes on without the client and replays the rest to a reconnect %s', async (_point, seen) => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    streamParts(run);
    const before = await readThenLeave(first, seen);

    expect(run.signal.aborted).toBe(false);
    run.finish();

    const rest = await readAll(await reconnect(hub, before.at(-1)?.id));
    expect([...before, ...rest].map(seqOf)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(rest.at(-1)?.event.type).toBe('finish');
  });

  it('replays nothing to a reconnect after finish', async () => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    run.finish();
    const frames = await readAll(first);

    expect(await readAll(await reconnect(hub, frames.at(-1)?.id))).toEqual([]);
  });

  it('follows a live run after the replay, without losing or repeating an event', async () => {
    const memory = new InMemoryStreamReplayStore();
    let duringRead: (() => void) | undefined;
    const store: StreamReplayStore = {
      create: (stream) => memory.create(stream),
      append: (id, entry) => memory.append(id, entry),
      finish: (id) => memory.finish(id),
      get: (id) => memory.get(id),
      subscribe: (id, subscriber) => memory.subscribe(id, subscriber),
      cancel: (id) => memory.cancel(id),
      onCancel: (id, listener) => memory.onCancel(id, listener),
      read: async (id, afterSeq) => {
        const replay = await memory.read(id, afterSeq);
        duringRead?.();
        duringRead = undefined;
        await Promise.resolve();
        return replay;
      },
    };
    const hub = new ResumableStreams({ store });
    const { run, first } = await startRun(hub);
    run.callbacks.onToken('a');
    const before = await readThenLeave(first, 2);

    duringRead = () => {
      run.callbacks.onToken('b');
      run.callbacks.onToken('c');
    };
    const follower = await reconnect(hub, before.at(-1)?.id);
    const reading = readAll(follower);
    await vi.waitFor(() => expect(duringRead).toBeUndefined());
    run.callbacks.onToken('d');
    run.finish();

    const rest = await reading;
    expect([...before, ...rest].map(seqOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rest.map((frame) => frame.event.type)).toEqual([
      'text-delta',
      'text-delta',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('serves several clients of one stream at once', async () => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    run.callbacks.onToken('a');
    const second = await reconnect(hub, formatStreamEventId(first.streamId, 1));
    const reading = Promise.all([readAll(first), readAll(second)]);
    run.callbacks.onToken('b');
    run.finish();

    const [all, rest] = await reading;
    expect(all.map(seqOf)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rest).toEqual(all.slice(1));
  });

  it('ends a reconnect behind the kept events with STREAM_RESUME_GAP', async () => {
    const hub = new ResumableStreams({ maxEvents: 2 });
    const { run, first } = await startRun(hub);
    streamParts(run);
    run.finish();
    await readAll(first);

    const frames = await readAll(await reconnect(hub, formatStreamEventId(first.streamId, 1)));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBeUndefined();
    expect(frames[0]?.event).toMatchObject({ type: 'error', code: STREAM_RESUME_GAP });
    expect(frames[0]?.event.type === 'error' && frames[0].event.message).toContain(
      `GET /threads/${first.threadId}`
    );
  });

  it('lets only the caller who started the stream reconnect', async () => {
    const hub = new ResumableStreams<Auth>();
    const { run, first } = await startRun(hub, { userId: 'alice' });
    run.finish();
    const id = formatStreamEventId(first.streamId, 1);

    for (const auth of [{ userId: 'mallory' }, undefined, { userId: 'alice', tenant: 'b' }]) {
      const refused = await hub.reconnect(id, { auth });
      expect(refused).toMatchObject({ ok: false, error: { status: 404, code: STREAM_NOT_FOUND } });
    }
    expect((await hub.reconnect(id, { auth: { userId: 'alice' } })).ok).toBe(true);
  });

  it('tells apart callers without a user id by the rest of their identity', async () => {
    const hub = new ResumableStreams<Auth>();
    const { run, first } = await startRun(hub, { tenant: 'acme' });
    run.finish();
    const id = formatStreamEventId(first.streamId, 1);

    expect((await hub.reconnect(id, { auth: { tenant: 'globex' } })).ok).toBe(false);
    expect((await hub.reconnect(id, {})).ok).toBe(false);
    expect((await hub.reconnect(id, { auth: { tenant: 'acme' } })).ok).toBe(true);
  });

  it('binds a stream to the key owner gives', async () => {
    const hub = new ResumableStreams<Auth>({ owner: (auth) => auth?.userId });
    const { run, first } = await startRun(hub, { userId: 'alice', tenant: 'a' });
    run.finish();
    const id = formatStreamEventId(first.streamId, 1);

    expect((await hub.reconnect(id, { auth: { userId: 'alice', tenant: 'b' } })).ok).toBe(true);
    expect((await hub.reconnect(id, { auth: { userId: 'bob', tenant: 'a' } })).ok).toBe(false);
  });

  it('lets no user reconnect to an anonymous stream', async () => {
    const hub = new ResumableStreams<Auth>();
    const { run, first } = await startRun(hub);
    run.finish();
    const id = formatStreamEventId(first.streamId, 1);

    expect((await hub.reconnect(id, { auth: { userId: 'alice' } })).ok).toBe(false);
    expect((await hub.reconnect(id, { auth: {} })).ok).toBe(true);
    expect((await hub.reconnect(id)).ok).toBe(true);
  });

  it('asks authorizeThread about the stream thread before a reconnect or a cancel', async () => {
    const hub = new ResumableStreams<Auth>();
    const { run, first } = await startRun(hub);
    const id = formatStreamEventId(first.streamId, 1);
    const asked: string[] = [];
    const authorizeThread = (threadId: string) => {
      asked.push(threadId);
      return { status: 403, code: 'THREAD_FORBIDDEN', message: 'no' };
    };

    expect(await hub.reconnect(id, { authorizeThread })).toMatchObject({
      ok: false,
      error: { status: 403, code: 'THREAD_FORBIDDEN' },
    });
    expect(await hub.cancel(first.streamId, { authorizeThread })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(asked).toEqual([first.threadId, first.threadId]);
    expect(run.signal.aborted).toBe(false);
    run.finish();
  });

  it('refuses ids that name no event of a stream it keeps', async () => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    run.finish();
    await readAll(first);

    expect(await hub.reconnect('garbage')).toMatchObject({
      ok: false,
      error: { status: 400, code: 'INVALID_INPUT' },
    });
    for (const id of [
      'stream_00000000-0000-4000-8000-000000000000:1',
      formatStreamEventId(first.streamId, 99),
    ]) {
      expect(await hub.reconnect(id)).toMatchObject({
        ok: false,
        error: { status: 404, code: STREAM_NOT_FOUND },
      });
    }
  });

  it('fails the stream with what describeError says of the run error', async () => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    run.callbacks.onToken('a');
    run.fail(new Error('provider down'));

    const frames = await readAll(first);
    expect(frames.map((frame) => frame.event.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'error',
    ]);
    expect(frames.at(-1)?.event).toMatchObject({ message: 'provider down', code: 'TEST_FAILURE' });
  });

  it('stops a run nobody followed for detachedTimeoutMs, and says so to a late reconnect', async () => {
    vi.useFakeTimers();
    const hub = new ResumableStreams({ detachedTimeoutMs: 60_000 });
    const { run, first } = await startRun(hub);
    run.callbacks.onToken('a');
    const before = await readThenLeave(first, 2);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(run.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.signal.aborted).toBe(true);

    const rest = await readAll(await reconnect(hub, before.at(-1)?.id));
    expect(rest.at(-1)?.event).toMatchObject({ type: 'error', code: STREAM_ABORTED });
    expect(rest.at(-1)?.event.type === 'error' && rest.at(-1)?.event).toMatchObject({
      message: expect.stringContaining('60000 ms'),
    });
  });

  it('keeps a run going while a client follows it, and counts from when the last one left', async () => {
    vi.useFakeTimers();
    const hub = new ResumableStreams({ detachedTimeoutMs: 1_000 });
    const { run, first } = await startRun(hub);
    const before = await readThenLeave(first, 1);
    await vi.advanceTimersByTimeAsync(900);

    const controller = new AbortController();
    const follower = await reconnect(hub, before.at(-1)?.id);
    const reading = (async () => {
      for await (const frame of follower.frames(controller.signal)) void frame;
    })();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.signal.aborted).toBe(false);

    controller.abort();
    await reading;
    await vi.advanceTimersByTimeAsync(999);
    expect(run.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.signal.aborted).toBe(true);
  });

  it('keeps a run going while a client follows it on another process', async () => {
    vi.useFakeTimers();
    const memory = new InMemoryStreamReplayStore();
    const shared: StreamReplayStore = Object.assign(Object.create(memory) as StreamReplayStore, {
      get: async (id: string) => {
        const record = await memory.get(id);
        return record && { ...record, subscribers: record.subscribers + 1 };
      },
    });
    const hub = new ResumableStreams({ store: shared, detachedTimeoutMs: 1_000 });
    const { run, first } = await startRun(hub);
    await readThenLeave(first, 1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.signal.aborted).toBe(false);
    run.finish();
  });

  it('stops the run when the signal it was started with aborts', async () => {
    const hub = new ResumableStreams();
    const shutdown = new AbortController();
    const run = controlledRun();
    const first = opened(
      await hub.startAgentRun({ execute: run.execute, describeError, signal: shutdown.signal })
    );
    await run.running;
    shutdown.abort();

    const frames = await readAll(first);
    expect(frames.at(-1)?.event).toMatchObject({
      type: 'error',
      code: STREAM_ABORTED,
      message: 'The run was stopped before it finished',
    });
  });

  it('answers 500 before streaming when the store cannot create the stream', async () => {
    const store = new InMemoryStreamReplayStore();
    const failing: StreamReplayStore = Object.assign(Object.create(store) as StreamReplayStore, {
      create: () => Promise.reject(new Error('redis down')),
    });
    const hub = new ResumableStreams({ store: failing });
    await expect(
      hub.startAgentRun({ execute: controlledRun().execute, describeError })
    ).rejects.toThrow('redis down');
  });

  it('reads the frames of a follower once', async () => {
    const hub = new ResumableStreams();
    const { run, first } = await startRun(hub);
    run.finish();
    await readAll(first);
    await expect(readAll(first)).rejects.toThrow(/already read/);
  });
});

describe('ResumableStreams under pressure', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the run of the caller, which ends its stream with STREAM_CANCELLED', async () => {
    const hub = new ResumableStreams<Auth>();
    const { run, first } = await startRun(hub, { userId: 'alice' });
    const before = await readThenLeave(first, 1);

    expect(await hub.cancel(first.streamId, { auth: { userId: 'mallory' } })).toMatchObject({
      ok: false,
      error: { status: 404, code: STREAM_NOT_FOUND },
    });
    expect(run.signal.aborted).toBe(false);
    expect(await hub.cancel('not a stream id', { auth: { userId: 'alice' } })).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    expect(await hub.cancel(first.streamId, { auth: { userId: 'alice' } })).toEqual({ ok: true });
    expect(run.signal.aborted).toBe(true);

    const rest = await readAll(await reconnect(hub, before[0]?.id, { userId: 'alice' }));
    expect(rest.at(-1)?.event).toMatchObject({
      type: 'error',
      code: STREAM_CANCELLED,
      message: 'The run was cancelled',
    });
  });

  it('cancels a run another process runs, through the store', async () => {
    const store = new InMemoryStreamReplayStore();
    const runner = new ResumableStreams({ store });
    const other = new ResumableStreams({ store });
    const { run, first } = await startRun(runner);

    expect(await other.cancel(first.streamId)).toEqual({ ok: true });
    expect(run.signal.aborted).toBe(true);
  });

  it('refuses a new stream with 503 STREAM_LIMIT_REACHED while every stream kept goes on', async () => {
    const hub = new ResumableStreams<Auth>({ maxStreams: 1 });
    const { run, first } = await startRun(hub, { userId: 'alice' });

    const refused = await hub.startAgentRun({ execute: controlledRun().execute, describeError });
    expect(refused).toMatchObject({
      ok: false,
      error: { status: 503, code: STREAM_LIMIT_REACHED },
    });
    expect(run.signal.aborted).toBe(false);

    run.finish();
    await readAll(first);
    expect((await hub.startAgentRun({ execute: controlledRun().execute, describeError })).ok).toBe(
      true
    );
  });

  it('stops every run when until aborts, or on close()', async () => {
    const until = new AbortController();
    const hub = new ResumableStreams({ until: until.signal });
    const { run, first } = await startRun(hub);
    until.abort();

    expect(run.signal.aborted).toBe(true);
    expect((await readAll(first)).at(-1)?.event).toMatchObject({
      type: 'error',
      code: STREAM_ABORTED,
      message: 'The server stopped the run as it shut down',
    });

    const closing = new ResumableStreams();
    const other = await startRun(closing);
    closing.close();
    expect(other.run.signal.aborted).toBe(true);
  });

  it('hands the clients of the process every event, the last one too, when the store fails', async () => {
    const memory = new InMemoryStreamReplayStore();
    let failing = false;
    const store: StreamReplayStore = Object.assign(Object.create(memory) as StreamReplayStore, {
      append: (id: string, entry: StoredStreamEvent) =>
        failing ? Promise.reject(new Error('redis down')) : memory.append(id, entry),
      finish: () => Promise.reject(new Error('redis down')),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hub = new ResumableStreams({ store });
    const { run, first } = await startRun(hub);
    const reading = readAll(first);
    run.callbacks.onToken('a');
    failing = true;
    run.callbacks.onToken('b');

    const frames = await reading;
    expect(frames.map(seqOf)).toEqual(frames.map((_, at) => at + 1));
    expect(frames.at(-1)?.event).toMatchObject({ type: 'error', code: STREAM_ABORTED });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('reports events a store lost as STREAM_RESUME_GAP instead of skipping them', async () => {
    const memory = new InMemoryStreamReplayStore();
    const lost = 3;
    const store: StreamReplayStore = Object.assign(Object.create(memory) as StreamReplayStore, {
      subscribe: (id: string, subscriber: StreamSubscriber) =>
        memory.subscribe(id, {
          event: (entry) => entry.seq !== lost && subscriber.event(entry),
          end: () => subscriber.end(),
        }),
      read: async (id: string, afterSeq: number) => {
        const replay = await memory.read(id, afterSeq);
        return replay && { ...replay, events: replay.events.filter((e) => e.seq !== lost) };
      },
    });
    const runner = new ResumableStreams({ store });
    const elsewhere = new ResumableStreams({ store });
    const { run, first } = await startRun(runner);
    await readThenLeave(first, 1);
    const follower = opened(await elsewhere.reconnect(formatStreamEventId(first.streamId, 1)));
    const reading = readAll(follower);
    run.callbacks.onToken('a');
    run.callbacks.onToken('b');
    run.finish();

    const rest = await reading;
    expect(rest.map(seqOf)).toEqual([2, undefined]);
    expect(rest.at(-1)?.event).toMatchObject({ type: 'error', code: STREAM_RESUME_GAP });
  });

  it('holds at most maxEvents for a client that reads slowly, which catches up from the store', async () => {
    const store = new InMemoryStreamReplayStore({ maxEvents: 100 });
    const hub = new ResumableStreams({ store, maxEvents: 3 });
    const { run, first } = await startRun(hub);
    const frames = first.frames(new AbortController().signal);
    const read: StreamFrame[] = [];
    read.push((await frames.next()).value as StreamFrame);
    for (let at = 0; at < 20; at++) run.callbacks.onToken(String(at));
    run.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for await (const frame of frames) read.push(frame);

    expect(read.map(seqOf)).toEqual(read.map((_, at) => at + 1));
    expect(read.at(-1)?.event.type).toBe('finish');
  });

  it('ends a client that fell behind past the store with STREAM_RESUME_GAP', async () => {
    const hub = new ResumableStreams({ maxEvents: 3 });
    const { run, first } = await startRun(hub);
    const frames = first.frames(new AbortController().signal);
    await frames.next();
    for (let at = 0; at < 20; at++) run.callbacks.onToken(String(at));
    run.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const read: StreamFrame[] = [];
    for await (const frame of frames) read.push(frame);

    expect(read.at(-1)?.event).toMatchObject({ type: 'error', code: STREAM_RESUME_GAP });
  });

  it.each(['subscribe', 'onCancel'] as const)(
    'gives the slot of a stream back when %s fails after the store created it',
    async (method) => {
      const memory = new InMemoryStreamReplayStore({ maxStreams: 1 });
      let failures = 1;
      const store: StreamReplayStore = Object.assign(Object.create(memory) as StreamReplayStore, {
        [method]: (...args: Parameters<StreamReplayStore[typeof method]>) => {
          if (failures-- > 0) return Promise.reject(new Error('redis down'));
          return (memory[method] as (...inner: typeof args) => unknown)(...args);
        },
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const hub = new ResumableStreams({ store });

      await expect(
        hub.startAgentRun({ execute: controlledRun().execute, describeError })
      ).rejects.toThrow('redis down');
      const { run } = await startRun(hub);

      expect(run.signal.aborted).toBe(false);
      run.finish();
      errors.mockRestore();
    }
  );

  it('hands out an event id only once a slow store kept the event, so a reconnect with it never misses', async () => {
    const memory = new InMemoryStreamReplayStore();
    const pending: Array<() => void> = [];
    const store: StreamReplayStore = Object.assign(Object.create(memory) as StreamReplayStore, {
      append: (id: string, entry: StoredStreamEvent) =>
        new Promise<void>((resolve, reject) => {
          pending.push(() => memory.append(id, entry).then(resolve, reject));
        }),
    });
    const settle = async () => {
      while (pending.length > 0) {
        pending.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const hub = new ResumableStreams({ store });
    const run = controlledRun();
    const first = opened(await hub.startAgentRun({ execute: run.execute, describeError }));
    await run.running;
    const frames = first.frames(new AbortController().signal);
    let delivered = false;
    const next = frames.next().then((result) => {
      delivered = true;
      return result.value as StreamFrame;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered).toBe(false);
    await settle();
    const frame = await next;
    expect(frame.id).toBe(formatStreamEventId(first.streamId, 1));

    run.callbacks.onToken('a');
    const attached = await hub.reconnect(frame.id ?? '');
    expect(attached.ok).toBe(true);
    run.finish();
    await settle();
    await frames.return(undefined);
  });

  it('counts the detached time of a run from the last client that left on any process', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const now = () => clock;
    let timers = 0;
    const advanceTo = async (at: number) => {
      clock = at;
      await vi.advanceTimersByTimeAsync(at - timers);
      timers = at;
    };
    const store = new InMemoryStreamReplayStore({ now });
    const runner = new ResumableStreams({ store, now, detachedTimeoutMs: 1_000 });
    const elsewhere = new ResumableStreams({ store, now, detachedTimeoutMs: 1_000 });
    const { run, first } = await startRun(runner);
    const before = await readThenLeave(first, 1);

    await advanceTo(500);
    const remote = opened(await elsewhere.reconnect(before[0]?.id ?? ''));
    expect((await store.get(first.streamId))?.detachedAt).toBeUndefined();
    await advanceTo(600);
    const gone = new AbortController();
    gone.abort();
    for await (const frame of remote.frames(gone.signal)) void frame;
    expect((await store.get(first.streamId))?.detachedAt).toBe(600);

    await advanceTo(1_000);
    expect(run.signal.aborted).toBe(false);
    await advanceTo(1_599);
    expect(run.signal.aborted).toBe(false);
    await advanceTo(1_600);
    expect(run.signal.aborted).toBe(true);
  });
});
