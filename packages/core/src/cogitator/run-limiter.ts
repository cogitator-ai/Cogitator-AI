/**
 * Caps how many runs execute at once; the rest wait in arrival order.
 *
 * A waiting run leaves the queue when its signal aborts, so a run timeout or a
 * caller's abort also covers the time spent waiting for a slot.
 */
export class RunLimiter {
  private active = 0;
  private readonly waiting: Array<{ resolve: () => void }> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`limits.maxConcurrentRuns must be a positive integer, got ${max}`);
    }
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /** Waits for a free slot and returns the function that frees it. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }

    await new Promise<void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Run aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });

    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.resolve();
      } else {
        this.active--;
      }
    };
  }
}
