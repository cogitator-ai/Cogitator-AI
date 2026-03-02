import type { Channel, StreamConfig } from '@cogitator-ai/types';

const DEFAULT_FLUSH_INTERVAL = 500;
const DEFAULT_MIN_CHUNK_SIZE = 20;

export class StreamBuffer {
  private buffer = '';
  private messageId: string | null = null;
  private readonly messageIds: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly draftId: number | null = null;
  private draftFailed = false;
  private initialSent = false;

  constructor(
    private readonly channel: Channel,
    private readonly channelId: string,
    private readonly config: StreamConfig = {
      flushInterval: DEFAULT_FLUSH_INTERVAL,
      minChunkSize: DEFAULT_MIN_CHUNK_SIZE,
    },
    private readonly replyTo?: string,
    useDraft = false
  ) {
    if (useDraft && channel.sendDraft) {
      this.draftId = Math.floor(Math.random() * 2_147_483_646) + 1;
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushInterval);
  }

  append(token: string): void {
    this.buffer += token;

    const limit = this.config.maxMessageChars;
    if (limit && this.buffer.length > limit) {
      const overflow = this.buffer.slice(limit);
      this.buffer = this.buffer.slice(0, limit);
      this.forceNewMessage();
      this.buffer = overflow;
    }
  }

  forceNewMessage(): void {
    this.buffer = '';
    this.messageId = null;
    this.initialSent = false;
  }

  getMessageIds(): readonly string[] {
    return this.messageIds;
  }

  async finish(): Promise<string> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.draftId && !this.draftFailed) {
      const text = this.buffer;
      if (!text) return '';
      const msgId = await this.channel.sendText(this.channelId, text, {
        replyTo: this.replyTo,
        format: 'markdown',
      });
      this.trackMessageId(msgId);
      return msgId;
    }

    await this.flush(true);
    return this.messageId ?? '';
  }

  async abort(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.config.deleteOnAbort && this.channel.deleteMessage) {
      for (const id of this.messageIds) {
        try {
          await this.channel.deleteMessage(this.channelId, id);
        } catch {}
      }
    }
  }

  private trackMessageId(id: string): void {
    if (id && !this.messageIds.includes(id)) {
      this.messageIds.push(id);
    }
  }

  private async flush(force = false): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;

    if (!force && !this.initialSent && this.config.minInitialChars) {
      if (this.buffer.length < this.config.minInitialChars) return;
    }

    if (!force && this.buffer.length < this.config.minChunkSize) return;

    this.flushing = true;
    const text = this.buffer;

    try {
      if (this.draftId && !this.draftFailed) {
        await this.channel.sendDraft!(this.channelId, this.draftId, text);
      } else if (!this.messageId) {
        this.messageId = await this.channel.sendText(this.channelId, text, {
          replyTo: this.replyTo,
          format: 'markdown',
        });
        this.trackMessageId(this.messageId);
        this.initialSent = true;
      } else {
        await this.channel.editText(this.channelId, this.messageId, text);
      }
    } catch {
      if (this.draftId && !this.draftFailed) {
        this.draftFailed = true;
      }
    } finally {
      this.flushing = false;
    }
  }
}
