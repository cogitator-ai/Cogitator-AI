/** A limit of requests in a window of time: at most `limit` in any `window` ms. */
export interface RateWindow {
  limit: number;
  window: number;
}

/** The limits Teams puts on a bot in one conversation. */
export const TEAMS_RATE_LIMITS: readonly RateWindow[] = [
  { limit: 7, window: 1000 },
  { limit: 8, window: 2000 },
  { limit: 60, window: 30_000 },
  { limit: 1800, window: 3_600_000 },
];

/**
 * How much of each limit requests that can wait or be dropped may use, such as edits of a
 * streamed answer and typing indicators, so new messages always find room.
 */
const BACKGROUND_SHARE = 0.75;

export type Priority = 'send' | 'background';

interface Waiter {
  priority: Priority;
  resolve: () => void;
  reject: (reason: Error) => void;
}

interface Lane {
  /** The times requests went out, in ms, oldest first */
  stamps: number[];
  /** No request before this time, set after Teams throttled one */
  blockedUntil: number;
  /** Requests waiting for a slot, in the order they asked */
  queue: Waiter[];
  timer?: ReturnType<typeof setTimeout>;
}

/** The reason a wait ends with when its signal aborts. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The wait was aborted');
}

/**
 * Waits `ms`, or rejects when `signal` aborts. The timer does not keep the process alive.
 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    timer.unref?.();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : new Error('The wait was aborted'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Spaces the requests of each conversation so none of its windows takes more than its limit.
 * Requests wait in a queue and a slot is only taken when a request goes, never booked ahead:
 * whenever the windows have room, the first waiting request whose limit has room goes. Those of
 * one priority go in the order they asked, and a new message goes ahead of edits and typing
 * that wait for their smaller share. A throttled request blocks its conversation for everyone
 * until Teams says it may go on, and the queue keeps its order through the block.
 */
export class ConversationPacer {
  private readonly lanes = new Map<string, Lane>();
  private readonly longest: number;

  constructor(
    private readonly limits: readonly RateWindow[] = TEAMS_RATE_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly maxLanes = 1000
  ) {
    this.longest = Math.max(...limits.map((rate) => rate.window));
  }

  /** Waits for a slot of `key` and takes it, or rejects when `signal` aborts. */
  acquire(key: string, priority: Priority = 'send', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const lane = this.lane(key);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        resolve: () => {
          signal?.removeEventListener('abort', aborted);
          resolve();
        },
        reject,
      };
      const aborted = () => {
        const index = lane.queue.indexOf(waiter);
        if (index >= 0) lane.queue.splice(index, 1);
        if (signal) reject(abortReason(signal));
        this.pump(lane);
      };
      signal?.addEventListener('abort', aborted, { once: true });
      lane.queue.push(waiter);
      this.pump(lane);
    });
  }

  /**
   * Takes a slot of `key` only when one is free now and nobody waits for one, for requests
   * better dropped than late.
   */
  tryAcquire(key: string, priority: Priority = 'background'): boolean {
    const lane = this.lane(key);
    const now = this.now();
    if (lane.queue.length > 0 || this.earliest(lane, now, priority) > now) return false;
    lane.stamps.push(now);
    return true;
  }

  /** Keeps every request of `key` back for `ms`, after Teams throttled one. */
  block(key: string, ms: number): void {
    const lane = this.lane(key);
    lane.blockedUntil = Math.max(lane.blockedUntil, this.now() + ms);
    this.pump(lane);
  }

  /** Lets go every waiting request whose limit has room now, and wakes up when the next will. */
  private pump(lane: Lane): void {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = undefined;
    const now = this.now();
    for (let granted = true; granted;) {
      granted = false;
      for (const [index, waiter] of lane.queue.entries()) {
        if (this.earliest(lane, now, waiter.priority) > now) continue;
        lane.queue.splice(index, 1);
        lane.stamps.push(now);
        waiter.resolve();
        granted = true;
        break;
      }
    }
    if (lane.queue.length === 0) return;
    const next = Math.min(...lane.queue.map((waiter) => this.earliest(lane, now, waiter.priority)));
    lane.timer = setTimeout(() => this.pump(lane), Math.max(1, next - now));
    lane.timer.unref?.();
  }

  /**
   * The earliest time from `from` at which every window of the lane has room for a request of
   * `priority`: when a window ending then holds its limit, the time moves past the oldest
   * request in it.
   */
  private earliest(lane: Lane, from: number, priority: Priority): number {
    while (lane.stamps.length > 0 && lane.stamps[0] <= from - this.longest) lane.stamps.shift();
    let at = Math.max(from, lane.blockedUntil);
    for (let moved = true; moved;) {
      moved = false;
      for (const rate of this.limits) {
        const limit =
          priority === 'send' ? rate.limit : Math.max(1, Math.floor(rate.limit * BACKGROUND_SHARE));
        let inWindow = 0;
        for (let index = lane.stamps.length - 1; index >= 0; index--) {
          if (lane.stamps[index] <= at - rate.window) break;
          inWindow++;
        }
        if (inWindow >= limit) {
          const next = lane.stamps[lane.stamps.length - limit] + rate.window;
          if (next > at) {
            at = next;
            moved = true;
          }
        }
      }
    }
    return at;
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (lane) {
      this.lanes.delete(key);
    } else {
      lane = { stamps: [], blockedUntil: 0, queue: [] };
    }
    this.lanes.set(key, lane);
    for (const [oldKey, oldLane] of this.lanes) {
      if (this.lanes.size <= this.maxLanes) break;
      if (oldLane.queue.length > 0) continue;
      this.lanes.delete(oldKey);
    }
    return lane;
  }
}
