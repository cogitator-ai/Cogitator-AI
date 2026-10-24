import { AsyncLocalStorage } from 'node:async_hooks';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { toAbortError } from '../utils/abort';

/**
 * Who holds or waits for lock keys: a tool call, inside the call that started it when a tool
 * runs another agent or `invokeTool()`
 */
export interface LockOwner {
  readonly parent?: LockOwner;
}

/** A call that would wait on calls that wait on it, through its own keys: it fails at once */
export class LockCycleError extends CogitatorError {
  constructor(keys: readonly string[]) {
    super({
      message: `Waiting for ${keys.join(', ')} would never end: a call that holds it waits for a key this call or a call it runs inside holds`,
      code: ErrorCode.TOOL_LOCK_CYCLE,
      details: { keys: [...keys] },
    });
    this.name = 'LockCycleError';
  }
}

interface LockEntry {
  readonly owner: LockOwner;
  readonly keys: readonly string[];
  granted: boolean;
  grant: () => void;
}

/**
 * Locks named by keys, such as the real path of a file, that tool calls hold while they run.
 * Calls whose keys meet go one after another in the order they asked. A call takes its place in
 * the queue of every one of its keys at once, so calls that only wait for keys never wait on each
 * other. A call that holds keys and, through a tool it runs, waits for a key held by a call that
 * waits for one of its own keys fails with {@link LockCycleError} instead of waiting forever.
 */
export class KeyedLock {
  private readonly queues = new Map<string, LockEntry[]>();

  /**
   * Waits until no call that asked before holds any of `keys`, then holds them until the returned
   * release is called. A `signal` that aborts while it waits gives up the place in the queues and
   * rejects with the abort reason. `owner` is the call that asks, `{}` by default
   *
   * @throws LockCycleError when the wait would never end
   */
  async acquire(
    keys: readonly string[],
    signal?: AbortSignal,
    owner: LockOwner = {}
  ): Promise<() => void> {
    const unique = [...new Set(keys)];
    let grant!: () => void;
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const entry: LockEntry = { owner, keys: unique, granted: false, grant };
    const ahead = unique.flatMap((key) => this.queues.get(key) ?? []);
    if (this.closesCycle(owner, ahead)) throw new LockCycleError(unique);
    for (const key of unique) {
      const queue = this.queues.get(key) ?? [];
      queue.push(entry);
      this.queues.set(key, queue);
    }
    this.pump(entry);
    try {
      await untilAborted(granted, signal);
    } catch (error) {
      this.leave(entry);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leave(entry);
    };
  }

  /** How many keys some call holds or waits for */
  get size(): number {
    return this.queues.size;
  }

  /**
   * Whether `owner` waiting behind `ahead` would never end: one of them, or a call run inside one,
   * waits (through others like it) for `owner` or a call `owner` runs inside
   */
  private closesCycle(owner: LockOwner, ahead: readonly LockEntry[]): boolean {
    const lineage = new Set<LockOwner>();
    for (let at: LockOwner | undefined = owner; at; at = at.parent) lineage.add(at);
    const waiting = [...new Set([...this.queues.values()].flat())].filter((item) => !item.granted);
    const seen = new Set<LockOwner>();
    const stack = ahead.map((item) => item.owner);
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (lineage.has(next)) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const item of waiting) {
        if (!runsInside(item.owner, next)) continue;
        for (const key of item.keys) {
          for (const before of this.queues.get(key) ?? []) {
            if (before === item) break;
            stack.push(before.owner);
          }
        }
      }
    }
    return false;
  }

  private pump(entry: LockEntry): void {
    if (entry.granted) return;
    if (entry.keys.every((key) => this.queues.get(key)?.[0] === entry)) {
      entry.granted = true;
      entry.grant();
    }
  }

  private leave(entry: LockEntry): void {
    const heads: LockEntry[] = [];
    for (const key of entry.keys) {
      const queue = this.queues.get(key);
      if (!queue) continue;
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      if (queue.length === 0) this.queues.delete(key);
      else heads.push(queue[0]!);
    }
    for (const head of heads) this.pump(head);
  }
}

/** Whether `owner` is `outer` or a call run inside it */
function runsInside(owner: LockOwner, outer: LockOwner): boolean {
  for (let at: LockOwner | undefined = owner; at; at = at.parent) if (at === outer) return true;
  return false;
}

/** The locks tool calls of every run of the process share: a file is one, whoever writes it */
export const toolLocks = new KeyedLock();

interface HeldLocks {
  readonly keys: ReadonlySet<string>;
  readonly owner?: LockOwner;
}

const held = new AsyncLocalStorage<HeldLocks>();
const NONE: ReadonlySet<string> = new Set();

/**
 * The lock keys the tool calls this code runs inside hold: a run started from a tool, and its own
 * tool calls, run inside the call that started it. Such a call takes again a key its caller holds
 * without waiting, else it would wait for the call that waits for it.
 */
export function heldLockKeys(): ReadonlySet<string> {
  return held.getStore()?.keys ?? NONE;
}

/** The call this code runs inside, as a {@link LockOwner}, if any */
export function currentLockOwner(): LockOwner | undefined {
  return held.getStore()?.owner;
}

/** Runs `run` as code inside the tool call `owner` that holds `keys`, on top of the keys held already */
export function holdingLockKeys<T>(owner: LockOwner, keys: readonly string[], run: () => T): T {
  return held.run({ keys: new Set([...heldLockKeys(), ...keys]), owner }, run);
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
