/**
 * The one way the runtime takes due timers from a `TimerStore`: poll `getOverdue()`, confirm the
 * claim on each before it runs, renew it while it runs and give back what it will not run. The
 * scheduler of routines, `HeartbeatScheduler` of channels and `TimerManager` of workflows all go
 * through it, so a store that claims timers works the same under each
 */

import type { TimerEntry, TimerStore } from '@cogitator-ai/types';

/** Who hears what happened to a claim */
export interface TimerClaimListeners {
  onError?: (error: Error, entry?: TimerEntry) => void;
  /**
   * The store says this worker no longer holds the claim on a timer: before it runs (it is then
   * skipped, another worker has it) or while it runs (its lease ran out before a renewal got
   * through, so another worker may run it too)
   */
  onClaimLost?: (entry: TimerEntry) => void;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Experimental. The claims of a worker on the timers of a store. With a store that does not
 * claim (no `renew` or `claimTtl`) every timer counts as held and nothing is renewed or released
 */
export class experimental_TimerClaims {
  constructor(
    readonly store: TimerStore,
    private readonly listeners: TimerClaimListeners = {}
  ) {}

  /** Whether the store claims timers */
  get claiming(): boolean {
    return Boolean(this.store.renew && this.store.claimTtl);
  }

  /**
   * Renews the claim right before the timer runs: false when the claim is gone (another worker
   * took the timer) or could not be renewed, and the timer must not run
   */
  async confirm(entry: TimerEntry): Promise<boolean> {
    const store = this.store;
    if (!store.renew || !store.claimTtl) return true;
    try {
      if (await store.renew(entry.id)) return true;
      this.listeners.onClaimLost?.(entry);
    } catch (error) {
      this.listeners.onError?.(toError(error), entry);
    }
    return false;
  }

  /**
   * Renews the claim every `claimTtl / 3` until the returned function is called, which resolves
   * once no renewal is in flight. `lost` aborts when the claim is lost meanwhile
   */
  keep(entry: TimerEntry, lost?: AbortController): () => Promise<void> {
    const store = this.store;
    const renew = store.renew;
    if (!renew || !store.claimTtl) return async () => undefined;

    let gone = false;
    let renewal: Promise<void> = Promise.resolve();
    const tick = async (): Promise<void> => {
      if (gone) return;
      try {
        if (await renew.call(store, entry.id)) return;
        gone = true;
        clearInterval(interval);
        this.listeners.onClaimLost?.(entry);
        lost?.abort(new Error(`The claim on timer ${entry.id} was lost`));
      } catch (error) {
        this.listeners.onError?.(toError(error), entry);
      }
    };
    const interval = setInterval(() => {
      renewal = renewal.then(tick);
    }, store.claimTtl / 3);

    return async () => {
      clearInterval(interval);
      await renewal;
    };
  }

  /** Gives the claim back so another worker can take the timer at once */
  async release(entry: TimerEntry): Promise<void> {
    try {
      await this.store.release?.(entry.id);
    } catch (error) {
      this.listeners.onError?.(toError(error), entry);
    }
  }
}

/** Options of {@link experimental_TimerPoller} */
export interface TimerPollerOptions extends TimerClaimListeners {
  store: TimerStore;
  /** What runs a due timer. Its errors go to `onError`, the poll goes on */
  process: (entry: TimerEntry, claims: experimental_TimerClaims) => Promise<void>;
  /** Timers this poller runs, the others are given back at once. Default: all */
  accepts?: (entry: TimerEntry) => boolean;
  /** How often the store is polled, ms (default 1000) */
  pollInterval?: number;
  /** Most timers run per poll, the rest are given back (default: all) */
  batchSize?: number;
  /** The first poll waits a random time up to this, ms, so workers started together spread out */
  staggerMs?: number;
  /** Runs after each poll, such as a cleanup */
  afterPoll?: () => Promise<void>;
  /** Whether `start()` polls at once (default) or first after `pollInterval` */
  immediate?: boolean;
}

/**
 * Experimental. Polls a store for due timers and runs each through `process`, one after another,
 * under the claim logic of {@link experimental_TimerClaims}. A poll does not start while the last
 * one runs. Timers it took but will not run (past `batchSize`, not accepted, or left when it
 * stops) are given back
 */
export class experimental_TimerPoller {
  readonly claims: experimental_TimerClaims;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stagger: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<number> | null = null;
  private running = false;

  constructor(private readonly options: TimerPollerOptions) {
    this.claims = new experimental_TimerClaims(options.store, options);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Polls now and then every `pollInterval`, after the stagger */
  start(): void {
    if (this.running) return;
    this.running = true;
    const staggerMs = this.options.staggerMs
      ? Math.floor(Math.random() * this.options.staggerMs)
      : 0;
    const begin = (): void => {
      this.stagger = null;
      if (!this.running) return;
      if (this.options.immediate !== false) void this.poll();
      this.interval = setInterval(() => void this.poll(), this.options.pollInterval ?? 1000);
    };
    if (staggerMs > 0) this.stagger = setTimeout(begin, staggerMs);
    else begin();
  }

  /** Stops polling. Resolves once the poll going on is done */
  async stop(): Promise<void> {
    this.running = false;
    if (this.stagger) {
      clearTimeout(this.stagger);
      this.stagger = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.current?.catch(() => undefined);
  }

  /**
   * One poll: runs the due timers it takes and resolves with how many ran. Called while stopped it
   * runs them too (the timers due now, on request); while the poller stops it gives them back
   */
  poll(): Promise<number> {
    if (this.current) return Promise.resolve(0);
    const manual = !this.running;
    const work = this.pollOnce(manual).finally(() => {
      this.current = null;
    });
    this.current = work;
    return work;
  }

  private async pollOnce(manual: boolean): Promise<number> {
    const { store, accepts, batchSize, onError } = this.options;
    let ran = 0;
    try {
      const overdue = await store.getOverdue();
      const limit = batchSize ?? overdue.length;
      for (const [index, entry] of overdue.entries()) {
        if (index >= limit || (!manual && !this.running) || (accepts && !accepts(entry))) {
          await this.claims.release(entry);
          continue;
        }
        try {
          await this.options.process(entry, this.claims);
          ran++;
        } catch (error) {
          onError?.(toError(error), entry);
        }
      }
      await this.options.afterPoll?.();
    } catch (error) {
      onError?.(toError(error));
    }
    return ran;
  }
}
