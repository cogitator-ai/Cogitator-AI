import type { Channel, StreamConfig } from '@cogitator-ai/types';

const DEFAULT_FLUSH_INTERVAL = 500;
const DEFAULT_MIN_CHUNK_SIZE = 20;

export class StreamBuffer {
  private buffer = '';
  private messageId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly draftId: number | null = null;
  private draftFailed = false;

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
      return msgId;
    }

    await this.flush(true);
    return this.messageId ?? '';
  }

  abort(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async flush(force = false): Promise<void> {
    if (this.flushing) return;
    if (!force && this.buffer.length < this.config.minChunkSize) return;
    if (this.buffer.length === 0) return;

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
