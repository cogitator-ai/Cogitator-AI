import type { ChannelMessage, QueueMode } from '@cogitator-ai/types';
import { mergeByDestination, replyDestination } from './merge-messages';

interface QueuedMessage {
  msg: ChannelMessage;
  settle: (handled: boolean) => void;
}

/** What a processor learns about the message it handles beyond its abort signal */
export interface MessageProcessing {
  /**
   * In `rollback` mode, the signal of the processing the message stopped, when that one got to
   * run: answer on a branch from where its run started
   */
  rollbackOf?: AbortSignal;
}

/**
 * Handles one message. It resolves `false` when the message was not handled (a failed or
 * aborted run), anything else counts as handled.
 */
export type MessageProcessor = (
  msg: ChannelMessage,
  signal?: AbortSignal,
  processing?: MessageProcessing
) => Promise<boolean | void>;

/** Hears of a message `reject` mode refused, its thread busy with another */
export type RejectedMessageListener = (msg: ChannelMessage, threadId: string) => void;

async function handled(processing: Promise<boolean | void>): Promise<boolean> {
  try {
    return (await processing) !== false;
  } catch {
    return false;
  }
}

interface ThreadState {
  processing: boolean;
  queue: QueuedMessage[];
  abortController?: AbortController;
  /** In `rollback` mode: what the latest processing is done with, and its signal once it ran */
  current?: Promise<unknown>;
  lastStarted?: AbortSignal;
}

export class MessageQueue {
  private threads = new Map<string, ThreadState>();

  constructor(
    private readonly mode: QueueMode,
    private readonly processor: MessageProcessor,
    private readonly onRejected?: RejectedMessageListener
  ) {}

  /**
   * Queues a message of a thread. The returned promise settles once the message is done with:
   * `true` once it is handled (alone or merged with others), `false` when its processing failed,
   * a newer message interrupted it or {@link dispose} dropped it. It never rejects.
   */
  push(msg: ChannelMessage, threadId: string): Promise<boolean> {
    switch (this.mode) {
      case 'parallel':
        return handled(this.processor(msg));
      case 'sequential':
      case 'enqueue':
        return this.enqueue(msg, threadId, (state) => this.drainSequential(threadId, state));
      case 'reject':
        return this.pushReject(msg, threadId);
      case 'interrupt':
        return this.pushInterrupt(msg, threadId);
      case 'rollback':
        return this.pushRollback(msg, threadId);
      case 'collect':
        return this.enqueue(msg, threadId, (state) => this.drainCollect(threadId, state));
    }
  }

  /** Aborts interruptible runs and drops every message still waiting, settling their promises */
  dispose(): void {
    for (const state of this.threads.values()) {
      state.abortController?.abort();
      for (const queued of state.queue.splice(0)) queued.settle(false);
    }
    this.threads.clear();
  }

  private getThread(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { processing: false, queue: [] };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private enqueue(
    msg: ChannelMessage,
    threadId: string,
    drain: (state: ThreadState) => Promise<void>
  ): Promise<boolean> {
    const state = this.getThread(threadId);
    const done = new Promise<boolean>((settle) => state.queue.push({ msg, settle }));
    if (!state.processing) void drain(state);
    return done;
  }

  private release(threadId: string, state: ThreadState): void {
    state.processing = false;
    if (state.queue.length === 0 && this.threads.get(threadId) === state) {
      this.threads.delete(threadId);
    }
  }

  private async drainSequential(threadId: string, state: ThreadState): Promise<void> {
    state.processing = true;
    let next = state.queue.shift();
    while (next) {
      next.settle(await handled(this.processor(next.msg)));
      next = state.queue.shift();
    }
    this.release(threadId, state);
  }

  private pushInterrupt(msg: ChannelMessage, threadId: string): Promise<boolean> {
    const state = this.getThread(threadId);

    if (state.processing && state.abortController) {
      state.abortController.abort();
    }

    for (const queued of state.queue.splice(0)) queued.settle(false);
    const ac = new AbortController();
    state.abortController = ac;
    state.processing = true;

    return handled(this.processor(msg, ac.signal)).then((done) => {
      if (state.abortController === ac) {
        state.abortController = undefined;
        this.release(threadId, state);
      }
      return done && !ac.signal.aborted;
    });
  }

  /** Whether `reject` mode refuses a message of `threadId` now: the thread handles another */
  refuses(threadId: string): boolean {
    return this.mode === 'reject' && this.threads.get(threadId)?.processing === true;
  }

  /**
   * Refuses the message while its thread handles another: it is not handled (`false`), and
   * `onRejected` hears of it
   */
  private pushReject(msg: ChannelMessage, threadId: string): Promise<boolean> {
    if (this.refuses(threadId)) {
      this.onRejected?.(msg, threadId);
      return Promise.resolve(false);
    }
    return this.enqueue(msg, threadId, (state) => this.drainSequential(threadId, state));
  }

  /**
   * Stops the processing going on and drops the messages waiting, as `interrupt` does, then waits
   * until the stopped processing is done and hands the message on with its signal
   * (`rollbackOf`), so the run goes on from where the stopped one started
   */
  private pushRollback(msg: ChannelMessage, threadId: string): Promise<boolean> {
    const state = this.getThread(threadId);
    state.abortController?.abort();
    for (const queued of state.queue.splice(0)) queued.settle(false);
    const ac = new AbortController();
    state.abortController = ac;
    state.processing = true;

    const before = state.current ?? Promise.resolve();
    const done = before.then(async () => {
      if (ac.signal.aborted) return false;
      const stopped = state.lastStarted?.aborted ? state.lastStarted : undefined;
      state.lastStarted = ac.signal;
      const handledIt = await handled(
        this.processor(msg, ac.signal, stopped ? { rollbackOf: stopped } : {})
      );
      return handledIt && !ac.signal.aborted;
    });
    state.current = done;
    return done.then((answered) => {
      if (state.abortController === ac) {
        state.abortController = undefined;
        state.current = undefined;
        state.lastStarted = undefined;
        this.release(threadId, state);
      }
      return answered;
    });
  }

  private async drainCollect(threadId: string, state: ThreadState): Promise<void> {
    state.processing = true;

    while (state.queue.length > 0) {
      const batch = state.queue.splice(0, state.queue.length);
      const results = new Map<string, boolean>();
      for (const merged of mergeByDestination(batch.map((queued) => queued.msg))) {
        results.set(replyDestination(merged), await handled(this.processor(merged)));
      }
      for (const queued of batch) queued.settle(results.get(replyDestination(queued.msg)) ?? false);
    }

    this.release(threadId, state);
  }
}
