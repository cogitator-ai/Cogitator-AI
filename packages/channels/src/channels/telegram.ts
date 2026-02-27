import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  SendOptions,
} from '@cogitator-ai/types';

export interface TelegramConfig {
  token: string;
  allowedUpdates?: string[];
  webhook?: { url: string; port: number };
}

interface TelegramBot {
  on(event: string, handler: (ctx: GrammyContext) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  api: {
    sendMessage(
      chatId: number,
      text: string,
      options?: Record<string, unknown>
    ): Promise<{ message_id: number }>;
    editMessageText(
      chatId: number,
      messageId: number,
      text: string,
      options?: Record<string, unknown>
    ): Promise<unknown>;
    sendPhoto(chatId: number, photo: string): Promise<unknown>;
    sendDocument(chatId: number, document: string): Promise<unknown>;
    sendChatAction(chatId: number, action: string): Promise<unknown>;
    setWebhook(url: string): Promise<unknown>;
  };
}

interface GrammyContext {
  message: {
    message_id: number;
    text: string;
  };
  chat: {
    id: number;
    type: string;
  };
  from: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
}

export class TelegramChannel implements Channel {
  readonly type: ChannelType = 'telegram';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private bot: TelegramBot | null = null;

  constructor(private readonly config: TelegramConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    let grammy: { Bot: new (token: string) => unknown };
    try {
      grammy = (await import('grammy')) as typeof grammy;
    } catch {
      throw new Error('grammy is required for Telegram support. Install it: pnpm add grammy');
    }

    const bot = new grammy.Bot(this.config.token) as TelegramBot;
    this.bot = bot;

    bot.on('message:text', async (ctx: GrammyContext) => {
      if (!this.handler) return;

      const msg: ChannelMessage = {
        id: String(ctx.message.message_id),
        channelType: 'telegram',
        channelId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        userName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        groupId: ctx.chat.type !== 'private' ? String(ctx.chat.id) : undefined,
        text: ctx.message.text,
        raw: ctx,
      };

      await this.handler(msg);
    });

    if (this.config.webhook) {
      await bot.api.setWebhook(this.config.webhook.url);
    } else {
      void bot.start();
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    if (!this.bot) return '';

    const chatId = Number(channelId);

    const sent = await this.bot.api.sendMessage(chatId, text, {
      ...(options?.replyTo ? { reply_parameters: { message_id: Number(options.replyTo) } } : {}),
      ...(options?.silent ? { disable_notification: true } : {}),
    });

    return String(sent.message_id);
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.api.editMessageText(Number(channelId), Number(messageId), text);
    } catch {}
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    if (!this.bot) return;

    const chatId = Number(channelId);

    if (file.type === 'image' && file.url) {
      await this.bot.api.sendPhoto(chatId, file.url);
    } else if (file.url) {
      await this.bot.api.sendDocument(chatId, file.url);
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(channelId), 'typing');
  }
}

export function telegramChannel(config: TelegramConfig): Channel {
  return new TelegramChannel(config);
}
