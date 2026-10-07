import type { ChannelMessage, DebounceConfig } from '@cogitator-ai/types';
import { mergeChannelMessages, replyDestination } from './merge-messages';

interface BufferEntry {
  messages: ChannelMessage[];
  timer: ReturnType<typeof setTimeout>;
}

export class InboundDebouncer {
  private buffers = new Map<string, BufferEntry>();
  private readonly defaultDelay: number;

  constructor(
    private readonly config: DebounceConfig,
    private readonly onFlush: (merged: ChannelMessage) => Promise<void>
  ) {
    this.defaultDelay = config.delayMs ?? 1500;
  }

  enqueue(msg: ChannelMessage): void {
    const key = `${replyDestination(msg)}:${msg.userId}`;
    const delay = this.config.byChannel?.[msg.channelType] ?? this.defaultDelay;

    const existing = this.buffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = setTimeout(() => void this.flush(key).catch(() => {}), delay);
    } else {
      const timer = setTimeout(() => void this.flush(key).catch(() => {}), delay);
      this.buffers.set(key, { messages: [msg], timer });
    }
  }

  async flushAll(): Promise<void> {
    const keys = [...this.buffers.keys()];
    await Promise.all(keys.map((key) => this.flush(key)));
  }

  dispose(): void {
    for (const entry of this.buffers.values()) {
      clearTimeout(entry.timer);
    }
    this.buffers.clear();
  }

  private async flush(key: string): Promise<void> {
    const entry = this.buffers.get(key);
    if (!entry) return;
    this.buffers.delete(key);

    const messages = entry.messages;
    if (messages.length === 0) return;

    const merged = mergeChannelMessages(messages);

    await this.onFlush(merged);
  }
}
