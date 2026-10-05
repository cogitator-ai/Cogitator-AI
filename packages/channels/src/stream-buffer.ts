import type { Channel, StreamConfig } from '@cogitator-ai/types';

/** Where a streamed reply goes inside the chat, and whether its draft can be stopped. */
export interface StreamTarget {
  /** The topic of the chat to stream into */
  topicId?: string;
  /** Show a stop button on the draft, where the channel has one */
  canStop?: boolean;
}

const DEFAULT_FLUSH_INTERVAL = 500;
const DEFAULT_MIN_CHUNK_SIZE = 20;

interface Segment {
  messageId: string | null;
  lastSentText: string;
}

function createSegment(): Segment {
  return { messageId: null, lastSentText: '' };
}

function findSplitPoint(text: string, limit: number): number {
  const newline = text.lastIndexOf('\n', limit);
  if (newline >= Math.floor(limit / 2)) return newline + 1;
  const space = text.lastIndexOf(' ', limit);
  if (space > 0) return space + 1;
  if (newline > 0) return newline + 1;
  return limit;
}

export class StreamBuffer {
  private buffer = '';
  private segment: Segment = createSegment();
  private readonly messageIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ops: Promise<void> = Promise.resolve();
  private flushing = false;
  private readonly draftIdValue: number | null = null;
  private draftFailed = false;
  private replySent = false;
  private lastFlushEnd = 0;
  private stopped = false;
  private finalError: unknown = null;

  constructor(
    private readonly channel: Channel,
    private readonly channelId: string,
    private readonly config: StreamConfig = {
      flushInterval: DEFAULT_FLUSH_INTERVAL,
      minChunkSize: DEFAULT_MIN_CHUNK_SIZE,
    },
    private readonly replyTo?: string,
    useDraft = false,
    private readonly format: (text: string) => string = (text) => text,
    private readonly target: StreamTarget = {}
  ) {
    if (useDraft && channel.sendDraft) {
      this.draftIdValue = Math.floor(Math.random() * 2_147_483_646) + 1;
    }
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  append(token: string): void {
    this.buffer += token;

    const limit = this.config.maxMessageChars;
    if (!limit || limit <= 0 || !Number.isFinite(limit)) return;

    while (this.buffer.length > limit) {
      const splitAt = findSplitPoint(this.buffer, limit);
      const head = this.buffer.slice(0, splitAt).trimEnd();
      this.buffer = this.buffer.slice(splitAt);
      if (!head) continue;
      this.commit(this.segment, head, false);
      this.segment = createSegment();
    }
  }

  forceNewMessage(): void {
    if (this.buffer) {
      this.commit(this.segment, this.buffer, false);
    }
    this.buffer = '';
    this.segment = createSegment();
  }

  /** The id of the draft the reply streams into, or null when it streams by editing messages. */
  get draftId(): number | null {
    return this.draftActive ? this.draftIdValue : null;
  }

  getMessageIds(): readonly string[] {
    return this.messageIds;
  }

  async finish(): Promise<string> {
    this.stopTimer();

    if (this.buffer) {
      this.commit(this.segment, this.buffer, true);
    }

    await this.ops;

    if (this.finalError) {
      const error = this.finalError;
      this.finalError = null;
      throw error;
    }

    return this.messageIds[this.messageIds.length - 1] ?? '';
  }

  async abort(): Promise<void> {
    this.stopTimer();
    await this.ops;

    if (this.config.deleteOnAbort && this.channel.deleteMessage) {
      for (const id of this.messageIds) {
        try {
          await this.channel.deleteMessage(this.channelId, id);
        } catch {}
      }
    }
  }

  private stopTimer(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.ops.then(op);
    this.ops = next.catch(() => {});
    return next;
  }

  private get draftActive(): boolean {
    return this.draftIdValue !== null && !this.draftFailed;
  }

  private nextReplyTo(): string | undefined {
    if (this.replySent) return undefined;
    this.replySent = true;
    return this.replyTo;
  }

  private async sendNew(segment: Segment, text: string): Promise<void> {
    const msgId = await this.channel.sendText(this.channelId, this.format(text), {
      replyTo: this.nextReplyTo(),
      format: 'markdown',
      ...(this.target.topicId ? { topicId: this.target.topicId } : {}),
    });
    segment.messageId = msgId;
    segment.lastSentText = text;
    this.trackMessageId(msgId);
  }

  private commit(segment: Segment, text: string, final: boolean): void {
    void this.enqueue(async () => {
      try {
        if (this.draftActive) {
          await this.sendNew(segment, text);
        } else if (!segment.messageId) {
          await this.sendNew(segment, text);
        } else if (text !== segment.lastSentText) {
          await this.channel.editText(this.channelId, segment.messageId, this.format(text));
          segment.lastSentText = text;
        }
      } catch (error) {
        if (final) this.finalError = error;
      }
    });
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
      void this.flush().then(() => this.scheduleNext());
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;

    const text = this.buffer;
    const segment = this.segment;
    if (text.length === 0) return;

    const hasMessage = segment.messageId !== null || segment.lastSentText !== '';
    if (!hasMessage && this.config.minInitialChars && text.length < this.config.minInitialChars) {
      return;
    }
    if (text.length < this.config.minChunkSize) return;
    if (text === segment.lastSentText) return;

    this.flushing = true;
    try {
      await this.enqueue(() => this.sendUpdate(segment, text));
    } finally {
      this.flushing = false;
      this.lastFlushEnd = Date.now();
    }
  }

  private async sendUpdate(segment: Segment, text: string): Promise<void> {
    if (this.stopped && segment === this.segment) return;

    if (this.draftActive) {
      try {
        await this.channel.sendDraft!(this.channelId, this.draftIdValue!, this.format(text), {
          format: 'markdown',
          ...(this.target.topicId ? { topicId: this.target.topicId } : {}),
          ...(this.target.canStop ? { canStop: true } : {}),
        });
        segment.lastSentText = text;
      } catch {
        this.draftFailed = true;
      }
      return;
    }

    try {
      if (!segment.messageId) {
        await this.sendNew(segment, text);
      } else {
        await this.channel.editText(this.channelId, segment.messageId, this.format(text));
        segment.lastSentText = text;
      }
    } catch {}
  }
}
