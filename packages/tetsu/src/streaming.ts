import type { ServerSentEvent } from '@tetsujs/sse';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import type { RunOptions } from '@cogitator-ai/types';
import type { ShutdownSignal } from './types.js';

/** The run options a streamed agent run or resume is given by its transport. */
export type AgentStreamCallbacks = Pick<
  RunOptions,
  'stream' | 'signal' | 'onToken' | 'onReasoning' | 'onToolCall' | 'onToolResult'
>;

/** The last event of every successful stream, kept for clients of the other Cogitator adapters. */
export const DONE_EVENT: ServerSentEvent = { data: '[DONE]' };

export function sseEvent(event: StreamEvent): ServerSentEvent {
  return { data: event };
}

export function resolveSignal(until: ShutdownSignal | undefined): AbortSignal | undefined {
  return typeof until === 'function' ? until() : until;
}

/**
 * A queue between callbacks that push events and a generator that pulls them.
 *
 * Callbacks of a run fire whenever the runtime gets there; the generator behind
 * `sse()` asks for one event at a time, as the client reads. The queue holds what
 * was pushed in between, and `end()` wakes a reader that is waiting.
 */
class EventQueue<T> {
  private readonly items: T[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  async *drain(): AsyncGenerator<T, void, undefined> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
      } else if (this.ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/**
 * Runs `task`, yielding every event it emits as soon as the reader asks for it.
 *
 * Ends when the task settles and its events are drained, rethrowing its error, or
 * at once when `signal` aborts: a task that was given the signal stops by itself,
 * and nobody is left to read what it would emit.
 */
export async function* eventsOf<T>(
  signal: AbortSignal,
  task: (emit: (event: T) => void) => Promise<void>
): AsyncGenerator<T, void, undefined> {
  const queue = new EventQueue<T>();
  const stop = () => queue.end();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();

  let failure: { error: unknown } | undefined;
  const settled = task((event) => queue.push(event)).then(
    () => queue.end(),
    (error: unknown) => {
      failure = { error };
      queue.end();
    }
  );

  try {
    yield* queue.drain();
    if (signal.aborted) return;
    await settled;
    if (failure) throw failure.error;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
