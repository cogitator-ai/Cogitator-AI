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

interface Lane {
  /** The times requests were or will be sent, in ms, oldest first */
  stamps: number[];
  /** No request before this time, set after Teams throttled one */
  blockedUntil: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spaces the requests of each conversation so none of its windows takes more than its limit:
 * a request takes the earliest time every window has room, and waits until then. A throttled
 * request blocks its conversation for everyone until Teams says it may go on.
 */
export class ConversationPacer {
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly limits: readonly RateWindow[] = TEAMS_RATE_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly maxLanes = 1000
  ) {
    this.longest = Math.max(...limits.map((rate) => rate.window));
  }

  private readonly longest: number;

  /**
   * Waits for the next free slot of `key` and takes it. Slots are taken in order, so a request
   * never goes before one that asked earlier, and one whose conversation got blocked while it
   * waited takes a new slot after the block.
   */
  async acquire(key: string, priority: Priority = 'send'): Promise<void> {
    for (;;) {
      const at = this.reserve(key, priority);
      const wait = at - this.now();
      if (wait > 0) await sleep(wait);
      const lane = this.lane(key);
      if (this.now() >= lane.blockedUntil) return;
      const index = lane.stamps.indexOf(at);
      if (index >= 0) lane.stamps.splice(index, 1);
    }
  }

  /** Takes a slot of `key` only when one is free now, for requests better dropped than late. */
  tryAcquire(key: string, priority: Priority = 'background'): boolean {
    const lane = this.lane(key);
    const now = this.now();
    if (this.earliest(lane, now, priority) > now) return false;
    lane.stamps.push(now);
    return true;
  }

  /** Keeps every request of `key` back for `ms`, after Teams throttled one. */
  block(key: string, ms: number): void {
    const lane = this.lane(key);
    lane.blockedUntil = Math.max(lane.blockedUntil, this.now() + ms);
  }

  private reserve(key: string, priority: Priority): number {
    const lane = this.lane(key);
    const at = this.earliest(lane, this.now(), priority);
    lane.stamps.push(at);
    return at;
  }

  /**
   * The earliest time from `from`, and not before a slot already taken, at which every window
   * of the lane has room: when a window ending then holds its limit, the time moves past the
   * oldest request in it.
   */
  private earliest(lane: Lane, from: number, priority: Priority): number {
    while (lane.stamps.length > 0 && lane.stamps[0] <= from - this.longest) lane.stamps.shift();
    let at = Math.max(from, lane.blockedUntil, lane.stamps.at(-1) ?? from);
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
          at = lane.stamps[lane.stamps.length - limit] + rate.window;
          moved = true;
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
      lane = { stamps: [], blockedUntil: 0 };
    }
    this.lanes.set(key, lane);
    while (this.lanes.size > this.maxLanes) {
      const oldest = this.lanes.keys().next().value;
      if (oldest === undefined) break;
      this.lanes.delete(oldest);
    }
    return lane;
  }
}
