import type { ChannelMessage, QueueMode } from '@cogitator-ai/types';

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
        void this.processor(msg);
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
      void this.drainSequential(state);
    }
  }

  private async drainSequential(state: ThreadState): Promise<void> {
    state.processing = true;
    while (state.queue.length > 0) {
      const next = state.queue.shift()!;
      try {
        await this.processor(next);
      } catch {}
    }
    state.processing = false;
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
          state.processing = false;
          state.abortController = undefined;
        }
      });
  }

  private pushCollect(msg: ChannelMessage, threadId: string): void {
    const state = this.getThread(threadId);
    state.queue.push(msg);

    if (!state.processing) {
      void this.drainCollect(state);
    }
  }

  private async drainCollect(state: ThreadState): Promise<void> {
    state.processing = true;

    while (state.queue.length > 0) {
      const batch = state.queue.splice(0, state.queue.length);
      const merged = this.mergeMessages(batch);
      try {
        await this.processor(merged);
      } catch {}
    }

    state.processing = false;
  }

  private mergeMessages(msgs: ChannelMessage[]): ChannelMessage {
    if (msgs.length === 1) return msgs[0];
    const first = msgs[0];
    const joined: ChannelMessage = {
      id: first.id,
      channelType: first.channelType,
      channelId: first.channelId,
      userId: first.userId,
      userName: first.userName,
      groupId: first.groupId,
      text: msgs.map((m) => m.text).join('\n'),
      raw: msgs[msgs.length - 1].raw,
    };
    const allAttachments = msgs.flatMap((m) => m.attachments ?? []);
    if (allAttachments.length > 0) joined.attachments = allAttachments;
    return joined;
  }
}
