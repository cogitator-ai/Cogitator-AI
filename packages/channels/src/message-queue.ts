import type { ChannelMessage, QueueMode } from '@cogitator-ai/types';
import { mergeByDestination, replyDestination } from './merge-messages';

interface QueuedMessage {
  msg: ChannelMessage;
  settle: (handled: boolean) => void;
}

/**
 * Handles one message. It resolves `false` when the message was not handled (a failed or
 * aborted run), anything else counts as handled.
 */
export type MessageProcessor = (
  msg: ChannelMessage,
  signal?: AbortSignal
) => Promise<boolean | void>;

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
}

export class MessageQueue {
  private threads = new Map<string, ThreadState>();

  constructor(
    private readonly mode: QueueMode,
    private readonly processor: MessageProcessor
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
        return this.enqueue(msg, threadId, (state) => this.drainSequential(threadId, state));
      case 'interrupt':
        return this.pushInterrupt(msg, threadId);
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
