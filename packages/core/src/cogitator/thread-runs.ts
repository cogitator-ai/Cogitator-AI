import { CogitatorError, ErrorCode, type MultitaskStrategy } from '@cogitator-ai/types';

/** A run's place on its thread, from its admission until it is done */
export interface ThreadSeat {
  /** Aborts when a newer run on the thread interrupts this one */
  readonly signal: AbortSignal;
  /** The trace the run belongs to, once it started: runs started inside it are not held back */
  traceId?: string;
  /** The entry the run's first entry went after, once it wrote one (null at the thread's root) */
  branchPoint?: () => string | null | undefined;
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
   * are done. Undefined for a run inside one of the thread's runs (`traceId`), which goes on
   * unseated. Waiting ends with the run's own `signal`.
   */
  async admit(
    threadId: string,
    strategy: MultitaskStrategy | undefined,
    signal: AbortSignal | undefined,
    traceId: string | undefined
  ): Promise<ThreadAdmission | undefined> {
    const seats = this.threads.get(threadId) ?? [];
    if (traceId !== undefined && seats.some((seat) => seat.traceId === traceId)) return undefined;
    if (strategy === 'reject' && seats.length > 0) {
      throw new CogitatorError({
        message: `Thread ${threadId} has a run going on`,
        code: ErrorCode.THREAD_BUSY,
        details: { threadId },
      });
    }

    const ahead = [...seats];
    const seat = createSeat();
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
}

function createSeat(): Seat {
  const controller = new AbortController();
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { controller, signal: controller.signal, done, finish };
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
