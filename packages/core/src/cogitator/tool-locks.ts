import { toAbortError } from '../utils/abort';

/**
 * Locks named by keys, such as the real path of a file, that tool calls hold while they run.
 * Calls whose keys meet go one after another in the order they asked. A call takes its place in
 * the queue of every one of its keys at once, so two calls never wait on each other.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Waits until no call that asked before holds any of `keys`, then holds them until the returned
   * release is called. A `signal` that aborts while it waits gives up the place in the queues and
   * rejects with the abort reason.
   */
  async acquire(keys: readonly string[], signal?: AbortSignal): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = [...new Set(keys)].map((key) => {
      const previous = this.tails.get(key) ?? Promise.resolve();
      const mine = previous.then(() => held);
      this.tails.set(key, mine);
      void mine.then(() => {
        if (this.tails.get(key) === mine) this.tails.delete(key);
      });
      return previous;
    });
    try {
      await untilAborted(Promise.all(before), signal);
    } catch (error) {
      release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /** How many keys some call holds or waits for */
  get size(): number {
    return this.tails.size;
  }
}

/** The locks tool calls of every run of the process share: a file is one, whoever writes it */
export const toolLocks = new KeyedLock();

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(toAbortError(signal.reason, 'Tool call aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal.reason, 'Tool call aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
