import type { ChannelMessage, QueueMode } from '@cogitator-ai/types';
import { mergeByDestination } from './merge-messages';

interface ThreadState {
  processing: boolean;
  queue: ChannelMessage[];
  abortController?: AbortController;
}

export class MessageQueue {
  private threads = new Map<string, ThreadState>();

  constructor(
    private readonly mode: QueueMode,
    private readonly processor: (msg: ChannelMessage, signal?: AbortSignal) => Promise<void>
  ) {}

  push(msg: ChannelMessage, threadId: string): void {
    switch (this.mode) {
      case 'parallel':
        void this.processor(msg).catch(() => {});
        break;
      case 'sequential':
        this.pushSequential(msg, threadId);
        break;
      case 'interrupt':
        this.pushInterrupt(msg, threadId);
        break;
      case 'collect':
        this.pushCollect(msg, threadId);
        break;
    }
  }

  dispose(): void {
    for (const state of this.threads.values()) {
      state.abortController?.abort();
      state.queue.length = 0;
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

  private pushSequential(msg: ChannelMessage, threadId: string): void {
    const state = this.getThread(threadId);
    state.queue.push(msg);
    if (!state.processing) {
      void this.drainSequential(threadId, state);
    }
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
        await this.processor(next);
      } catch {}
      next = state.queue.shift();
    }
    this.release(threadId, state);
  }

  private pushInterrupt(msg: ChannelMessage, threadId: string): void {
    const state = this.getThread(threadId);

    if (state.processing && state.abortController) {
      state.abortController.abort();
    }

    state.queue.length = 0;
    const ac = new AbortController();
    state.abortController = ac;
    state.processing = true;

    void this.processor(msg, ac.signal)
      .catch(() => {})
      .finally(() => {
        if (state.abortController === ac) {
          state.abortController = undefined;
          this.release(threadId, state);
        }
      });
  }

  private pushCollect(msg: ChannelMessage, threadId: string): void {
    const state = this.getThread(threadId);
    state.queue.push(msg);

    if (!state.processing) {
      void this.drainCollect(threadId, state);
    }
  }

  private async drainCollect(threadId: string, state: ThreadState): Promise<void> {
    state.processing = true;

    while (state.queue.length > 0) {
      const batch = state.queue.splice(0, state.queue.length);
      for (const merged of mergeByDestination(batch)) {
        try {
          await this.processor(merged);
        } catch {}
      }
    }

    this.release(threadId, state);
  }
}
