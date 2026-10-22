import type { ChannelMessage, QueueMode } from '@cogitator-ai/types';
import { mergeByDestination } from './merge-messages';

interface QueuedMessage {
  msg: ChannelMessage;
  settle: () => void;
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
    private readonly processor: (msg: ChannelMessage, signal?: AbortSignal) => Promise<void>
  ) {}

  /**
   * Queues a message of a thread. The returned promise settles once the message is done with:
   * answered (alone or merged with others), interrupted by a newer one, or dropped by
   * {@link dispose}. It never rejects.
   */
  push(msg: ChannelMessage, threadId: string): Promise<void> {
    switch (this.mode) {
      case 'parallel':
        return this.processor(msg).catch(() => {});
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
      for (const queued of state.queue.splice(0)) queued.settle();
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
  ): Promise<void> {
    const state = this.getThread(threadId);
    const done = new Promise<void>((settle) => state.queue.push({ msg, settle }));
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
      try {
        await this.processor(next.msg);
      } catch {
      } finally {
        next.settle();
      }
      next = state.queue.shift();
    }
    this.release(threadId, state);
  }

  private pushInterrupt(msg: ChannelMessage, threadId: string): Promise<void> {
    const state = this.getThread(threadId);

    if (state.processing && state.abortController) {
      state.abortController.abort();
    }

    for (const queued of state.queue.splice(0)) queued.settle();
    const ac = new AbortController();
    state.abortController = ac;
    state.processing = true;

    return this.processor(msg, ac.signal)
      .catch(() => {})
      .finally(() => {
        if (state.abortController === ac) {
          state.abortController = undefined;
          this.release(threadId, state);
        }
      });
  }

  private async drainCollect(threadId: string, state: ThreadState): Promise<void> {
    state.processing = true;

    while (state.queue.length > 0) {
      const batch = state.queue.splice(0, state.queue.length);
      try {
        for (const merged of mergeByDestination(batch.map((queued) => queued.msg))) {
          try {
            await this.processor(merged);
          } catch {}
        }
      } finally {
        for (const queued of batch) queued.settle();
      }
    }

    this.release(threadId, state);
  }
}
