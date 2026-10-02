import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  AttachmentType,
  SendOptions,
} from '@cogitator-ai/types';
import { chunkDiscordText } from '../formatters/discord-chunker';

export interface DiscordConfig {
  token: string;
  intents?: number[];
  mentionOnly?: boolean;
}

interface DiscordSentMessage {
  id: string;
  edit(content: string): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

interface DiscordClient {
  user: { id: string } | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
  channels: {
    fetch(id: string): Promise<DiscordChannelObj | null>;
  };
}

interface DiscordChannelObj {
  id: string;
  isTextBased(): boolean;
  send(options: Record<string, unknown>): Promise<DiscordSentMessage>;
  messages: {
    fetch(id: string): Promise<DiscordSentMessage>;
  };
  sendTyping(): Promise<void>;
}

interface DiscordAttachment {
  url: string;
  name?: string | null;
  contentType?: string | null;
}

interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    bot: boolean;
    username: string;
    displayName?: string;
  };
  channel: { id: string };
  guild?: { id: string } | null;
  attachments?: { values(): IterableIterator<DiscordAttachment> };
  reference?: { messageId?: string } | null;
}

interface DiscordModule {
  Client: new (options: Record<string, unknown>) => unknown;
  GatewayIntentBits: Record<string, number>;
  Partials?: Record<string, number>;
  Events?: Record<string, string>;
}

const MAX_TRACKED_MESSAGES = 500;

function attachmentType(contentType: string): AttachmentType {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

export class DiscordChannel implements Channel {
  readonly type: ChannelType = 'discord';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private client: DiscordClient | null = null;
  private botUserId: string | null = null;
  private readonly continuations = new Map<string, string[]>();

  constructor(private readonly config: DiscordConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.client) return;

    let discord: DiscordModule;
    try {
      discord = (await import('discord.js')) as unknown as DiscordModule;
    } catch {
      throw new Error(
        'discord.js is required for Discord support. Install it: pnpm add discord.js'
      );
    }

    const intents = this.config.intents ?? [
      discord.GatewayIntentBits.Guilds,
      discord.GatewayIntentBits.GuildMessages,
      discord.GatewayIntentBits.DirectMessages,
      discord.GatewayIntentBits.MessageContent,
    ];
    const partials = discord.Partials?.Channel !== undefined ? [discord.Partials.Channel] : [];

    const client = new discord.Client({ intents, partials }) as DiscordClient;
    this.client = client;

    const readyEvent = discord.Events?.ClientReady ?? 'ready';
    const ready = new Promise<void>((resolve) => {
      client.once(readyEvent, () => resolve());
    });

    client.on('messageCreate', (raw: unknown) => {
      void this.handleDiscordMessage(raw as DiscordMessage).catch((err: unknown) => {
        console.error('[discord] Message handler error:', err);
      });
    });

    try {
      await client.login(this.config.token);
      await ready;
    } catch (err) {
      this.client = null;
      await client.destroy().catch(() => {});
      throw err;
    }

    this.botUserId = client.user?.id ?? null;
  }

  private mentionPattern(): RegExp | null {
    return this.botUserId ? new RegExp(`<@!?${this.botUserId}>`, 'g') : null;
  }

  private async handleDiscordMessage(discordMsg: DiscordMessage): Promise<void> {
    if (!this.handler) return;
    if (discordMsg.author.bot) return;

    const isDM = !discordMsg.guild;
    const mention = this.mentionPattern();

    if (this.config.mentionOnly && !isDM) {
      if (!mention?.test(discordMsg.content)) return;
      mention.lastIndex = 0;
    }

    const text = mention ? discordMsg.content.replace(mention, '').trim() : discordMsg.content;

    const attachments: Attachment[] = [];
    if (discordMsg.attachments) {
      for (const att of discordMsg.attachments.values()) {
        const mimeType = att.contentType ?? 'application/octet-stream';
        attachments.push({
          type: attachmentType(mimeType),
          url: att.url,
          mimeType,
          ...(att.name ? { filename: att.name } : {}),
        });
      }
    }

    if (!text && attachments.length === 0) return;

    const replyTo = discordMsg.reference?.messageId;
    const msg: ChannelMessage = {
      id: discordMsg.id,
      channelType: 'discord',
      channelId: discordMsg.channel.id,
      userId: discordMsg.author.id,
      userName: discordMsg.author.displayName ?? discordMsg.author.username,
      groupId: discordMsg.guild?.id,
      text,
      raw: discordMsg,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    };

    await this.handler(msg);
  }

  async stop(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      this.botUserId = null;
      this.continuations.clear();
      await client.destroy();
    }
  }

  private async fetchTextChannel(channelId: string): Promise<DiscordChannelObj> {
    if (!this.client) throw new Error('Discord channel is not started');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel ${channelId} is not a text channel`);
    }
    return channel;
  }

  private rememberContinuations(primaryId: string, ids: string[]): void {
    if (ids.length === 0) {
      this.continuations.delete(primaryId);
      return;
    }
    this.continuations.set(primaryId, ids);
    if (this.continuations.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.continuations.keys().next().value;
      if (oldest !== undefined) this.continuations.delete(oldest);
    }
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const channel = await this.fetchTextChannel(channelId);
    const chunks = chunkDiscordText(text);
    if (chunks.length === 0) return '';

    const ids: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const msgOptions: Record<string, unknown> = { content: chunks[i] };
      if (i === 0 && options?.replyTo) {
        msgOptions.reply = { messageReference: options.replyTo, failIfNotExists: false };
      }
      const sent = await channel.send(msgOptions);
      ids.push(sent.id);
    }

    const [primaryId, ...rest] = ids;
    this.rememberContinuations(primaryId, rest);
    return primaryId;
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    const chunks = chunkDiscordText(text);
    if (chunks.length === 0) return;

    const primary = await channel.messages.fetch(messageId);
    await primary.edit(chunks[0]);

    const previous = this.continuations.get(messageId) ?? [];
    const next: string[] = [];

    for (let i = 1; i < chunks.length; i++) {
      const existingId = previous[i - 1];
      if (existingId) {
        const existing = await channel.messages.fetch(existingId);
        await existing.edit(chunks[i]);
        next.push(existingId);
      } else {
        const sent = await channel.send({ content: chunks[i] });
        next.push(sent.id);
      }
    }

    for (const staleId of previous.slice(chunks.length - 1)) {
      const stale = await channel.messages.fetch(staleId);
      await stale.delete();
    }

    this.rememberContinuations(messageId, next);
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    const source = file.buffer ? Buffer.from(file.buffer) : file.url;
    if (!source) throw new Error('Attachment must have either a buffer or a url');

    const channel = await this.fetchTextChannel(channelId);
    await channel.send({
      files: [{ attachment: source, ...(file.filename ? { name: file.filename } : {}) }],
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.client) return;
    const channel = await this.fetchTextChannel(channelId);
    await channel.sendTyping();
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    const ids = [messageId, ...(this.continuations.get(messageId) ?? [])];
    this.continuations.delete(messageId);
    for (const id of ids) {
      const msg = await channel.messages.fetch(id);
      await msg.delete();
    }
  }

  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    const msg = await channel.messages.fetch(messageId);
    await msg.react(emoji);
  }
}

export function discordChannel(config: DiscordConfig): Channel {
  return new DiscordChannel(config);
}
