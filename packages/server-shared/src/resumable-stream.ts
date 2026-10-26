import type { RunResult } from '@cogitator-ai/types';
import type { HttpErrorDescription } from './contract.js';
import { createErrorEvent, type StreamEvent } from './protocol.js';
import { AgentStreamSession, createThreadId } from './stream-session.js';
import {
  InMemoryStreamReplayStore,
  positiveLimit,
  type StoredStreamEvent,
  type StreamOwner,
  type StreamReplayStore,
  type StreamSubscriber,
} from './stream-replay-store.js';

/** A reconnect named a stream the server does not keep: unknown, expired or someone else's */
export const STREAM_NOT_FOUND = 'STREAM_NOT_FOUND';
/** The events after the id a client reconnected with were evicted: it has to read the thread */
export const STREAM_RESUME_GAP = 'STREAM_RESUME_GAP';
/** The run of a resumable stream was stopped before it finished, with nobody attached */
export const STREAM_ABORTED = 'STREAM_ABORTED';

/** Default of `detachedTimeoutMs`: how long a run goes on with no client attached, 5 minutes */
export const DEFAULT_DETACHED_TIMEOUT_MS = 5 * 60_000;

const MAX_TIMER_MS = 2_147_483_647;

/**
 * The `resumableStreams` option of every adapter. A client that loses the stream of an agent
 * run reconnects with `Last-Event-ID` and gets what it missed, and the run goes on while it is
 * away.
 */
export interface ResumableStreamOptions {
  /**
   * Where the events are kept. Default: an {@link InMemoryStreamReplayStore} with the limits
   * below. Several processes behind a load balancer need a shared store with pub/sub, see
   * {@link StreamReplayStore}.
   */
  store?: StreamReplayStore;
  /** Events kept of each stream by the default store. Default: 1000 */
  maxEvents?: number;
  /** How long the default store keeps a finished stream, in ms. Default: 5 minutes */
  retentionMs?: number;
  /** Streams the default store keeps at once. Default: 1000 */
  maxStreams?: number;
  /**
   * How long a run goes on while no client is attached to its stream, in ms, before it is
   * stopped, so a client that never comes back does not run up cost. Default: 5 minutes
   */
  detachedTimeoutMs?: number;
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
  if (!STREAM_ID_PATTERN.test(streamId) || !SEQ_PATTERN.test(seq)) return undefined;
  return { streamId, seq: Number(seq) };
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

/** The refusal of an event id that is not `<streamId>:<seq>` */
export function invalidLastEventId(): HttpErrorDescription {
  return {
    status: 400,
    code: 'INVALID_INPUT',
    message: 'Last-Event-ID must be the id of a stream event: <streamId>:<seq>',
  };
}

/** The refusal of a reconnect to a stream the server does not keep for the caller */
export function streamNotFound(): HttpErrorDescription {
  return {
    status: 404,
    code: STREAM_NOT_FOUND,
    message: 'No stream has this event id: it is unknown, expired or not yours',
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
   * Aborts when no client was attached for `detachedTimeoutMs`, or when the signal the stream
   * was opened with aborts: pass it to the run
   */
  readonly signal: AbortSignal;
  /** Gives the event the next id and keeps it */
  emit(event: StreamEvent): void;
  /** Ends the stream once every event emitted is kept */
  end(): Promise<void>;
}

/** A reconnect: the stream to follow, or the refusal to answer with */
export type StreamReconnection =
  { ok: true; stream: StreamFollower } | { ok: false; error: HttpErrorDescription };

/** A streamed agent run or resume on a resumable stream */
export interface ResumableAgentRunOptions {
  /** The caller, who alone may reconnect to the stream (anonymous callers to anonymous streams) */
  userId?: string;
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

/** The run of a stream was stopped because no client was attached */
class DetachedTooLong extends Error {
  constructor(timeoutMs: number) {
    super(`No client was attached to the stream for ${timeoutMs} ms, so the run was stopped`);
    this.name = 'DetachedTooLong';
  }
}

function isTerminal(event: StreamEvent): boolean {
  return event.type === 'finish' || event.type === 'error';
}

function logStoreFailure(action: string, error: unknown): void {
  console.error(`[cogitator] The stream replay store failed to ${action}:`, error);
}

/** The events a store hands a subscription, waiting for whoever reads them */
class Subscription implements StreamSubscriber {
  private readonly entries: StoredStreamEvent[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  event(entry: StoredStreamEvent): void {
    if (this.ended) return;
    this.entries.push(entry);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  /** The next event, `undefined` once the stream ended or `signal` aborted */
  async next(signal: AbortSignal): Promise<StoredStreamEvent | undefined> {
    for (;;) {
      const entry = this.entries.shift();
      if (entry) return entry;
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
      if (signal.aborted) return;
      let last = this.afterSeq;
      const replay = await this.store.read(this.streamId, last);
      if (!replay) return;
      if (replay.gap) {
        yield this.gap();
        return;
      }
      let backlog = replay.events;
      let finished = replay.finished;
      for (;;) {
        for (const entry of backlog) {
          if (signal.aborted) return;
          if (entry.seq <= last) continue;
          last = entry.seq;
          yield { id: formatStreamEventId(this.streamId, entry.seq), event: entry.event };
          if (isTerminal(entry.event)) return;
        }
        if (finished) return;
        const live = await this.subscription.next(signal);
        if (!live) return;
        if (live.seq <= last + 1) {
          backlog = [live];
          continue;
        }
        const missed = await this.store.read(this.streamId, last);
        if (!missed) return;
        if (missed.gap) {
          yield this.gap();
          return;
        }
        backlog = [...missed.events, live];
        finished = missed.finished;
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

  constructor(
    private readonly store: StreamReplayStore,
    readonly streamId: string,
    readonly threadId: string,
    private readonly detachedTimeoutMs: number,
    private readonly onEnd: () => void,
    signal: AbortSignal | undefined
  ) {
    this.signal = signal ? AbortSignal.any([this.stopper.signal, signal]) : this.stopper.signal;
  }

  /** Hands the producer its first client, which it serves with `frames` */
  follow(first: StreamFollower): void {
    this.first = first;
  }

  frames(signal: AbortSignal): AsyncGenerator<StreamFrame, void, undefined> {
    if (!this.first) throw new Error(`Stream '${this.streamId}' has no first client`);
    return this.first.frames(signal);
  }

  emit(event: StreamEvent): void {
    if (this.ended) return;
    const entry = { seq: ++this.seq, event };
    this.kept = this.kept
      .then(() => this.store.append(this.streamId, entry))
      .catch((error: unknown) => {
        logStoreFailure('keep an event', error);
        this.stop(new Error('The stream replay store failed to keep an event of the run'));
      });
  }

  end(): Promise<void> {
    this.ended ??= this.finish();
    return this.ended;
  }

  /** What the run was stopped for, when this stream stopped it */
  stopReason(): string {
    const reason: unknown = this.signal.reason;
    return reason instanceof DetachedTooLong
      ? reason.message
      : 'The run was stopped before it finished';
  }

  attach(): void {
    this.attached++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  detach(): void {
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
    } finally {
      this.onEnd();
    }
  }

  private stop(reason: Error): void {
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
    this.stop(new DetachedTooLong(this.detachedTimeoutMs));
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
 * or `error`. Several clients may follow a stream at once. A run nobody follows for
 * `detachedTimeoutMs` is stopped.
 *
 * Adapters wire the transport only: {@link startAgentRun} for a new run or resume,
 * {@link reconnect} for a request with `Last-Event-ID`, then they write each frame of
 * `frames()` with its id.
 */
export class ResumableStreams {
  readonly store: StreamReplayStore;
  readonly detachedTimeoutMs: number;
  private readonly producers = new Map<string, Producer>();

  /**
   * The resumable streams an adapter option asks for: none for `false` or no option, the
   * defaults for `true`
   */
  static from(option: boolean | ResumableStreamOptions | undefined): ResumableStreams | undefined {
    if (!option) return undefined;
    return new ResumableStreams(option === true ? {} : option);
  }

  /** @throws RangeError for a limit that is not a positive whole number, or limits next to a `store` */
  constructor(options: ResumableStreamOptions = {}) {
    const { store, maxEvents, retentionMs, maxStreams } = options;
    if (store && (maxEvents ?? retentionMs ?? maxStreams) !== undefined) {
      throw new RangeError(
        'maxEvents, retentionMs and maxStreams set up the in-memory store: give them to your own store instead'
      );
    }
    this.store = store ?? new InMemoryStreamReplayStore({ maxEvents, retentionMs, maxStreams });
    this.detachedTimeoutMs = positiveLimit(
      'detachedTimeoutMs',
      options.detachedTimeoutMs,
      DEFAULT_DETACHED_TIMEOUT_MS
    );
    if (this.detachedTimeoutMs > MAX_TIMER_MS) {
      throw new RangeError(`detachedTimeoutMs must be at most ${MAX_TIMER_MS} ms`);
    }
  }

  /**
   * Opens a stream with a new random id, its first client attached: read `frames()` to serve
   * that client. `signal` stops the run too, besides the detached timeout.
   */
  async open(owner: StreamOwner & { signal?: AbortSignal }): Promise<ResumableStream> {
    const streamId = `stream_${globalThis.crypto.randomUUID()}`;
    await this.store.create({
      id: streamId,
      ...(owner.userId !== undefined && { userId: owner.userId }),
      threadId: owner.threadId,
      createdAt: Date.now(),
    });
    const producer = new Producer(
      this.store,
      streamId,
      owner.threadId,
      this.detachedTimeoutMs,
      () => this.producers.delete(streamId),
      owner.signal
    );
    this.producers.set(streamId, producer);
    const subscription = new Subscription();
    const unsubscribe = await this.store.subscribe(streamId, subscription);
    if (!unsubscribe) throw new Error(`The stream replay store lost stream '${streamId}'`);
    producer.attach();
    producer.follow(
      new Follower(this.store, streamId, owner.threadId, 0, subscription, unsubscribe, () =>
        producer.detach()
      )
    );
    return producer;
  }

  /**
   * Starts a streamed agent run or resume on a new stream, and returns it for the client that
   * asked. The run belongs to the stream from then on: it ends with `finish`, or `error` when
   * it fails, also when it was stopped (`STREAM_ABORTED`).
   *
   * @throws what the store threw when it could not create the stream, before anything was sent
   */
  async startAgentRun(options: ResumableAgentRunOptions): Promise<StreamFollower> {
    const stream = await this.open({
      userId: options.userId,
      threadId: options.threadId ?? createThreadId(),
      signal: options.signal,
    });
    const producer = this.producers.get(stream.streamId);
    const session = new AgentStreamSession((event) => stream.emit(event), {
      threadId: stream.threadId,
    });
    void (async () => {
      try {
        session.start();
        session.complete(await options.execute(session, stream.signal));
      } catch (error) {
        if (stream.signal.aborted) {
          session.fail(producer?.stopReason() ?? 'The run was stopped', STREAM_ABORTED);
        } else {
          const described = options.describeError(error);
          session.fail(described.message, described.code);
        }
      } finally {
        await stream.end();
      }
    })();
    return stream;
  }

  /**
   * Attaches a client to the stream of `lastEventId`, after that event: `400 INVALID_INPUT`
   * for an id that is not `<streamId>:<seq>`, `404 STREAM_NOT_FOUND` for a stream the store
   * does not keep, one another user started (or a user's, for an anonymous caller) or an
   * event it never sent.
   */
  async reconnect(lastEventId: string, userId: string | undefined): Promise<StreamReconnection> {
    const id = parseStreamEventId(lastEventId);
    if (!id) return { ok: false, error: invalidLastEventId() };
    const subscription = new Subscription();
    const unsubscribe = await this.store.subscribe(id.streamId, subscription);
    if (!unsubscribe) return { ok: false, error: streamNotFound() };
    const record = await this.store.get(id.streamId).catch(async (error: unknown) => {
      await unsubscribe();
      throw error;
    });
    if (!record || record.userId !== userId || id.seq > record.lastSeq) {
      await unsubscribe();
      return { ok: false, error: streamNotFound() };
    }
    const producer = this.producers.get(id.streamId);
    producer?.attach();
    return {
      ok: true,
      stream: new Follower(
        this.store,
        id.streamId,
        record.threadId,
        id.seq,
        subscription,
        unsubscribe,
        () => producer?.detach()
      ),
    };
  }
}
