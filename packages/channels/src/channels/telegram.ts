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

interface BotInfo {
  id: number;
  first_name: string;
  username: string;
}

interface TelegramBot {
  on(event: string, handler: (ctx: GrammyContext) => Promise<void>): void;
  catch(handler: (err: unknown) => void): void;
  init(): Promise<void>;
  start(options?: {
    drop_pending_updates?: boolean;
    onStart?: (info: BotInfo) => void;
  }): Promise<void>;
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
    getFile(fileId: string): Promise<{ file_path?: string }>;
    setMessageReaction(
      chatId: number,
      messageId: number,
      reaction: { type: string; emoji: string }[],
      options?: Record<string, unknown>
    ): Promise<unknown>;
  };
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface GrammyContext {
  message: {
    message_id: number;
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    voice?: {
      file_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
    };
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
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

  private async downloadFile(fileId: string): Promise<Buffer> {
    const bot = this.bot!;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram returned no file_path');
    const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  private buildBaseMessage(
    ctx: GrammyContext
  ): Omit<ChannelMessage, 'text' | 'attachments' | 'raw'> {
    return {
      id: String(ctx.message.message_id),
      channelType: 'telegram',
      channelId: String(ctx.chat.id),
      userId: String(ctx.from.id),
      userName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
      groupId: ctx.chat.type !== 'private' ? String(ctx.chat.id) : undefined,
    };
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

    bot.catch((err) => {
      console.error('[telegram] Bot error:', err);
    });

    bot.on('message:text', async (ctx: GrammyContext) => {
      if (!this.handler) return;
      await this.handler({
        ...this.buildBaseMessage(ctx),
        text: ctx.message.text ?? '',
        raw: ctx,
      });
    });

    bot.on('message:photo', async (ctx: GrammyContext) => {
      if (!this.handler || !ctx.message.photo?.length) return;
      try {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        const buffer = await this.downloadFile(largest.file_id);
        await this.handler({
          ...this.buildBaseMessage(ctx),
          text: ctx.message.caption ?? '',
          attachments: [{ type: 'image', mimeType: 'image/jpeg', buffer }],
          raw: ctx,
        });
      } catch (err) {
        console.error('[telegram] Failed to download photo:', (err as Error).message);
      }
    });

    bot.on('message:voice', async (ctx: GrammyContext) => {
      if (!this.handler || !ctx.message.voice) return;
      try {
        const buffer = await this.downloadFile(ctx.message.voice.file_id);
        await this.handler({
          ...this.buildBaseMessage(ctx),
          text: ctx.message.caption ?? '',
          attachments: [
            {
              type: 'audio',
              mimeType: ctx.message.voice.mime_type ?? 'audio/ogg',
              buffer,
              filename: 'voice.ogg',
            },
          ],
          raw: ctx,
        });
      } catch (err) {
        console.error('[telegram] Failed to download voice:', (err as Error).message);
      }
    });

    bot.on('message:document', async (ctx: GrammyContext) => {
      if (!this.handler || !ctx.message.document) return;
      const doc = ctx.message.document;
      const isImage = doc.mime_type?.startsWith('image/');
      try {
        const buffer = await this.downloadFile(doc.file_id);
        await this.handler({
          ...this.buildBaseMessage(ctx),
          text: ctx.message.caption ?? '',
          attachments: [
            {
              type: isImage ? 'image' : 'file',
              mimeType: doc.mime_type ?? 'application/octet-stream',
              buffer,
              filename: doc.file_name,
            },
          ],
          raw: ctx,
        });
      } catch (err) {
        console.error('[telegram] Failed to download document:', (err as Error).message);
      }
    });

    if (this.config.webhook) {
      await bot.api.setWebhook(this.config.webhook.url);
    } else {
      await new Promise<void>((resolve, reject) => {
        bot
          .start({
            drop_pending_updates: true,
            onStart: () => resolve(),
          })
          .catch(reject);
      });
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
    const useMarkdown = options?.format === 'markdown';

    const sent = await this.bot.api.sendMessage(chatId, text, {
      ...(useMarkdown ? { parse_mode: 'Markdown' } : {}),
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

  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.setMessageReaction(Number(channelId), Number(messageId), [
      { type: 'emoji', emoji },
    ]);
  }
}

export function telegramChannel(config: TelegramConfig): Channel {
  return new TelegramChannel(config);
}
