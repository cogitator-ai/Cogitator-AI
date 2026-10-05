import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  Attachment,
  Channel,
  ChannelAction,
  ChannelButton,
  ChannelCommand,
  ChannelMessage,
  ChannelStop,
  ChannelType,
  DraftOptions,
  SendOptions,
} from '@cogitator-ai/types';
import { adaptMarkdown } from '../formatters/markdown';

export interface TelegramConfig {
  token: string;
  allowedUpdates?: string[];
  /**
   * Receive updates through a webhook instead of long polling.
   * A local HTTP server listens on `port` (and optional `path`, default: pathname of `url`)
   * and `url` is registered with Telegram.
   */
  webhook?: { url: string; port: number; path?: string; secretToken?: string };
  /**
   * Send Markdown as Telegram rich messages (Bot API 10.1+), which render standard Markdown
   * with headings, tables, code blocks, task lists, footnotes and formulas, up to 32768
   * characters. Default true. When a rich message is refused, the text goes out in Telegram's
   * classic Markdown instead.
   */
  richMessages?: boolean;
}

/** Who a command menu is for, as Telegram scopes it. */
export type TelegramCommandScope =
  | { type: 'default' }
  | { type: 'all_private_chats' }
  | { type: 'all_group_chats' }
  | { type: 'all_chat_administrators' }
  | { type: 'chat'; chatId: string }
  | { type: 'chat_administrators'; chatId: string }
  | { type: 'chat_member'; chatId: string; userId: string };

/** The bot's name and the texts users see before they start it. */
export interface TelegramProfile {
  /** 0-64 characters */
  name?: string;
  /** Shown in an empty chat with the bot, 0-512 characters */
  description?: string;
  /** Shown on the bot's profile and in shared links, 0-120 characters */
  shortDescription?: string;
  languageCode?: string;
}

interface BotInfo {
  id: number;
  first_name: string;
  username: string;
}

type InputFileLike = object;
type RawCall = (args?: Record<string, unknown>) => Promise<unknown>;

interface TelegramUpdateContext {
  update: { stopped_message_generation?: TelegramStoppedGeneration };
}

interface TelegramBot {
  on(event: string, handler: (ctx: GrammyContext) => Promise<void>): void;
  use(middleware: (ctx: TelegramUpdateContext, next: () => Promise<void>) => Promise<void>): void;
  catch(handler: (err: unknown) => void): void;
  init(): Promise<void>;
  start(options?: {
    drop_pending_updates?: boolean;
    allowed_updates?: string[];
    onStart?: (info: BotInfo) => void;
  }): Promise<void>;
  stop(): Promise<void>;
  api: { raw: Record<string, RawCall> };
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

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramFileRef & { duration: number };
  audio?: TelegramFileRef & { duration: number };
  video?: TelegramFileRef & { duration: number };
  video_note?: TelegramFileRef & { duration: number };
  animation?: TelegramFileRef & { duration: number };
  document?: TelegramFileRef;
  reply_to_message?: { message_id: number };
  chat?: { id: number; type: string };
}

interface TelegramStoppedGeneration {
  chat: { id: number };
  message_thread_id?: number;
  draft_id: number;
}

interface GrammyContext {
  message: TelegramMessage;
  chat: { id: number; type: string };
  from: TelegramUser;
  callbackQuery?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
}

/** Telegram's limit for a classic message and for a media caption. */
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
/** Telegram's limit for a rich message's text. */
const RICH_LIMIT = 32768;
const CALLBACK_DATA_BYTES = 64;
const COMMAND_RE = /^[a-z0-9_]{1,32}$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): number | undefined {
  const code = (err as { error_code?: unknown } | null)?.error_code;
  return typeof code === 'number' ? code : undefined;
}

function isEntityParseError(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes("can't parse entities") || msg.includes("Bad Request: can't parse");
}

function isNotModifiedError(err: unknown): boolean {
  return errorMessage(err).includes('message is not modified');
}

/** A request Telegram refused as malformed or unknown, which a simpler form may get through. */
function isRefused(err: unknown): boolean {
  const code = errorCode(err);
  return code === 400 || code === 404 || isEntityParseError(err);
}

/** Telegram answers 404 to a method this Bot API server does not know. */
function isUnknownMethod(err: unknown): boolean {
  return errorCode(err) === 404 || /method not found/i.test(errorMessage(err));
}

/** A chat id as Telegram takes it: a number, or a public `@username`. */
export function telegramChatId(id: string): number | string {
  return /^-?\d+$/.test(id) ? Number(id) : id;
}

function isPrivateChat(id: string): boolean {
  return /^\d+$/.test(id);
}

/** The inline keyboard for rows of buttons. */
export function telegramKeyboard(rows: ChannelButton[][]): {
  inline_keyboard: Record<string, unknown>[][];
} {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => {
        const base = { text: button.text, ...(button.style && { style: button.style }) };
        if (button.disabled) return { ...base, disabled: {} };
        if (button.url !== undefined) return { ...base, url: button.url };
        if (button.copyText !== undefined) return { ...base, copy_text: { text: button.copyText } };
        if (button.data !== undefined) {
          if (new TextEncoder().encode(button.data).length > CALLBACK_DATA_BYTES) {
            throw new Error(
              `Button "${button.text}" carries more than ${CALLBACK_DATA_BYTES} bytes of data`
            );
          }
          return { ...base, callback_data: button.data };
        }
        throw new Error(`Button "${button.text}" needs data, url, copyText or disabled`);
      })
    ),
  };
}

function linkPreviewOptions(
  preview: SendOptions['linkPreview']
): Record<string, unknown> | undefined {
  if (preview === undefined) return undefined;
  if (preview === false) return { is_disabled: true };
  return {
    ...(preview.url && { url: preview.url }),
    ...(preview.aboveText && { show_above_text: true }),
    ...(preview.size === 'small' && { prefer_small_media: true }),
    ...(preview.size === 'large' && { prefer_large_media: true }),
  };
}

/** Splits text at line breaks or spaces so every piece fits Telegram's limit. */
function chunk(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    const at = newline >= limit / 2 ? newline + 1 : space > 0 ? space + 1 : limit;
    pieces.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at);
  }
  if (rest.trim() || pieces.length === 0) pieces.push(rest);
  return pieces;
}

function sentId(result: unknown): string {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return id === undefined ? '' : String(id);
}

/**
 * Telegram through grammY, on the current Bot API: rich messages that render standard Markdown,
 * streamed drafts with a stop button, inline buttons with colors and their presses, topics,
 * captions and albums, message effects, link previews, ephemeral messages and command menus.
 * Every call goes through grammY's raw API, so a Bot API feature newer than the installed grammY
 * still works, and `call` reaches any method this class does not wrap.
 */
export class TelegramChannel implements Channel {
  readonly type: ChannelType = 'telegram';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private actionHandler: ((action: ChannelAction) => Promise<void>) | null = null;
  private stopHandler: ((stop: ChannelStop) => void) | null = null;
  private bot: TelegramBot | null = null;
  private grammy: GrammyModule | null = null;
  private server: Server | null = null;
  /** Set when the Bot API server does not know rich messages, so they are not tried again. */
  private richUnavailable = false;

  constructor(private readonly config: TelegramConfig) {}

  /**
   * With rich messages on, Markdown arrives as written (GitHub Flavored) and is adapted to
   * Telegram's classic Markdown here when a rich message cannot be sent.
   */
  get nativeMarkdown(): boolean {
    return this.config.richMessages !== false;
  }

  get maxMessageChars(): number {
    return this.nativeMarkdown ? RICH_LIMIT : TEXT_LIMIT;
  }

  /** Text for a classic message: Markdown written for rich messages is adapted first. */
  private classic(text: string, format: SendOptions['format']): string {
    return format === 'markdown' && this.nativeMarkdown ? adaptMarkdown(text, 'telegram') : text;
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  onAction(handler: (action: ChannelAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  onStop(handler: (stop: ChannelStop) => void): void {
    this.stopHandler = handler;
  }

  /** Calls any Bot API method by name, for features this class does not wrap. */
  async call<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const bot = this.requireBot();
    const fn = bot.api.raw[method];
    if (!fn) throw new Error(`Telegram method ${method} is not available`);
    return (await fn(args)) as T;
  }

  private requireBot(): TelegramBot {
    if (!this.bot) throw new Error('Telegram channel is not started');
    return this.bot;
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
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
    const topic = ctx.message.message_thread_id;
    return {
      id: String(ctx.message.message_id),
      channelType: 'telegram',
      channelId: String(ctx.chat.id),
      userId: String(ctx.from.id),
      userName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
      groupId: ctx.chat.type !== 'private' ? String(ctx.chat.id) : undefined,
      ...(replyTo !== undefined ? { replyTo: String(replyTo) } : {}),
      ...(topic !== undefined && (ctx.message.is_topic_message || ctx.chat.type === 'private')
        ? { topicId: String(topic) }
        : {}),
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

    bot.use(async (ctx, next) => {
      const stopped = ctx.update.stopped_message_generation;
      if (!stopped) {
        await next();
        return;
      }
      this.stopHandler?.({
        channelType: 'telegram',
        channelId: String(stopped.chat.id),
        draftId: stopped.draft_id,
        ...(stopped.message_thread_id !== undefined
          ? { topicId: String(stopped.message_thread_id) }
          : {}),
      });
    });

    bot.on('callback_query:data', async (ctx: GrammyContext) => {
      const query = ctx.callbackQuery;
      if (!query?.data) return;
      if (!this.actionHandler) {
        await this.answerAction(query.id).catch(() => {});
        return;
      }
      const message = query.message;
      const topic = message?.message_thread_id;
      await this.actionHandler({
        id: query.id,
        channelType: 'telegram',
        channelId: String(message?.chat?.id ?? query.from.id),
        userId: String(query.from.id),
        userName: query.from.first_name + (query.from.last_name ? ` ${query.from.last_name}` : ''),
        ...(message ? { messageId: String(message.message_id) } : {}),
        ...(topic !== undefined ? { topicId: String(topic) } : {}),
        data: query.data,
        raw: ctx,
      });
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

    bot.on('message:video_note', async (ctx: GrammyContext) => {
      const note = ctx.message.video_note;
      if (!note) return;
      await this.emitWithFile(ctx, note, {
        type: 'video',
        mimeType: 'video/mp4',
        filename: 'video_note.mp4',
      });
    });

    bot.on('message:animation', async (ctx: GrammyContext) => {
      const animation = ctx.message.animation;
      if (!animation) return;
      await this.emitWithFile(ctx, animation, {
        type: 'video',
        mimeType: animation.mime_type ?? 'video/mp4',
        filename: animation.file_name,
      });
    });

    bot.on('message:document', async (ctx: GrammyContext) => {
      const doc = ctx.message.document;
      if (!doc || ctx.message.animation) return;
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

    await bot.api.raw.setWebhook({
      url: webhook.url,
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

  /** The parameters every send shares: topic, reply, notification, protection, effect, buttons. */
  private envelope(options: SendOptions): Record<string, unknown> {
    return {
      ...(options.topicId ? { message_thread_id: Number(options.topicId) } : {}),
      ...(options.replyTo
        ? {
            reply_parameters: {
              message_id: Number(options.replyTo),
              allow_sending_without_reply: true,
            },
          }
        : {}),
      ...(options.silent ? { disable_notification: true } : {}),
      ...(options.protect ? { protect_content: true } : {}),
      ...(options.effect ? { message_effect_id: options.effect } : {}),
      ...(options.visibleTo
        ? { ephemeral_message_parameters: { receiver_user_id: Number(options.visibleTo) } }
        : {}),
      ...(options.buttons?.length ? { reply_markup: telegramKeyboard(options.buttons) } : {}),
    };
  }

  private get useRich(): boolean {
    return this.config.richMessages !== false && !this.richUnavailable;
  }

  /** Notes a refusal of a rich call, so an unknown method is not tried again. */
  private richRefused(err: unknown): void {
    if (isUnknownMethod(err)) this.richUnavailable = true;
  }

  async sendText(channelId: string, text: string, options: SendOptions = {}): Promise<string> {
    const chatId = telegramChatId(channelId);

    if (options.format === 'markdown' && this.useRich) {
      try {
        const sent = await this.call('sendRichMessage', {
          chat_id: chatId,
          rich_message: { markdown: text },
          ...this.envelope(options),
        });
        return sentId(sent);
      } catch (err) {
        if (!isRefused(err)) throw err;
        this.richRefused(err);
      }
    }

    return this.sendClassic(chatId, this.classic(text, options.format), options);
  }

  /**
   * A text message in Telegram's classic formatting, in as many messages as the limit needs:
   * the reply goes on the first, the buttons on the last, and a parse failure is sent as plain
   * text.
   */
  private async sendClassic(
    chatId: number | string,
    text: string,
    options: SendOptions
  ): Promise<string> {
    const parseMode =
      options.format === 'html' ? 'HTML' : options.format === 'markdown' ? 'Markdown' : undefined;
    const pieces = chunk(text, TEXT_LIMIT);
    const preview = linkPreviewOptions(options.linkPreview);
    let first = '';
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? '';
      const envelope = this.envelope({
        ...options,
        ...(i > 0 ? { replyTo: undefined } : {}),
        ...(i < pieces.length - 1 ? { buttons: undefined } : {}),
      });
      const args = {
        chat_id: chatId,
        text: piece,
        ...envelope,
        ...(preview ? { link_preview_options: preview } : {}),
      };
      let sent: unknown;
      if (parseMode) {
        try {
          sent = await this.call('sendMessage', { ...args, parse_mode: parseMode });
        } catch (err) {
          if (!isEntityParseError(err)) throw err;
          sent = await this.call('sendMessage', args);
        }
      } else {
        sent = await this.call('sendMessage', args);
      }
      if (i === 0) first = sentId(sent);
    }
    return first;
  }

  async editText(
    channelId: string,
    messageId: string,
    text: string,
    options: SendOptions = {}
  ): Promise<void> {
    const chatId = telegramChatId(channelId);
    const format = options.format ?? 'markdown';
    const target = {
      chat_id: chatId,
      message_id: Number(messageId),
      ...(options.buttons ? { reply_markup: telegramKeyboard(options.buttons) } : {}),
    };

    if (format === 'markdown' && this.useRich) {
      try {
        await this.call('editMessageText', { ...target, rich_message: { markdown: text } });
        return;
      } catch (err) {
        if (isNotModifiedError(err)) return;
        if (!isRefused(err)) throw err;
        this.richRefused(err);
      }
    }

    const classicText = this.classic(text, format);
    const clipped =
      classicText.length > TEXT_LIMIT ? classicText.slice(0, TEXT_LIMIT) : classicText;
    const parseMode = format === 'html' ? 'HTML' : format === 'markdown' ? 'Markdown' : undefined;
    try {
      await this.call('editMessageText', {
        ...target,
        text: clipped,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return;
    } catch (err) {
      if (isNotModifiedError(err)) return;
      if (!parseMode || !isEntityParseError(err)) throw err;
    }

    try {
      await this.call('editMessageText', { ...target, text: clipped });
    } catch (err) {
      if (!isNotModifiedError(err)) throw err;
    }
  }

  private source(file: Attachment): string | InputFileLike {
    if (file.buffer) {
      if (!this.grammy) throw new Error('Telegram channel is not started');
      return new this.grammy.InputFile(file.buffer, file.filename);
    }
    if (file.url) return file.url;
    throw new Error('Attachment must have either a buffer or a url');
  }

  /** The Bot API method and field a file is sent with. */
  private static mediaKind(file: Attachment): { method: string; field: string } {
    const mime = file.mimeType.toLowerCase();
    switch (file.type) {
      case 'image':
        return mime === 'image/gif'
          ? { method: 'sendAnimation', field: 'animation' }
          : { method: 'sendPhoto', field: 'photo' };
      case 'video':
        return { method: 'sendVideo', field: 'video' };
      case 'audio':
        return mime.includes('ogg') || mime.includes('opus')
          ? { method: 'sendVoice', field: 'voice' }
          : { method: 'sendAudio', field: 'audio' };
      default:
        return { method: 'sendDocument', field: 'document' };
    }
  }

  /** A caption in classic formatting, or none when it is too long to be one. */
  private caption(
    text: string | undefined,
    format: SendOptions['format']
  ): Record<string, unknown> {
    if (!text || text.length > CAPTION_LIMIT) return {};
    if (format === 'html') return { caption: text, parse_mode: 'HTML' };
    if (format === 'markdown') {
      return { caption: this.classic(text, format), parse_mode: 'Markdown' };
    }
    return { caption: text };
  }

  /** Sends one file and returns the id of its message. */
  async sendFile(channelId: string, file: Attachment, options: SendOptions = {}): Promise<string> {
    const chatId = telegramChatId(channelId);
    const { method, field } = TelegramChannel.mediaKind(file);
    const longCaption = (file.caption?.length ?? 0) > CAPTION_LIMIT;
    const args = {
      chat_id: chatId,
      [field]: this.source(file),
      ...this.caption(file.caption, options.format),
      ...this.envelope(longCaption ? { ...options, buttons: undefined } : options),
    };
    let sent: unknown;
    try {
      sent = await this.call(method, args);
    } catch (err) {
      if (!('parse_mode' in args) || !isEntityParseError(err)) throw err;
      const { parse_mode: _mode, ...plain } = args;
      sent = await this.call(method, { ...plain, caption: file.caption });
    }
    if (longCaption && file.caption) {
      await this.sendText(channelId, file.caption, { ...options, replyTo: undefined });
    }
    return sentId(sent);
  }

  /**
   * Sends files as albums of up to ten. Photos and videos share an album, while audio and
   * documents each go in albums of their own kind, as Telegram requires. Each file keeps its own
   * caption. Albums carry no buttons. Returns the ids of every message sent.
   */
  async sendFiles(
    channelId: string,
    files: Attachment[],
    options: SendOptions = {}
  ): Promise<string[]> {
    if (files.length === 1 && files[0]) {
      return [await this.sendFile(channelId, files[0], options)];
    }
    const kindOf = (file: Attachment) =>
      file.type === 'image' || file.type === 'video' ? 'visual' : file.type;
    const groups: Attachment[][] = [];
    for (const file of files) {
      const last = groups[groups.length - 1];
      if (last && last.length < 10 && last[0] && kindOf(last[0]) === kindOf(file)) last.push(file);
      else groups.push([file]);
    }
    const chatId = telegramChatId(channelId);
    let replyTo = options.replyTo;
    const ids: string[] = [];
    for (const group of groups) {
      if (group.length === 1 && group[0]) {
        ids.push(await this.sendFile(channelId, group[0], { ...options, replyTo }));
      } else {
        const album = await this.call('sendMediaGroup', {
          chat_id: chatId,
          media: group.map((file) => ({
            type:
              file.type === 'image'
                ? 'photo'
                : file.type === 'video'
                  ? 'video'
                  : file.type === 'audio'
                    ? 'audio'
                    : 'document',
            media: this.source(file),
            ...this.caption(file.caption, options.format),
          })),
          ...this.envelope({ ...options, replyTo, buttons: undefined, visibleTo: undefined }),
        });
        if (Array.isArray(album)) ids.push(...album.map(sentId));
      }
      replyTo = undefined;
    }
    return ids;
  }

  async sendTyping(channelId: string, options: Pick<SendOptions, 'topicId'> = {}): Promise<void> {
    if (!this.bot) return;
    await this.call('sendChatAction', {
      chat_id: telegramChatId(channelId),
      action: 'typing',
      ...(options.topicId ? { message_thread_id: Number(options.topicId) } : {}),
    });
  }

  /**
   * Streams a partial answer as a draft, a preview Telegram shows for 30 seconds; the final
   * answer is sent as a message. Drafts exist in private chats only, so a group throws and the
   * caller falls back to sending and editing messages. With `canStop`, the user gets a stop
   * button and the draft stays on screen after a press until the final message replaces it.
   */
  async sendDraft(
    channelId: string,
    draftId: number,
    text: string,
    options: DraftOptions = {}
  ): Promise<void> {
    if (!isPrivateChat(channelId)) {
      throw new Error('Telegram drafts can only be sent to private chats');
    }
    const base = {
      chat_id: Number(channelId),
      draft_id: draftId,
      ...(options.topicId ? { message_thread_id: Number(options.topicId) } : {}),
      ...(options.canStop ? { can_stop: true, keep_on_stop: true } : {}),
    };

    if (options.format === 'markdown' && this.useRich && text.trim()) {
      try {
        await this.call('sendRichMessageDraft', { ...base, rich_message: { markdown: text } });
        return;
      } catch (err) {
        if (!isRefused(err)) throw err;
        this.richRefused(err);
      }
    }

    const classic = this.classic(text, options.format);
    const clipped = classic.length > TEXT_LIMIT ? classic.slice(0, TEXT_LIMIT) : classic;
    try {
      await this.call('sendMessageDraft', {
        ...base,
        text: clipped,
        ...(options.format === 'markdown' ? { parse_mode: 'Markdown' } : {}),
      });
    } catch (err) {
      if (options.format !== 'markdown' || !isEntityParseError(err)) throw err;
      await this.call('sendMessageDraft', { ...base, text: clipped });
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.call('deleteMessage', {
      chat_id: telegramChatId(channelId),
      message_id: Number(messageId),
    });
  }

  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.bot) return;
    await this.call('setMessageReaction', {
      chat_id: telegramChatId(channelId),
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    });
  }

  async answerAction(
    actionId: string,
    options: { text?: string; alert?: boolean } = {}
  ): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: actionId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.alert ? { show_alert: true } : {}),
    });
  }

  async editButtons(
    channelId: string,
    messageId: string,
    buttons: ChannelButton[][] | null
  ): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', {
        chat_id: telegramChatId(channelId),
        message_id: Number(messageId),
        reply_markup: buttons ? telegramKeyboard(buttons) : { inline_keyboard: [] },
      });
    } catch (err) {
      if (!isNotModifiedError(err)) throw err;
    }
  }

  async setCommands(commands: ChannelCommand[], scope: { chatId?: string } = {}): Promise<void> {
    await this.setCommandMenu(commands, {
      scope: scope.chatId ? { type: 'chat', chatId: scope.chatId } : { type: 'default' },
    });
  }

  /** Sets the command menu for a scope and, optionally, a language. */
  async setCommandMenu(
    commands: ChannelCommand[],
    options: { scope?: TelegramCommandScope; languageCode?: string } = {}
  ): Promise<void> {
    for (const { command, description } of commands) {
      if (!COMMAND_RE.test(command)) {
        throw new Error(
          `Telegram command "${command}" must be 1-32 lowercase letters, digits or underscores`
        );
      }
      if (description.length < 1 || description.length > 256) {
        throw new Error(`The description of /${command} must be 1-256 characters`);
      }
    }
    await this.call('setMyCommands', {
      commands,
      ...this.scopeArgs(options),
    });
  }

  /** Removes the command menu of a scope. */
  async deleteCommandMenu(
    options: { scope?: TelegramCommandScope; languageCode?: string } = {}
  ): Promise<void> {
    await this.call('deleteMyCommands', this.scopeArgs(options));
  }

  private scopeArgs(options: {
    scope?: TelegramCommandScope;
    languageCode?: string;
  }): Record<string, unknown> {
    const scope = options.scope;
    const wire = !scope
      ? undefined
      : scope.type === 'chat' || scope.type === 'chat_administrators'
        ? { type: scope.type, chat_id: telegramChatId(scope.chatId) }
        : scope.type === 'chat_member'
          ? {
              type: scope.type,
              chat_id: telegramChatId(scope.chatId),
              user_id: Number(scope.userId),
            }
          : { type: scope.type };
    return {
      ...(wire ? { scope: wire } : {}),
      ...(options.languageCode ? { language_code: options.languageCode } : {}),
    };
  }

  /** Sets the bot's name, description and short description; fields left out are not changed. */
  async setProfile(profile: TelegramProfile): Promise<void> {
    const language = profile.languageCode ? { language_code: profile.languageCode } : {};
    if (profile.name !== undefined)
      await this.call('setMyName', { name: profile.name, ...language });
    if (profile.description !== undefined) {
      await this.call('setMyDescription', { description: profile.description, ...language });
    }
    if (profile.shortDescription !== undefined) {
      await this.call('setMyShortDescription', {
        short_description: profile.shortDescription,
        ...language,
      });
    }
  }
}

export function telegramChannel(config: TelegramConfig): TelegramChannel {
  return new TelegramChannel(config);
}
