import type { ChannelMessage, DebounceConfig } from '@cogitator-ai/types';

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
    const key = `${msg.channelType}:${msg.channelId}:${msg.userId}`;
    const delay = this.config.byChannel?.[msg.channelType] ?? this.defaultDelay;

    const existing = this.buffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = setTimeout(() => void this.flush(key), delay);
    } else {
      const timer = setTimeout(() => void this.flush(key), delay);
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

    const first = messages[0];
    const last = messages[messages.length - 1];

    const merged: ChannelMessage = {
      id: first.id,
      channelType: first.channelType,
      channelId: first.channelId,
      userId: first.userId,
      userName: first.userName,
      groupId: first.groupId,
      text: messages.map((m) => m.text).join('\n'),
      raw: last.raw,
    };

    const allAttachments = messages.flatMap((m) => m.attachments ?? []);
    if (allAttachments.length > 0) merged.attachments = allAttachments;

    await this.onFlush(merged);
  }
}
