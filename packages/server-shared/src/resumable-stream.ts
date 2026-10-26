import type { RunResult } from '@cogitator-ai/types';
import type { HttpErrorDescription } from './contract.js';
import { createErrorEvent, type StreamEvent } from './protocol.js';
import { AgentStreamSession, createThreadId } from './stream-session.js';
import {
  DEFAULT_STREAM_MAX_EVENTS,
  InMemoryStreamReplayStore,
  positiveLimit,
  type StoredStreamEvent,
  type StreamOwner,
  type StreamRecord,
  type StreamReplayStore,
  type StreamSubscriber,
} from './stream-replay-store.js';

/** A reconnect or cancel named a stream the server does not keep: unknown, expired or someone else's */
export const STREAM_NOT_FOUND = 'STREAM_NOT_FOUND';
/** Events after the id a client reconnected with are lost: it has to read the thread */
export const STREAM_RESUME_GAP = 'STREAM_RESUME_GAP';
/** The run of a resumable stream was stopped before it finished, with nobody attached or by a shutdown */
export const STREAM_ABORTED = 'STREAM_ABORTED';
/** The run of a resumable stream was stopped by its caller, through the cancel route */
export const STREAM_CANCELLED = 'STREAM_CANCELLED';
/** The store keeps as many streams as it may, all of them still going: no new one fits */
export const STREAM_LIMIT_REACHED = 'STREAM_LIMIT_REACHED';

/** Default of `detachedTimeoutMs`: how long a run goes on with no client attached, 5 minutes */
export const DEFAULT_DETACHED_TIMEOUT_MS = 5 * 60_000;

const MAX_TIMER_MS = 2_147_483_647;

/**
 * The `resumableStreams` option of every adapter. A client that loses the stream of an agent
 * run reconnects with `Last-Event-ID` and gets what it missed, and the run goes on while it is
 * away. `Auth` is what the adapter's authentication establishes for a caller.
 */
export interface ResumableStreamOptions<Auth = unknown> {
  /**
   * Where the events are kept. Default: an {@link InMemoryStreamReplayStore} with the limits
   * below. Several processes behind a load balancer need a shared store with pub/sub, see
   * {@link StreamReplayStore}.
   */
  store?: StreamReplayStore;
  /**
   * Events kept of each stream by the default store, and events a client that reads slowly may
   * fall behind before it reads the store again. Default: 1000
   */
  maxEvents?: number;
  /** How long the default store keeps a finished stream, in ms. Default: 5 minutes */
  retentionMs?: number;
  /**
   * Streams the default store keeps at once. A new stream evicts the one that finished first,
   * and is refused with `503 STREAM_LIMIT_REACHED` while every stream kept is still going.
   * Default: 1000
   */
  maxStreams?: number;
  /**
   * How long a run goes on while no client is attached to its stream, in ms, before it is
   * stopped, so a client that never comes back does not run up cost. Default: 5 minutes
   */
  detachedTimeoutMs?: number;
  /**
   * The key a stream is bound to, from what authentication established for the caller who
   * started it: only a caller with the same key may reconnect to it or cancel its run, and
   * `undefined` is the anonymous caller. Default: the whole identity, every field of it (user
   * id, roles, permissions, metadata such as a tenant), so callers without a user id are still
   * told apart. Return fewer fields when the identity carries values that change between
   * requests, such as the expiry of a token.
   */
  owner?: (auth: Auth | undefined) => string | undefined | Promise<string | undefined>;
  /**
   * Stops every run of a resumable stream when it aborts, such as a server that shuts down.
   * Abort it before the HTTP server closes: a close waits for the streams still open, and
   * stopping their runs is what ends them
   */
  until?: AbortSignal;
}

/** One event as a resumable stream sends it: with its id, except for the gap error */
export interface StreamFrame {
  /** `<streamId>:<seq>`, what a client sends back as `Last-Event-ID` */
  id?: string;
  event: StreamEvent;
}

/** What an event id names: a stream and the sequence number of one of its events */
export interface StreamEventId {
  streamId: string;
  seq: number;
}

const STREAM_ID_PATTERN = /^[\w-]{1,128}$/;
const SEQ_PATTERN = /^\d{1,15}$/;

/** The id of event `seq` of a stream: `<streamId>:<seq>` */
export function formatStreamEventId(streamId: string, seq: number): string {
  return `${streamId}:${seq}`;
}

/** Reads an event id, `undefined` when it is not `<streamId>:<seq>` */
export function parseStreamEventId(id: string): StreamEventId | undefined {
  const at = id.lastIndexOf(':');
  if (at === -1) return undefined;
  const streamId = id.slice(0, at);
  const seq = id.slice(at + 1);
  if (!isStreamId(streamId) || !SEQ_PATTERN.test(seq)) return undefined;
  return { streamId, seq: Number(seq) };
}

/** Whether `id` can be the id of a stream */
export function isStreamId(id: string): boolean {
  return STREAM_ID_PATTERN.test(id);
}

/**
 * The event id a request reconnects with: its `Last-Event-ID` header, else its `lastEventId`
 * query parameter, `undefined` when it names none (an empty value names none, as in SSE)
 */
export function lastEventIdOf(header: unknown, query: unknown): string | undefined {
  const named = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return value.length > 0 ? value.join(',') : undefined;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  return named(header) ?? named(query);
}

/** JSON with the keys of every object in order and nothing JSON cannot hold */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        )
      : inner
  );
}

/**
 * The default key a stream is bound to: every field of the caller's identity, in a stable
 * order. No identity, or an empty one, is the anonymous caller (`undefined`)
 */
export function defaultStreamOwner(auth: unknown): string | undefined {
  if (auth === undefined || auth === null) return undefined;
  const key = stableJson(auth);
  return key === undefined || key === '{}' ? undefined : key;
}

/** The refusal of an event id that is not `<streamId>:<seq>` */
export function invalidLastEventId(): HttpErrorDescription {
  return {
    status: 400,
    code: 'INVALID_INPUT',
    message: 'Last-Event-ID must be the id of a stream event: <streamId>:<seq>',
  };
}

/** The refusal of a cancel that names no stream id */
export function invalidStreamId(): HttpErrorDescription {
  return { status: 400, code: 'INVALID_INPUT', message: 'The stream id is not valid' };
}

/** The refusal of a reconnect or cancel of a stream the server does not keep for the caller */
export function streamNotFound(): HttpErrorDescription {
  return {
    status: 404,
    code: STREAM_NOT_FOUND,
    message: 'No stream has this id: it is unknown, expired or not yours',
  };
}

/** The refusal of a new resumable stream while the store has no room for one */
export function streamLimitReached(): HttpErrorDescription {
  return {
    status: 503,
    code: STREAM_LIMIT_REACHED,
    message: 'The server keeps as many streams as it may: try again once a run finished',
  };
}

/** A stream a client follows: the events after where it starts, then the live ones */
export interface StreamFollower {
  readonly streamId: string;
  /** The thread of the stream's run */
  readonly threadId: string;
  /**
   * The events to send, with their ids, until the stream ends or `signal` aborts (the client
   * left). Read it once: it holds the subscription that keeps the run from being stopped as
   * detached, and lets it go when it ends.
   */
  frames(signal: AbortSignal): AsyncGenerator<StreamFrame, void, undefined>;
}

/** The writing end of a resumable stream, with its first client attached */
export interface ResumableStream extends StreamFollower {
  /**
   * Aborts when no client was attached for `detachedTimeoutMs`, when the caller cancels the
   * run, when `until` or the signal the stream was opened with aborts: pass it to the run
   */
  readonly signal: AbortSignal;
  /** Gives the event the next id, hands it to the clients of this process and keeps it */
  emit(event: StreamEvent): void;
  /** Ends the stream once every event emitted is kept */
  end(): Promise<void>;
  /** What stopped the run once `signal` aborted, to end the stream with */
  stopReason(): { message: string; code: string };
}

/** Who asks to reconnect to a stream or cancel its run */
export interface StreamCaller<Auth = unknown> {
  /** What authentication established for the caller */
  auth?: Auth;
  /**
   * The adapter's `authorizeThread` for this caller: the refusal on the stream's thread, none
   * to let the caller on
   */
  authorizeThread?: (
    threadId: string
  ) => Promise<HttpErrorDescription | undefined> | HttpErrorDescription | undefined;
}

/** What opening a stream gave: the stream, or the refusal to answer with */
export type StreamOpening<T> = { ok: true; stream: T } | { ok: false; error: HttpErrorDescription };

/** A reconnect: the stream to follow, or the refusal to answer with */
export type StreamReconnection = StreamOpening<StreamFollower>;

/** A cancel: done, or the refusal to answer with */
export type StreamCancellation = { ok: true } | { ok: false; error: HttpErrorDescription };

/** A streamed agent run or resume on a resumable stream */
export interface ResumableAgentRunOptions<Auth = unknown> {
  /** The caller, who alone may reconnect to the stream or cancel its run */
  auth?: Auth;
  /** The thread the request named; without one the run gets a new thread */
  threadId?: string;
  /** Stops the run when it aborts, such as a server that shuts down */
  signal?: AbortSignal;
  /**
   * Starts the run with the session's thread and callbacks (`threadId: session.threadId`,
   * `...session.callbacks`, `stream: true`) and `signal`
   */
  execute(session: AgentStreamSession, signal: AbortSignal): Promise<RunResult>;
  /** What a client may see of the error the run failed with */
  describeError(error: unknown): { message: string; code?: string };
}

/** Why a resumable stream stopped its run */
class StreamStop extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'StreamStop';
  }
}

function isTerminal(event: StreamEvent): boolean {
  return event.type === 'finish' || event.type === 'error';
}

function logStoreFailure(action: string, error: unknown): void {
  console.error(`[cogitator] The stream replay store failed to ${action}:`, error);
}

/** What a subscription hands its reader: an event, or word that the reader fell behind */
type Pending = StoredStreamEvent | 'behind';

/**
 * The events handed to one client, waiting for it to read them. It holds at most `capacity`:
 * a client that falls further behind loses them and reads the store again.
 */
class Subscription implements StreamSubscriber {
  private entries: StoredStreamEvent[] = [];
  private lastQueued = 0;
  private behind = false;
  private ended = false;
  private wake: (() => void) | undefined;

  constructor(private readonly capacity: number) {}

  event(entry: StoredStreamEvent): void {
    if (this.ended || this.behind || entry.seq <= this.lastQueued) return;
    if (this.entries.length >= this.capacity) {
      this.entries = [];
      this.behind = true;
    } else {
      this.entries.push(entry);
      this.lastQueued = entry.seq;
    }
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  /** Takes events again once the reader caught up from the store */
  resume(): void {
    this.behind = false;
    this.lastQueued = 0;
  }

  /** The next event, `'behind'` once the reader fell behind, `undefined` once it all ended */
  async next(signal: AbortSignal): Promise<Pending | undefined> {
    for (;;) {
      const entry = this.entries.shift();
      if (entry) return entry;
      if (this.behind) return 'behind';
      if (this.ended || signal.aborted) return undefined;
      await new Promise<void>((resolve) => {
        const abort = () => resolve();
        signal.addEventListener('abort', abort, { once: true });
        this.wake = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/** A client on a stream: replays the events after `afterSeq` and follows the live ones */
class Follower implements StreamFollower {
  private read = false;

  constructor(
    private readonly store: StreamReplayStore,
    readonly streamId: string,
    readonly threadId: string,
    private readonly afterSeq: number,
    private readonly subscription: Subscription,
    private readonly unsubscribe: () => Promise<void>,
    private readonly onClose: () => void
  ) {}

  async *frames(signal: AbortSignal): AsyncGenerator<StreamFrame, void, undefined> {
    if (this.read) throw new Error(`The frames of stream '${this.streamId}' were already read`);
    this.read = true;
    try {
      let last = this.afterSeq;
      let batch = await this.store.read(this.streamId, last);
      for (;;) {
        if (signal.aborted || !batch) return;
        if (batch.gap) {
          yield this.gap();
          return;
        }
        for (const entry of batch.events) {
          if (signal.aborted) return;
          if (entry.seq <= last) continue;
          if (entry.seq !== last + 1) {
            yield this.gap();
            return;
          }
          last = entry.seq;
          yield { id: formatStreamEventId(this.streamId, entry.seq), event: entry.event };
          if (isTerminal(entry.event)) return;
        }
        if (batch.finished) return;
        const pending = await this.subscription.next(signal);
        if (pending === undefined) return;
        if (pending === 'behind') {
          this.subscription.resume();
          batch = await this.store.read(this.streamId, last);
        } else if (pending.seq <= last + 1) {
          batch = { events: [pending], gap: false, finished: false };
        } else {
          const missed = await this.store.read(this.streamId, last);
          batch = missed && { ...missed, events: [...missed.events, pending] };
        }
      }
    } finally {
      await this.close();
    }
  }

  private gap(): StreamFrame {
    return {
      event: createErrorEvent(
        `The events after this id are no longer kept, fetch the thread (GET /threads/${this.threadId}) to catch up`,
        STREAM_RESUME_GAP
      ),
    };
  }

  private async close(): Promise<void> {
    try {
      await this.unsubscribe();
    } catch (error) {
      logStoreFailure('end a subscription', error);
    }
    this.onClose();
  }
}

/** The writing end of a stream this process runs */
class Producer implements ResumableStream {
  readonly signal: AbortSignal;
  private readonly stopper = new AbortController();
  private seq = 0;
  private kept: Promise<void> = Promise.resolve();
  private ended: Promise<void> | undefined;
  private attached = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private first: StreamFollower | undefined;
  /** The subscriptions of this process, handed every event at once, whatever the store does */
  private readonly local = new Set<Subscription>();
  private stopWatchingCancel: (() => Promise<void>) | undefined;

  constructor(
    private readonly store: StreamReplayStore,
    readonly streamId: string,
    readonly threadId: string,
    private readonly detachedTimeoutMs: number,
    private readonly onEnd: () => void,
    signals: readonly AbortSignal[]
  ) {
    this.signal = AbortSignal.any([this.stopper.signal, ...signals]);
  }

  /** Hands the producer its first client, which it serves with `frames` */
  follow(first: StreamFollower): void {
    this.first = first;
  }

  /** Lets the producer stop listening for cancels once the stream ends */
  watchCancel(stop: () => Promise<void>): void {
    this.stopWatchingCancel = stop;
  }

  frames(signal: AbortSignal): AsyncGenerator<StreamFrame, void, undefined> {
    if (!this.first) throw new Error(`Stream '${this.streamId}' has no first client`);
    return this.first.frames(signal);
  }

  emit(event: StreamEvent): void {
    if (this.ended) return;
    const entry = { seq: ++this.seq, event };
    for (const subscription of this.local) subscription.event(entry);
    this.kept = this.kept
      .then(() => this.store.append(this.streamId, entry))
      .catch((error: unknown) => {
        logStoreFailure('keep an event', error);
        this.stop(
          new StreamStop(
            'The stream replay store failed to keep an event of the run, so the run was stopped',
            STREAM_ABORTED
          )
        );
      });
  }

  end(): Promise<void> {
    this.ended ??= this.finish();
    return this.ended;
  }

  stopReason(): { message: string; code: string } {
    const reason: unknown = this.signal.reason;
    return reason instanceof StreamStop
      ? { message: reason.message, code: reason.code }
      : { message: 'The run was stopped before it finished', code: STREAM_ABORTED };
  }

  /** Stops the run at its caller's request */
  cancel(): void {
    this.stop(new StreamStop('The run was cancelled', STREAM_CANCELLED));
  }

  /** Counts a client of this process, `subscription` getting every event at once */
  attach(subscription: Subscription): void {
    this.local.add(subscription);
    this.attached++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  detach(subscription: Subscription): void {
    this.local.delete(subscription);
    this.attached--;
    if (this.attached === 0 && !this.ended) this.armDetachedTimer();
  }

  private async finish(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.kept;
    try {
      await this.store.finish(this.streamId);
    } catch (error) {
      logStoreFailure('finish a stream', error);
    }
    for (const subscription of this.local) subscription.end();
    try {
      await this.stopWatchingCancel?.();
    } catch (error) {
      logStoreFailure('stop listening for cancels', error);
    }
    this.onEnd();
  }

  private stop(reason: StreamStop): void {
    if (!this.stopper.signal.aborted) this.stopper.abort(reason);
  }

  private armDetachedTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.stopIfDetached();
    }, this.detachedTimeoutMs);
    unrefTimer(this.timer);
  }

  /**
   * Stops the run when still nobody follows its stream, on any process: a client may have
   * reconnected to another process sharing the store
   */
  private async stopIfDetached(): Promise<void> {
    if (this.ended || this.attached > 0) return;
    try {
      const record = await this.store.get(this.streamId);
      if (record && record.subscribers > 0) {
        this.armDetachedTimer();
        return;
      }
    } catch (error) {
      logStoreFailure('read a stream', error);
      this.armDetachedTimer();
      return;
    }
    if (this.ended || this.attached > 0) return;
    this.stop(
      new StreamStop(
        `No client was attached to the stream for ${this.detachedTimeoutMs} ms, so the run was stopped`,
        STREAM_ABORTED
      )
    );
  }
}

/** Lets a timer go without keeping the process alive, where the runtime allows it */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
}

/**
 * Resumable streams of agent runs, the machinery behind the `resumableStreams` option of
 * every adapter.
 *
 * Every event of a stream gets an id, `<streamId>:<seq>` with `seq` from 1 up, and is kept in
 * the store. The client that started the run is its first follower. When it leaves, the run
 * goes on: a client that reconnects with the id of the last event it got
 * ({@link reconnect}) replays the events after it, then follows the live ones until `finish`
 * or `error`. Several clients may follow a stream at once. A stream is bound to the caller who
 * started it ({@link ResumableStreamOptions.owner}), and only that caller may reconnect to it
 * or {@link cancel} its run. A run nobody follows for `detachedTimeoutMs` is stopped.
 *
 * Adapters wire the transport only: {@link startAgentRun} for a new run or resume,
 * {@link reconnect} for a request with `Last-Event-ID`, {@link cancel} for the cancel route,
 * then they write each frame of `frames()` with its id.
 */
export class ResumableStreams<Auth = unknown> {
  readonly store: StreamReplayStore;
  readonly detachedTimeoutMs: number;
  private readonly maxEvents: number;
  private readonly owner: (
    auth: Auth | undefined
  ) => string | undefined | Promise<string | undefined>;
  private readonly producers = new Map<string, Producer>();
  private readonly shutdown = new AbortController();

  /**
   * The resumable streams an adapter option asks for: none for `false` or no option, the
   * defaults for `true`
   */
  static from<Auth = unknown>(
    option: boolean | ResumableStreamOptions<Auth> | undefined
  ): ResumableStreams<Auth> | undefined {
    if (!option) return undefined;
    return new ResumableStreams<Auth>(option === true ? {} : option);
  }

  /** @throws RangeError for a limit that is not a positive whole number, or store limits next to a `store` */
  constructor(options: ResumableStreamOptions<Auth> = {}) {
    const { store, maxEvents, retentionMs, maxStreams } = options;
    if (store && (retentionMs ?? maxStreams) !== undefined) {
      throw new RangeError(
        'retentionMs and maxStreams set up the in-memory store: give them to your own store instead'
      );
    }
    this.maxEvents = positiveLimit('maxEvents', maxEvents, DEFAULT_STREAM_MAX_EVENTS);
    this.store = store ?? new InMemoryStreamReplayStore({ maxEvents, retentionMs, maxStreams });
    this.detachedTimeoutMs = positiveLimit(
      'detachedTimeoutMs',
      options.detachedTimeoutMs,
      DEFAULT_DETACHED_TIMEOUT_MS
    );
    if (this.detachedTimeoutMs > MAX_TIMER_MS) {
      throw new RangeError(`detachedTimeoutMs must be at most ${MAX_TIMER_MS} ms`);
    }
    this.owner = options.owner ?? defaultStreamOwner;
    const { until } = options;
    if (until?.aborted) this.close();
    else until?.addEventListener('abort', () => this.close(), { once: true });
  }

  /** The key a stream of `auth` is bound to */
  ownerOf(auth: Auth | undefined): Promise<string | undefined> {
    return Promise.resolve(this.owner(auth));
  }

  /**
   * Opens a stream with a new random id, its first client attached: read `frames()` to serve
   * that client. `signal` stops the run too, besides the detached timeout, a cancel and `until`.
   * `503 STREAM_LIMIT_REACHED` when the store has no room for it.
   */
  async open(
    owner: StreamOwner & { signal?: AbortSignal }
  ): Promise<StreamOpening<ResumableStream>> {
    const streamId = `stream_${globalThis.crypto.randomUUID()}`;
    const created = await this.store.create({
      id: streamId,
      ...(owner.owner !== undefined && { owner: owner.owner }),
      threadId: owner.threadId,
      createdAt: Date.now(),
    });
    if (!created) return { ok: false, error: streamLimitReached() };
    const producer = new Producer(
      this.store,
      streamId,
      owner.threadId,
      this.detachedTimeoutMs,
      () => this.producers.delete(streamId),
      [this.shutdown.signal, ...(owner.signal ? [owner.signal] : [])]
    );
    this.producers.set(streamId, producer);
    const subscription = new Subscription(this.maxEvents);
    let unsubscribe: (() => Promise<void>) | undefined;
    try {
      unsubscribe = await this.store.subscribe(streamId, subscription);
      if (!unsubscribe) throw new Error(`The stream replay store lost stream '${streamId}'`);
      const stopWatching = await this.store.onCancel(streamId, () => producer.cancel());
      if (stopWatching) producer.watchCancel(stopWatching);
    } catch (error) {
      await this.abandon(streamId, unsubscribe);
      throw error;
    }
    producer.attach(subscription);
    producer.follow(
      new Follower(this.store, streamId, owner.threadId, 0, subscription, unsubscribe, () =>
        producer.detach(subscription)
      )
    );
    return { ok: true, stream: producer };
  }

  /**
   * Starts a streamed agent run or resume on a new stream, and returns it for the client that
   * asked. The run belongs to the stream from then on: it ends with `finish`, or `error` when
   * it fails, also when it was stopped (`STREAM_ABORTED`, `STREAM_CANCELLED`).
   *
   * @throws what the store threw when it could not create the stream, before anything was sent
   */
  async startAgentRun(
    options: ResumableAgentRunOptions<Auth>
  ): Promise<StreamOpening<StreamFollower>> {
    const opened = await this.open({
      owner: await this.ownerOf(options.auth),
      threadId: options.threadId ?? createThreadId(),
      signal: options.signal,
    });
    if (!opened.ok) return opened;
    const stream = opened.stream;
    const session = new AgentStreamSession((event) => stream.emit(event), {
      threadId: stream.threadId,
    });
    void (async () => {
      try {
        session.start();
        session.complete(await options.execute(session, stream.signal));
      } catch (error) {
        if (stream.signal.aborted) {
          const reason = stream.stopReason();
          session.fail(reason.message, reason.code);
        } else {
          const described = options.describeError(error);
          session.fail(described.message, described.code);
        }
      } finally {
        await stream.end();
      }
    })();
    return { ok: true, stream };
  }

  /**
   * Attaches a client to the stream of `lastEventId`, after that event: `400 INVALID_INPUT`
   * for an id that is not `<streamId>:<seq>`, `404 STREAM_NOT_FOUND` for a stream the store
   * does not keep, one another caller started or an event it never sent, and the refusal of
   * `authorizeThread` on the stream's thread.
   */
  async reconnect(
    lastEventId: string,
    caller: StreamCaller<Auth> = {}
  ): Promise<StreamReconnection> {
    const id = parseStreamEventId(lastEventId);
    if (!id) return { ok: false, error: invalidLastEventId() };
    const admitted = await this.admit(id.streamId, caller);
    if (!admitted.ok) return admitted;
    if (id.seq > admitted.record.lastSeq) return { ok: false, error: streamNotFound() };
    const subscription = new Subscription(this.maxEvents);
    const unsubscribe = await this.store.subscribe(id.streamId, subscription);
    if (!unsubscribe) return { ok: false, error: streamNotFound() };
    const producer = this.producers.get(id.streamId);
    producer?.attach(subscription);
    return {
      ok: true,
      stream: new Follower(
        this.store,
        id.streamId,
        admitted.record.threadId,
        id.seq,
        subscription,
        unsubscribe,
        () => producer?.detach(subscription)
      ),
    };
  }

  /**
   * Stops the run of a stream at its caller's request, on whatever process runs it: its stream
   * ends with an `error` event `STREAM_CANCELLED`. The same refusals as {@link reconnect}, and a
   * stream that already finished is left as it is.
   */
  async cancel(streamId: string, caller: StreamCaller<Auth> = {}): Promise<StreamCancellation> {
    if (!isStreamId(streamId)) return { ok: false, error: invalidStreamId() };
    const admitted = await this.admit(streamId, caller);
    if (!admitted.ok) return admitted;
    await this.store.cancel(streamId);
    return { ok: true };
  }

  /** Stops every run of a resumable stream this process runs, as `until` does */
  close(): void {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort(
      new StreamStop('The server stopped the run as it shut down', STREAM_ABORTED)
    );
  }

  /**
   * Gives up a stream the store created but that could not be opened: it is finished, so it no
   * longer holds a `maxStreams` slot, and forgotten, whatever else fails on the way
   */
  private async abandon(
    streamId: string,
    unsubscribe: (() => Promise<void>) | undefined
  ): Promise<void> {
    this.producers.delete(streamId);
    await unsubscribe?.().catch((error: unknown) => logStoreFailure('end a subscription', error));
    await this.store
      .finish(streamId)
      .catch((error: unknown) => logStoreFailure('finish a stream', error));
  }

  /** The stream of the caller, after the owner check and `authorizeThread` */
  private async admit(
    streamId: string,
    caller: StreamCaller<Auth>
  ): Promise<{ ok: true; record: StreamRecord } | { ok: false; error: HttpErrorDescription }> {
    const record = await this.store.get(streamId);
    if (!record || record.owner !== (await this.ownerOf(caller.auth))) {
      return { ok: false, error: streamNotFound() };
    }
    const refusal = await caller.authorizeThread?.(record.threadId);
    return refusal ? { ok: false, error: refusal } : { ok: true, record };
  }
}
