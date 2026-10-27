import { AsyncLocalStorage } from 'node:async_hooks';
import { CogitatorError, ErrorCode, type MultitaskStrategy } from '@cogitator-ai/types';

/** The runs whose tool calls the code runs inside, outermost first, see {@link insideToolOf} */
const toolOfRun = new AsyncLocalStorage<readonly string[]>();

/** Runs `work` as a tool call of run `runId`: runs it starts count as started inside that run */
export function insideToolOf<T>(runId: string, work: () => T): T {
  return toolOfRun.run([...(toolOfRun.getStore() ?? []), runId], work);
}

/** The runs whose tool calls the code runs inside, outermost first, none outside a tool */
export function currentToolRuns(): readonly string[] {
  return toolOfRun.getStore() ?? [];
}

/** A run's place on its thread, from its admission until it is done */
export interface ThreadSeat {
  /** Aborts when a newer run on the thread interrupts this one */
  readonly signal: AbortSignal;
  /** The run's id, once it started: runs started from its tool calls are not held back */
  runId?: string;
  /** The user the run acts for */
  readonly userId?: string;
  /** The entry the run's first entry went after, once it wrote one (null at the thread's root) */
  branchPoint?: () => string | null | undefined;
}

/** A run asking for a seat on its thread */
export interface RunOnThread {
  readonly strategy: MultitaskStrategy | undefined;
  /** Waiting ends when it aborts, and a run whose signal aborted already changes nothing */
  readonly signal: AbortSignal | undefined;
  /**
   * The runs whose tool calls start this one, its ancestors ({@link currentToolRuns}): a run
   * started from a tool of one of the thread's runs, or of a run that one started, is not held
   * back, it would wait for its own ancestor
   */
  readonly ancestorRunIds: readonly string[];
  readonly userId: string | undefined;
  /** The run may use a thread of other users (`threadAccess: 'shared'`) */
  readonly shared: boolean;
}

/** What a run admitted on its thread gets: its seat, and where to branch from on a rollback */
export interface ThreadAdmission {
  readonly seat: ThreadSeat;
  /** The entry the interrupted run started after, for a `rollback`, when that run wrote anything */
  readonly rollbackTo?: string | null;
  /** Frees the seat, once the run is done */
  release(): void;
}

interface Seat extends ThreadSeat {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  finish(): void;
}

/**
 * The runs going on in each thread of a runtime, oldest first, so a new run on a thread follows
 * its `MultitaskStrategy`. A run without a strategy takes a seat too, so a later run with one
 * sees it, but waits for nobody. A run started inside a run of its thread (its trace) is not
 * seated, it would wait for itself.
 */
export class ThreadRuns {
  private readonly threads = new Map<string, Seat[]>();

  /**
   * Seats a run on `threadId`, once `strategy` lets it: `enqueue` waits for the runs before it,
   * `reject` fails while there are any, `interrupt` and `rollback` abort them and wait until they
   * are done. Undefined for a run a tool of one of the thread's runs starts, which goes on
   * unseated. Waiting ends with the run's own `signal`. Before anything changes, a run whose
   * signal aborted fails, and a run with a strategy fails with `THREAD_ACCESS_DENIED` while a
   * run of another user goes on in the thread, unless it may use shared threads
   */
  async admit(threadId: string, run: RunOnThread): Promise<ThreadAdmission | undefined> {
    const { strategy, signal, ancestorRunIds, userId } = run;
    if (signal?.aborted) throw abortReason(signal);
    const seats = this.threads.get(threadId) ?? [];
    if (seats.some((seat) => seat.runId !== undefined && ancestorRunIds.includes(seat.runId))) {
      return undefined;
    }
    if (strategy !== undefined && !run.shared && seats.some((seat) => seat.userId !== userId)) {
      throw new CogitatorError({
        message: `Thread ${threadId} belongs to another user`,
        code: ErrorCode.THREAD_ACCESS_DENIED,
      });
    }
    if (strategy === 'reject' && seats.length > 0) {
      throw new CogitatorError({
        message: `Thread ${threadId} has a run going on`,
        code: ErrorCode.THREAD_BUSY,
        details: { threadId },
      });
    }

    const ahead = [...seats];
    const seat = createSeat(userId);
    seats.push(seat);
    this.threads.set(threadId, seats);
    const release = () => {
      seat.finish();
      const current = this.threads.get(threadId);
      if (!current) return;
      const index = current.indexOf(seat);
      if (index !== -1) current.splice(index, 1);
      if (current.length === 0) this.threads.delete(threadId);
    };

    try {
      if (strategy === 'interrupt' || strategy === 'rollback') {
        for (const earlier of ahead) {
          earlier.controller.abort(
            new CogitatorError({
              message: `A newer run on thread ${threadId} interrupted this run`,
              code: ErrorCode.RUN_INTERRUPTED,
              details: { threadId },
            })
          );
        }
      }
      if (strategy !== undefined) await settled(ahead, signal, seat.signal);
      const interrupted = strategy === 'rollback' ? ahead[0] : undefined;
      const rollbackTo = interrupted?.branchPoint?.();
      return { seat, ...(rollbackTo !== undefined && { rollbackTo }), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** The ids of the runs going on in `threadId` (a run not started yet has none), oldest first */
  active(threadId: string): { count: number; runIds: string[] } {
    const seats = this.threads.get(threadId) ?? [];
    return {
      count: seats.length,
      runIds: seats.flatMap((seat) => (seat.runId === undefined ? [] : [seat.runId])),
    };
  }

  /**
   * Aborts every run going on in `threadId` with `reason` and resolves once they are all done, so
   * what changes the thread next does not race them
   */
  async interrupt(threadId: string, reason: Error): Promise<string[]> {
    const seats = [...(this.threads.get(threadId) ?? [])];
    for (const seat of seats) seat.controller.abort(reason);
    await Promise.all(seats.map((seat) => seat.done));
    return seats.flatMap((seat) => (seat.runId === undefined ? [] : [seat.runId]));
  }
}

function createSeat(userId: string | undefined): Seat {
  const controller = new AbortController();
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    controller,
    signal: controller.signal,
    done,
    finish,
    ...(userId !== undefined && { userId }),
  };
}

/** Resolves once every seat in `seats` is done, rejects when one of `signals` aborts first */
function settled(seats: readonly Seat[], ...signals: (AbortSignal | undefined)[]): Promise<void> {
  const watched = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const aborted = watched.find((signal) => signal.aborted);
  if (aborted) return Promise.reject(abortReason(aborted));
  if (seats.length === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const listeners = watched.map((signal) => {
      const listener = () => {
        cleanup();
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', listener, { once: true });
      return { signal, listener };
    });
    const cleanup = () => {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    };
    void Promise.all(seats.map((seat) => seat.done)).then(() => {
      cleanup();
      resolve();
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(reason === undefined ? 'Run aborted' : String(reason));
}
