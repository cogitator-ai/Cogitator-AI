import type { StreamEvent } from './protocol.js';

/** Who a stream belongs to: the caller who started its run, and the run's thread */
export interface StreamOwner {
  /**
   * The key of the caller who started the run, which a caller must match to reconnect to the
   * stream or cancel its run. Absent for an anonymous caller
   */
  owner?: string;
  threadId: string;
}

/** A stream as a store creates it */
export interface NewStreamRecord extends StreamOwner {
  id: string;
  /** When the run started, in ms since the epoch */
  createdAt: number;
}

/** A stream as a store keeps it */
export interface StreamRecord extends NewStreamRecord {
  /** When the stream finished, absent while its run goes on */
  finishedAt?: number;
  /** The sequence number of the last event appended, `0` before the first */
  lastSeq: number;
  /** Subscriptions open on the stream, across every process that shares the store */
  subscribers: number;
  /**
   * When the last subscription of the stream ended, on any process, in ms since the epoch.
   * Absent while one is open. The run of the stream counts its detached time from it, so a
   * client that came and went on another process restarts the count. A store that does not
   * keep it lets the run count from when its own clients left
   */
  detachedAt?: number;
}

/** One event of a stream with its sequence number: `1` for the first, one more for each next */
export interface StoredStreamEvent {
  seq: number;
  event: StreamEvent;
}

/** The events of a stream after a sequence number */
export interface StreamReplay {
  /** The events kept after the sequence number, in order */
  events: StoredStreamEvent[];
  /** Some events after the sequence number were evicted, so `events` does not follow on from it */
  gap: boolean;
  /** The stream finished: nothing will follow `events` */
  finished: boolean;
}

/** Receives the events appended to a stream after it subscribed, and the end of the stream */
export interface StreamSubscriber {
  event(entry: StoredStreamEvent): void;
  /** The stream finished, or the store dropped it */
  end(): void;
}

/**
 * Where resumable streams keep their events, so a client that lost its connection can
 * replay what it missed and follow the rest of the run.
 *
 * A store shared by several processes (Redis or a database with pub/sub) lets a client
 * reconnect to any of them: the process that answers the reconnect replays the events with
 * {@link read} and follows the live ones with {@link subscribe}, while the run goes on in the
 * process that started it. {@link subscribe} and {@link onCancel} must then reach listeners on
 * every process, which takes pub/sub (Redis `PUBLISH`/`SUBSCRIBE` or similar), and
 * `subscribers` and `detachedAt` of {@link StreamRecord} must cover the subscriptions of every
 * process, which the run reads to tell whether any client is still attached and since when no
 * client is. Events must reach a subscriber
 * in the order of their sequence numbers. A follower that sees a sequence number skipped reads
 * the store again, and reports the events it cannot find as lost.
 */
export interface StreamReplayStore {
  /**
   * Creates a stream with no events. `false` when the store keeps as many streams as it may
   * and none of them finished, so it has no room without cutting off a run that goes on
   */
  create(stream: NewStreamRecord): Promise<boolean>;
  /**
   * Appends an event. Its `seq` is one more than the last one appended. A stream the store
   * does not know (any more) or that finished takes nothing.
   */
  append(streamId: string, entry: StoredStreamEvent): Promise<void>;
  /** The events after `afterSeq`, `undefined` for a stream the store does not know (any more) */
  read(streamId: string, afterSeq: number): Promise<StreamReplay | undefined>;
  /** Marks the stream finished and ends its subscriptions */
  finish(streamId: string): Promise<void>;
  /** The stream, `undefined` when the store does not know it (any more) */
  get(streamId: string): Promise<StreamRecord | undefined>;
  /**
   * Hands `subscriber` every event appended from now on, until the stream ends or the
   * returned function is called. `undefined` for a stream the store does not know (any more).
   */
  subscribe(
    streamId: string,
    subscriber: StreamSubscriber
  ): Promise<(() => Promise<void>) | undefined>;
  /** Asks the process that runs the stream's run to stop it, a stream that finished ignores it */
  cancel(streamId: string): Promise<void>;
  /**
   * Calls `listener` once a cancel is asked for the stream, from any process, also when it was
   * asked before. `undefined` for a stream the store does not know (any more)
   */
  onCancel(streamId: string, listener: () => void): Promise<(() => Promise<void>) | undefined>;
}

/** Default of `maxEvents`: the events kept of each stream */
export const DEFAULT_STREAM_MAX_EVENTS = 1000;
/** Default of `retentionMs`: how long a finished stream is kept, 5 minutes */
export const DEFAULT_STREAM_RETENTION_MS = 5 * 60_000;
/** Default of `maxStreams`: the streams kept at once */
export const DEFAULT_STREAM_MAX_STREAMS = 1000;

export interface InMemoryStreamReplayStoreOptions {
  /**
   * Events kept of each stream. Past it the oldest are evicted, and a client that reconnects
   * after an evicted event is told to fetch the thread instead. Default: 1000.
   */
  maxEvents?: number;
  /** How long a finished stream stays replayable, in ms. Default: 5 minutes */
  retentionMs?: number;
  /**
   * Streams kept at once. A new stream past it evicts the stream that finished first. When
   * every stream kept is still going, the new one is refused. Default: 1000.
   */
  maxStreams?: number;
  /** The clock, in ms since the epoch. Default: `Date.now` */
  now?: () => number;
}

/** Checks a limit of the resumable streams: a positive whole number */
export function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number, got ${value}`);
  }
  return value;
}

/** The events of a stream, the newest `capacity` of them */
class EventRing {
  private readonly slots: StoredStreamEvent[] = [];
  private head = 0;

  constructor(private readonly capacity: number) {}

  /** Adds an event, and returns the one it evicted */
  push(entry: StoredStreamEvent): StoredStreamEvent | undefined {
    if (this.slots.length < this.capacity) {
      this.slots.push(entry);
      return undefined;
    }
    const evicted = this.slots[this.head];
    this.slots[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    return evicted;
  }

  after(seq: number): StoredStreamEvent[] {
    const ordered = [...this.slots.slice(this.head), ...this.slots.slice(0, this.head)];
    return ordered.filter((entry) => entry.seq > seq);
  }
}

interface KeptStream {
  record: NewStreamRecord & { finishedAt?: number };
  events: EventRing;
  lastSeq: number;
  /** The newest sequence number evicted, `0` while nothing was */
  evictedThrough: number;
  subscribers: Set<StreamSubscriber>;
  cancelled: boolean;
  cancelListeners: Set<() => void>;
  /** When the last subscription ended, absent while one is open */
  detachedAt?: number;
}

/**
 * Keeps resumable streams in the memory of one process, within bounds: `maxEvents` of each
 * stream, `maxStreams` streams (a stream whose run goes on is never evicted, a new one is
 * refused instead), a finished stream for `retentionMs`. It runs no timers:
 * expired streams are dropped as the store is used. Streams do not survive a restart and are
 * not shared between processes, use a store of your own for that (see
 * {@link StreamReplayStore}).
 */
export class InMemoryStreamReplayStore implements StreamReplayStore {
  private readonly maxEvents: number;
  private readonly retentionMs: number;
  private readonly maxStreams: number;
  private readonly now: () => number;
  private readonly streams = new Map<string, KeptStream>();
  /** The finished streams by the time they finished, oldest first */
  private readonly finished = new Map<string, number>();

  constructor(options: InMemoryStreamReplayStoreOptions = {}) {
    this.maxEvents = positiveLimit('maxEvents', options.maxEvents, DEFAULT_STREAM_MAX_EVENTS);
    this.retentionMs = positiveLimit(
      'retentionMs',
      options.retentionMs,
      DEFAULT_STREAM_RETENTION_MS
    );
    this.maxStreams = positiveLimit('maxStreams', options.maxStreams, DEFAULT_STREAM_MAX_STREAMS);
    this.now = options.now ?? Date.now;
  }

  create(stream: NewStreamRecord): Promise<boolean> {
    this.sweep();
    if (this.streams.has(stream.id)) {
      return Promise.reject(new Error(`Stream '${stream.id}' already exists`));
    }
    while (this.streams.size >= this.maxStreams) {
      const finished = this.finished.keys().next();
      if (finished.done) return Promise.resolve(false);
      this.drop(finished.value);
    }
    this.streams.set(stream.id, {
      record: { ...stream },
      events: new EventRing(this.maxEvents),
      lastSeq: 0,
      evictedThrough: 0,
      subscribers: new Set(),
      cancelled: false,
      cancelListeners: new Set(),
    });
    return Promise.resolve(true);
  }

  append(streamId: string, entry: StoredStreamEvent): Promise<void> {
    this.sweep();
    const stream = this.streams.get(streamId);
    if (!stream || stream.record.finishedAt !== undefined) return Promise.resolve();
    if (entry.seq !== stream.lastSeq + 1) {
      return Promise.reject(
        new RangeError(
          `Event ${entry.seq} of stream '${streamId}' does not follow ${stream.lastSeq}`
        )
      );
    }
    stream.lastSeq = entry.seq;
    const evicted = stream.events.push(entry);
    if (evicted) stream.evictedThrough = evicted.seq;
    for (const subscriber of [...stream.subscribers]) subscriber.event(entry);
    return Promise.resolve();
  }

  read(streamId: string, afterSeq: number): Promise<StreamReplay | undefined> {
    this.sweep();
    const stream = this.streams.get(streamId);
    if (!stream) return Promise.resolve(undefined);
    return Promise.resolve({
      events: stream.events.after(afterSeq),
      gap: afterSeq < stream.evictedThrough,
      finished: stream.record.finishedAt !== undefined,
    });
  }

  finish(streamId: string): Promise<void> {
    this.sweep();
    const stream = this.streams.get(streamId);
    if (!stream || stream.record.finishedAt !== undefined) return Promise.resolve();
    const finishedAt = this.now();
    stream.record.finishedAt = finishedAt;
    this.finished.set(streamId, finishedAt);
    this.endSubscriptions(stream);
    return Promise.resolve();
  }

  get(streamId: string): Promise<StreamRecord | undefined> {
    this.sweep();
    const stream = this.streams.get(streamId);
    return Promise.resolve(
      stream && {
        ...stream.record,
        lastSeq: stream.lastSeq,
        subscribers: stream.subscribers.size,
        ...(stream.detachedAt !== undefined && { detachedAt: stream.detachedAt }),
      }
    );
  }

  subscribe(
    streamId: string,
    subscriber: StreamSubscriber
  ): Promise<(() => Promise<void>) | undefined> {
    this.sweep();
    const stream = this.streams.get(streamId);
    if (!stream) return Promise.resolve(undefined);
    const own: StreamSubscriber = {
      event: (entry) => subscriber.event(entry),
      end: () => subscriber.end(),
    };
    stream.subscribers.add(own);
    stream.detachedAt = undefined;
    return Promise.resolve(() => {
      if (stream.subscribers.delete(own) && stream.subscribers.size === 0) {
        stream.detachedAt = this.now();
      }
      return Promise.resolve();
    });
  }

  cancel(streamId: string): Promise<void> {
    this.sweep();
    const stream = this.streams.get(streamId);
    if (!stream || stream.record.finishedAt !== undefined || stream.cancelled) {
      return Promise.resolve();
    }
    stream.cancelled = true;
    for (const listener of [...stream.cancelListeners]) listener();
    return Promise.resolve();
  }

  onCancel(streamId: string, listener: () => void): Promise<(() => Promise<void>) | undefined> {
    this.sweep();
    const stream = this.streams.get(streamId);
    if (!stream) return Promise.resolve(undefined);
    const own = () => listener();
    stream.cancelListeners.add(own);
    if (stream.cancelled) own();
    return Promise.resolve(() => {
      stream.cancelListeners.delete(own);
      return Promise.resolve();
    });
  }

  /** Drops the streams that finished longer than `retentionMs` ago */
  private sweep(): void {
    const expiredBefore = this.now() - this.retentionMs;
    for (const [streamId, finishedAt] of this.finished) {
      if (finishedAt > expiredBefore) break;
      this.drop(streamId);
    }
  }

  private drop(streamId: string): void {
    const stream = this.streams.get(streamId);
    this.streams.delete(streamId);
    this.finished.delete(streamId);
    if (!stream) return;
    stream.cancelListeners.clear();
    this.endSubscriptions(stream);
  }

  private endSubscriptions(stream: KeptStream): void {
    const subscribers = [...stream.subscribers];
    stream.subscribers.clear();
    for (const subscriber of subscribers) subscriber.end();
  }
}
