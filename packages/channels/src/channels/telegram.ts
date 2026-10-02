import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
  /**
   * Receive updates through a webhook instead of long polling.
   * A local HTTP server listens on `port` (and optional `path`, default: pathname of `url`)
   * and `url` is registered with Telegram.
   */
  webhook?: { url: string; port: number; path?: string; secretToken?: string };
}

interface BotInfo {
  id: number;
  first_name: string;
  username: string;
}

type InputFileLike = object;

interface TelegramBot {
  on(event: string, handler: (ctx: GrammyContext) => Promise<void>): void;
  catch(handler: (err: unknown) => void): void;
  init(): Promise<void>;
  start(options?: {
    drop_pending_updates?: boolean;
    allowed_updates?: string[];
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
    sendPhoto(chatId: number, photo: string | InputFileLike): Promise<unknown>;
    sendDocument(chatId: number, document: string | InputFileLike): Promise<unknown>;
    sendAudio(chatId: number, audio: string | InputFileLike): Promise<unknown>;
    sendVideo(chatId: number, video: string | InputFileLike): Promise<unknown>;
    sendMessageDraft(
      chatId: number,
      draftId: number,
      text: string,
      options?: Record<string, unknown>
    ): Promise<true>;
    deleteMessage(chatId: number, messageId: number): Promise<unknown>;
    sendChatAction(chatId: number, action: string): Promise<unknown>;
    setWebhook(url: string, options?: Record<string, unknown>): Promise<unknown>;
    deleteWebhook(options?: Record<string, unknown>): Promise<unknown>;
    getFile(fileId: string): Promise<{ file_path?: string }>;
    setMessageReaction(
      chatId: number,
      messageId: number,
      reaction: { type: string; emoji: string }[],
      options?: Record<string, unknown>
    ): Promise<unknown>;
  };
}

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface GrammyModule {
  Bot: new (token: string) => unknown;
  InputFile: new (file: Uint8Array, filename?: string) => InputFileLike;
  webhookCallback: (
    bot: unknown,
    adapter: 'http',
    options?: { secretToken?: string }
  ) => WebhookHandler;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface GrammyContext {
  message: {
    message_id: number;
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    voice?: TelegramFileRef & { duration: number };
    audio?: TelegramFileRef & { duration: number };
    video?: TelegramFileRef & { duration: number };
    document?: TelegramFileRef;
    reply_to_message?: { message_id: number };
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

const NOT_MODIFIED = 'message is not modified';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEntityParseError(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes("can't parse entities") || msg.includes("Bad Request: can't parse");
}

function isNotModifiedError(err: unknown): boolean {
  return errorMessage(err).includes(NOT_MODIFIED);
}

export class TelegramChannel implements Channel {
  readonly type: ChannelType = 'telegram';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private bot: TelegramBot | null = null;
  private grammy: GrammyModule | null = null;
  private server: Server | null = null;

  constructor(private readonly config: TelegramConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  private requireBot(): TelegramBot {
    if (!this.bot) throw new Error('Telegram channel is not started');
    return this.bot;
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const bot = this.requireBot();
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
    const replyTo = ctx.message.reply_to_message?.message_id;
    return {
      id: String(ctx.message.message_id),
      channelType: 'telegram',
      channelId: String(ctx.chat.id),
      userId: String(ctx.from.id),
      userName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
      groupId: ctx.chat.type !== 'private' ? String(ctx.chat.id) : undefined,
      ...(replyTo !== undefined ? { replyTo: String(replyTo) } : {}),
    };
  }

  private async emitWithFile(
    ctx: GrammyContext,
    file: TelegramFileRef,
    attachment: Omit<Attachment, 'buffer'>
  ): Promise<void> {
    if (!this.handler) return;
    try {
      const buffer = await this.downloadFile(file.file_id);
      await this.handler({
        ...this.buildBaseMessage(ctx),
        text: ctx.message.caption ?? '',
        attachments: [{ ...attachment, buffer }],
        raw: ctx,
      });
    } catch (err) {
      console.error(`[telegram] Failed to process ${attachment.type}:`, errorMessage(err));
    }
  }

  async start(): Promise<void> {
    if (this.bot) return;

    let grammy: GrammyModule;
    try {
      grammy = (await import('grammy')) as unknown as GrammyModule;
    } catch {
      throw new Error('grammy is required for Telegram support. Install it: pnpm add grammy');
    }
    this.grammy = grammy;

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
      const photos = ctx.message.photo;
      if (!photos?.length) return;
      await this.emitWithFile(ctx, photos[photos.length - 1], {
        type: 'image',
        mimeType: 'image/jpeg',
      });
    });

    bot.on('message:voice', async (ctx: GrammyContext) => {
      const voice = ctx.message.voice;
      if (!voice) return;
      await this.emitWithFile(ctx, voice, {
        type: 'audio',
        mimeType: voice.mime_type ?? 'audio/ogg',
        filename: 'voice.ogg',
      });
    });

    bot.on('message:audio', async (ctx: GrammyContext) => {
      const audio = ctx.message.audio;
      if (!audio) return;
      await this.emitWithFile(ctx, audio, {
        type: 'audio',
        mimeType: audio.mime_type ?? 'audio/mpeg',
        filename: audio.file_name,
      });
    });

    bot.on('message:video', async (ctx: GrammyContext) => {
      const video = ctx.message.video;
      if (!video) return;
      await this.emitWithFile(ctx, video, {
        type: 'video',
        mimeType: video.mime_type ?? 'video/mp4',
        filename: video.file_name,
      });
    });

    bot.on('message:document', async (ctx: GrammyContext) => {
      const doc = ctx.message.document;
      if (!doc) return;
      const isImage = doc.mime_type?.startsWith('image/') ?? false;
      await this.emitWithFile(ctx, doc, {
        type: isImage ? 'image' : 'file',
        mimeType: doc.mime_type ?? 'application/octet-stream',
        filename: doc.file_name,
      });
    });

    try {
      if (this.config.webhook) {
        await this.startWebhook(bot, grammy, this.config.webhook);
      } else {
        await new Promise<void>((resolve, reject) => {
          bot
            .start({
              drop_pending_updates: true,
              ...(this.config.allowedUpdates
                ? { allowed_updates: this.config.allowedUpdates }
                : {}),
              onStart: () => resolve(),
            })
            .catch(reject);
        });
      }
    } catch (err) {
      this.bot = null;
      await this.closeServer();
      throw err;
    }
  }

  private async startWebhook(
    bot: TelegramBot,
    grammy: GrammyModule,
    webhook: NonNullable<TelegramConfig['webhook']>
  ): Promise<void> {
    await bot.init();

    const handle = grammy.webhookCallback(bot, 'http', {
      ...(webhook.secretToken ? { secretToken: webhook.secretToken } : {}),
    });
    const path = webhook.path ?? (new URL(webhook.url).pathname || '/');

    const server = createServer((req, res) => {
      const reqPath = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method !== 'POST' || reqPath !== path) {
        res.statusCode = 404;
        res.end();
        return;
      }
      handle(req, res).catch((err: unknown) => {
        console.error('[telegram] Webhook handler error:', errorMessage(err));
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(webhook.port, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;

    await bot.api.setWebhook(webhook.url, {
      drop_pending_updates: true,
      ...(this.config.allowedUpdates ? { allowed_updates: this.config.allowedUpdates } : {}),
      ...(webhook.secretToken ? { secret_token: webhook.secretToken } : {}),
    });
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async stop(): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    this.bot = null;

    if (this.config.webhook) {
      await this.closeServer();
    } else {
      await bot.stop();
    }
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const bot = this.requireBot();

    const chatId = Number(channelId);
    const useMarkdown = options?.format === 'markdown';
    const baseOpts = {
      ...(options?.replyTo
        ? {
            reply_parameters: {
              message_id: Number(options.replyTo),
              allow_sending_without_reply: true,
            },
          }
        : {}),
      ...(options?.silent ? { disable_notification: true } : {}),
    };

    if (useMarkdown) {
      try {
        const sent = await bot.api.sendMessage(chatId, text, {
          ...baseOpts,
          parse_mode: 'Markdown',
        });
        return String(sent.message_id);
      } catch (err) {
        if (!isEntityParseError(err)) throw err;
      }
    }

    const sent = await bot.api.sendMessage(chatId, text, baseOpts);
    return String(sent.message_id);
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const bot = this.requireBot();
    const chatId = Number(channelId);
    const msgId = Number(messageId);

    try {
      await bot.api.editMessageText(chatId, msgId, text, { parse_mode: 'Markdown' });
      return;
    } catch (err) {
      if (isNotModifiedError(err)) return;
      if (!isEntityParseError(err)) throw err;
    }

    try {
      await bot.api.editMessageText(chatId, msgId, text);
    } catch (err) {
      if (!isNotModifiedError(err)) throw err;
    }
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    const bot = this.requireBot();
    const chatId = Number(channelId);

    let source: string | InputFileLike;
    if (file.buffer) {
      if (!this.grammy) throw new Error('Telegram channel is not started');
      source = new this.grammy.InputFile(file.buffer, file.filename);
    } else if (file.url) {
      source = file.url;
    } else {
      throw new Error('Attachment must have either a buffer or a url');
    }

    switch (file.type) {
      case 'image':
        await bot.api.sendPhoto(chatId, source);
        return;
      case 'audio':
        await bot.api.sendAudio(chatId, source);
        return;
      case 'video':
        await bot.api.sendVideo(chatId, source);
        return;
      default:
        await bot.api.sendDocument(chatId, source);
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(channelId), 'typing');
  }

  async sendDraft(
    channelId: string,
    draftId: number,
    text: string,
    options?: SendOptions
  ): Promise<void> {
    const bot = this.requireBot();
    const useMarkdown = options?.format === 'markdown';
    await bot.api.sendMessageDraft(Number(channelId), draftId, text, {
      ...(useMarkdown ? { parse_mode: 'Markdown' } : {}),
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const bot = this.requireBot();
    await bot.api.deleteMessage(Number(channelId), Number(messageId));
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
