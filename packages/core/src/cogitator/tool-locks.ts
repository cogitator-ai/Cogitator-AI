import { AsyncLocalStorage } from 'node:async_hooks';
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

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();

/**
 * The lock keys the tool calls this code runs inside hold: a run started from a tool, and its own
 * tool calls, run inside the call that started it. Such a call takes again a key its caller holds
 * without waiting, else it would wait for the call that waits for it.
 */
export function heldLockKeys(): ReadonlySet<string> {
  return held.getStore() ?? NONE;
}

/** Runs `run` as code inside a tool call that holds `keys`, on top of the keys held already */
export function holdingLockKeys<T>(keys: readonly string[], run: () => T): T {
  if (keys.length === 0) return run();
  return held.run(new Set([...heldLockKeys(), ...keys]), run);
}

/**
 * Who runs among the calls of one step that the run started together: each takes a share, and a
 * call that turned out not to be safe after all (a middleware changed its arguments) takes the
 * step alone, once the calls running finish. Calls go in the order they asked, so one that waits
 * to be alone holds back the calls after it, and it never waits on one that waits for it.
 */
export class StepGate {
  private sharing = 0;
  private alone = false;
  private readonly waiting: Array<{ alone: boolean; enter: () => void }> = [];

  /** Waits for a share of the step, alongside the other calls that share it */
  share(signal?: AbortSignal): Promise<() => void> {
    return this.enter(false, signal);
  }

  /** Waits until no other call runs, then has the step alone */
  exclusive(signal?: AbortSignal): Promise<() => void> {
    return this.enter(true, signal);
  }

  private enter(alone: boolean, signal?: AbortSignal): Promise<() => void> {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      if (alone) this.alone = false;
      else this.sharing--;
      this.pump();
    };
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(toAbortError(signal.reason, 'Tool call aborted'));
        return;
      }
      const onAbort = () => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        this.pump();
        reject(toAbortError(signal?.reason, 'Tool call aborted'));
      };
      const waiter = {
        alone,
        enter: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(leave);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (this.waiting.length > 0 && !this.alone) {
      const next = this.waiting[0]!;
      if (next.alone) {
        if (this.sharing > 0) return;
        this.alone = true;
      } else {
        this.sharing++;
      }
      this.waiting.shift();
      next.enter();
    }
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(toAbortError(signal.reason, 'Tool call aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal.reason, 'Tool call aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
