import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  SendOptions,
} from '@cogitator-ai/types';

export interface DiscordConfig {
  token: string;
  intents?: number[];
  mentionOnly?: boolean;
}

interface DiscordClient {
  user: { id: string } | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
  channels: {
    fetch(id: string): Promise<DiscordChannelObj | null>;
  };
}

interface DiscordChannelObj {
  id: string;
  isTextBased(): boolean;
  send(options: Record<string, unknown>): Promise<{ id: string }>;
  messages: {
    fetch(id: string): Promise<{ edit(content: string): Promise<void> }>;
  };
  sendTyping(): Promise<void>;
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
  guild?: { id: string };
}

export class DiscordChannel implements Channel {
  readonly type: ChannelType = 'discord';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private client: DiscordClient | null = null;
  private botUserId: string | null = null;

  constructor(private readonly config: DiscordConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    let discord: {
      Client: new (options: Record<string, unknown>) => unknown;
      GatewayIntentBits: Record<string, number>;
    };
    try {
      discord = (await import('discord.js')) as unknown as typeof discord;
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

    const client = new discord.Client({ intents }) as DiscordClient;
    this.client = client;

    client.on('ready', () => {
      if (client.user) {
        this.botUserId = client.user.id;
      }
    });

    client.on('messageCreate', (raw: unknown) => {
      void this.handleDiscordMessage(raw as DiscordMessage);
    });

    await client.login(this.config.token);
  }

  private async handleDiscordMessage(discordMsg: DiscordMessage): Promise<void> {
    if (!this.handler) return;
    if (discordMsg.author.bot) return;

    const isDM = !discordMsg.guild;
    if (this.config.mentionOnly && !isDM) {
      if (!this.botUserId || !discordMsg.content.includes(`<@${this.botUserId}>`)) {
        return;
      }
    }

    let text = discordMsg.content;
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }

    const msg: ChannelMessage = {
      id: discordMsg.id,
      channelType: 'discord',
      channelId: discordMsg.channel.id,
      userId: discordMsg.author.id,
      userName: discordMsg.author.displayName ?? discordMsg.author.username,
      groupId: discordMsg.guild?.id,
      text,
      raw: discordMsg,
    };

    await this.handler(msg);
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    if (!this.client) return '';

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return '';

    const msgOptions: Record<string, unknown> = { content: text.slice(0, 2000) };
    if (options?.replyTo) {
      msgOptions.reply = { messageReference: options.replyTo };
    }

    const sent = await channel.send(msgOptions);
    return sent.id;
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(text.slice(0, 2000));
    } catch {}
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    await channel.send({
      files: [{ attachment: file.url ?? file.buffer, name: file.filename }],
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    await channel.sendTyping();
  }
}

export function discordChannel(config: DiscordConfig): Channel {
  return new DiscordChannel(config);
}
