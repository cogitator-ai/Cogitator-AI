import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  AttachmentType,
  SendOptions,
} from '@cogitator-ai/types';

export interface SlackConfig {
  token: string;
  signingSecret: string;
  appToken?: string;
  port?: number;
  mentionOnly?: boolean;
}

interface SlackApp {
  message(handler: (event: SlackMessageEvent) => Promise<void>): void;
  event(name: 'app_mention', handler: (event: SlackMentionEvent) => Promise<void>): void;
  start(port: number): Promise<unknown>;
  stop(): Promise<unknown>;
  client: {
    chat: {
      postMessage(options: Record<string, unknown>): Promise<{ ts?: string }>;
      update(options: Record<string, unknown>): Promise<unknown>;
      delete(options: Record<string, unknown>): Promise<unknown>;
    };
    files: {
      uploadV2(options: Record<string, unknown>): Promise<unknown>;
    };
    reactions: {
      add(options: Record<string, unknown>): Promise<unknown>;
    };
    users: {
      info(options: { user: string }): Promise<{
        user?: { real_name?: string; name?: string; profile?: { display_name?: string } };
      }>;
    };
  };
}

interface SlackFile {
  url_private?: string;
  mimetype?: string;
  name?: string;
}

interface SlackMessage {
  ts: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
}

interface SlackListenerContext {
  botUserId?: string;
}

interface SlackMessageEvent {
  message: SlackMessage;
  context?: SlackListenerContext;
}

interface SlackMentionEvent {
  event: SlackMessage;
  context?: SlackListenerContext;
}

const MAX_TRACKED = 1000;

const EMOJI_NAMES: Record<string, string> = {
  '\u{1F440}': 'eyes',
  '\u{1F914}': 'thinking_face',
  '\u{1F525}': 'fire',
  '\u{1F44D}': '+1',
  '\u{1F631}': 'scream',
  '\u{1F971}': 'yawning_face',
  '\u{1F628}': 'fearful',
};

function attachmentType(mimeType: string): AttachmentType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

export class SlackChannel implements Channel {
  readonly type: ChannelType = 'slack';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private app: SlackApp | null = null;
  private readonly threadRoots = new Map<string, string>();
  private readonly userNames = new Map<string, string>();
  private readonly handled = new Map<string, true>();

  constructor(private readonly config: SlackConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.app) return;

    let bolt: { App: new (config: Record<string, unknown>) => unknown };
    try {
      bolt = (await import('@slack/bolt')) as unknown as typeof bolt;
    } catch {
      throw new Error(
        '@slack/bolt is required for Slack support. Install it: pnpm add @slack/bolt'
      );
    }

    const appConfig: Record<string, unknown> = {
      token: this.config.token,
      signingSecret: this.config.signingSecret,
    };

    if (this.config.appToken) {
      appConfig.socketMode = true;
      appConfig.appToken = this.config.appToken;
    }

    const app = new bolt.App(appConfig) as SlackApp;

    app.message(async ({ message, context }: SlackMessageEvent) => {
      await this.handleSlackMessage(message, context?.botUserId, false);
    });

    app.event('app_mention', async ({ event, context }: SlackMentionEvent) => {
      await this.handleSlackMessage(
        { ...event, channel_type: event.channel_type ?? 'channel' },
        context?.botUserId,
        true
      );
    });

    await app.start(this.config.port ?? 3000);
    this.app = app;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.set(key, value);
    if (map.size > MAX_TRACKED) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    if (!this.app) return undefined;
    try {
      const info = await this.app.client.users.info({ user: userId });
      const user = info.user;
      const name = user?.profile?.display_name || user?.real_name || user?.name;
      if (name) this.remember(this.userNames, userId, name);
      return name;
    } catch {
      return undefined;
    }
  }

  private async handleSlackMessage(
    message: SlackMessage,
    botUserId: string | undefined,
    mentioned: boolean
  ): Promise<void> {
    if (!this.handler) return;
    if (message.bot_id || !message.user) return;
    if (message.subtype && message.subtype !== 'file_share') return;

    const isDirect = message.channel_type === 'im';
    const mention = botUserId ? `<@${botUserId}>` : undefined;
    const rawText = message.text ?? '';
    if (
      !isDirect &&
      !mentioned &&
      this.config.mentionOnly &&
      !(mention && rawText.includes(mention))
    ) {
      return;
    }

    const key = `${message.channel}:${message.ts}`;
    if (this.handled.has(key)) return;
    this.remember(this.handled, key, true);

    const attachments: Attachment[] = [];
    for (const file of message.files ?? []) {
      if (!file.url_private) continue;
      const mimeType = file.mimetype ?? 'application/octet-stream';
      try {
        const buffer = await this.downloadPrivateFile(file.url_private);
        attachments.push({
          type: attachmentType(mimeType),
          mimeType,
          buffer,
          ...(file.name ? { filename: file.name } : {}),
        });
      } catch (err) {
        console.error('[slack] Failed to download file:', err instanceof Error ? err.message : err);
      }
    }

    const text = mention ? rawText.split(mention).join('').trim() : rawText;
    if (!text && attachments.length === 0) return;

    this.remember(this.threadRoots, message.ts, message.thread_ts ?? message.ts);

    const userName = await this.resolveUserName(message.user);

    const channelMessage: ChannelMessage = {
      id: message.ts,
      channelType: 'slack',
      channelId: message.channel,
      userId: message.user,
      text,
      raw: message,
      ...(userName ? { userName } : {}),
      ...(isDirect ? {} : { groupId: message.channel }),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(message.thread_ts && message.thread_ts !== message.ts
        ? { replyTo: message.thread_ts }
        : {}),
    };

    await this.handler(channelMessage);
  }

  private async downloadPrivateFile(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.config.token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async stop(): Promise<void> {
    if (this.app) {
      const app = this.app;
      this.app = null;
      await app.stop();
    }
  }

  private requireApp(): SlackApp {
    if (!this.app) throw new Error('Slack channel is not started');
    return this.app;
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const app = this.requireApp();
    const threadTs = options?.replyTo
      ? (this.threadRoots.get(options.replyTo) ?? options.replyTo)
      : undefined;

    const result = await app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    if (!result.ts) throw new Error('Slack did not return a message timestamp');
    if (threadTs) this.remember(this.threadRoots, result.ts, threadTs);
    return result.ts;
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const app = this.requireApp();
    await app.client.chat.update({
      channel: channelId,
      ts: messageId,
      text,
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const app = this.requireApp();
    await app.client.chat.delete({ channel: channelId, ts: messageId });
  }

  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const app = this.requireApp();
    const name = EMOJI_NAMES[emoji] ?? emoji.replace(/^:|:$/g, '');
    await app.client.reactions.add({ channel: channelId, timestamp: messageId, name });
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    const app = this.requireApp();

    let content: Buffer;
    if (file.buffer) {
      content = Buffer.from(file.buffer);
    } else if (file.url) {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`Failed to download ${file.url}: HTTP ${res.status}`);
      content = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error('Attachment must have either a buffer or a url');
    }

    await app.client.files.uploadV2({
      channel_id: channelId,
      filename: file.filename ?? 'file',
      file: content,
    });
  }

  async sendTyping(_channelId: string): Promise<void> {}
}

export function slackChannel(config: SlackConfig): Channel {
  return new SlackChannel(config);
}
