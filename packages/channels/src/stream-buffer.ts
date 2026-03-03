import type { Channel, StreamConfig } from '@cogitator-ai/types';

const DEFAULT_FLUSH_INTERVAL = 500;
const DEFAULT_MIN_CHUNK_SIZE = 20;

export class StreamBuffer {
  private buffer = '';
  private messageId: string | null = null;
  private readonly messageIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly draftId: number | null = null;
  private draftFailed = false;
  private initialSent = false;
  private lastSentText = '';
  private generation = 0;
  private lastFlushEnd = 0;
  private stopped = false;

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
    this.stopped = false;
    this.scheduleNext();
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
    this.generation++;
    this.buffer = '';
    this.messageId = null;
    this.initialSent = false;
    this.lastSentText = '';
  }

  getMessageIds(): readonly string[] {
    return this.messageIds;
  }

  async finish(): Promise<string> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.flushPromise) {
      await this.flushPromise;
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
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.flushPromise) {
      await this.flushPromise;
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

  private scheduleNext(): void {
    if (this.stopped) return;
    const elapsed = this.lastFlushEnd ? Date.now() - this.lastFlushEnd : 0;
    const delay = Math.max(0, this.config.flushInterval - elapsed);
    this.timer = setTimeout(() => {
      const p = this.flush();
      void p.then(() => this.scheduleNext());
    }, delay);
  }

  private async flush(force = false): Promise<void> {
    if (this.flushPromise) return;
    if (this.buffer.length === 0) return;

    if (!force && !this.initialSent && this.config.minInitialChars) {
      if (this.buffer.length < this.config.minInitialChars) return;
    }

    if (!force && this.buffer.length < this.config.minChunkSize) return;

    const text = this.buffer;

    if (!force && this.messageId && text === this.lastSentText) return;

    const gen = this.generation;

    const promise = this.doFlush(text, gen);
    this.flushPromise = promise;

    try {
      await promise;
    } finally {
      this.flushPromise = null;
      this.lastFlushEnd = Date.now();
    }
  }

  private async doFlush(text: string, gen: number): Promise<void> {
    try {
      if (this.draftId && !this.draftFailed) {
        await this.channel.sendDraft!(this.channelId, this.draftId, text);
      } else if (!this.messageId) {
        const msgId = await this.channel.sendText(this.channelId, text, {
          replyTo: this.replyTo,
          format: 'markdown',
        });
        if (gen !== this.generation) return;
        this.messageId = msgId;
        this.trackMessageId(msgId);
        this.initialSent = true;
        this.lastSentText = text;
      } else {
        if (gen !== this.generation) return;
        await this.channel.editText(this.channelId, this.messageId, text);
        if (gen !== this.generation) return;
        this.lastSentText = text;
      }
    } catch {
      if (this.draftId && !this.draftFailed) {
        this.draftFailed = true;
      }
    }
  }
}
