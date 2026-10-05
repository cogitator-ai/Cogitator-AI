import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelAction, ChannelMessage, ChannelStop } from '@cogitator-ai/types';

type Handler = (ctx: unknown) => Promise<void>;
type Middleware = (ctx: unknown, next: () => Promise<void>) => Promise<void>;
type RawFn = ReturnType<typeof import('vitest').vi.fn>;

const state = vi.hoisted(() => ({
  bots: [] as Array<{
    handlers: Map<string, Handler>;
    middleware: Middleware[];
    raw: Record<string, RawFn>;
    start: ReturnType<typeof import('vitest').vi.fn>;
    stop: ReturnType<typeof import('vitest').vi.fn>;
    init: ReturnType<typeof import('vitest').vi.fn>;
  }>,
}));

vi.mock('grammy', () => {
  class Bot {
    handlers = new Map<string, Handler>();
    middleware: Middleware[] = [];
    raw: Record<string, RawFn> = {};
    api = {
      raw: new Proxy(this.raw, {
        get: (target, method: string) => {
          target[method] ??= vi
            .fn()
            .mockResolvedValue(method.startsWith('send') ? { message_id: 7 } : true);
          return target[method];
        },
      }),
    };
    start = vi.fn((opts: { onStart?: () => void }) => {
      opts.onStart?.();
      return new Promise<void>(() => {});
    });
    stop = vi.fn().mockResolvedValue(undefined);
    init = vi.fn().mockResolvedValue(undefined);
    constructor(_token: string) {
      state.bots.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
    use(middleware: Middleware) {
      this.middleware.push(middleware);
    }
    catch() {}
  }
  class InputFile {
    constructor(
      public file: Uint8Array,
      public filename?: string
    ) {}
  }
  const webhookCallback = vi.fn(() => {
    return async (_req: unknown, res: { end(): void; statusCode: number }) => {
      res.statusCode = 200;
      res.end();
    };
  });
  return { Bot, InputFile, webhookCallback };
});

const { TelegramChannel, telegramChatId, telegramKeyboard } = await import('../channels/telegram');

function ctx(message: Record<string, unknown>, chatType = 'private') {
  return {
    message: { message_id: 1, ...message },
    chat: { id: 100, type: chatType },
    from: { id: 5, first_name: 'Ann', last_name: 'Lee' },
  };
}

function apiError(code: number, description: string) {
  return Object.assign(new Error(description), { error_code: code });
}

async function started(config: Record<string, unknown> = {}) {
  const channel = new TelegramChannel({ token: 't', ...config });
  await channel.start();
  const bot = state.bots[state.bots.length - 1]!;
  const raw = (method: string): RawFn => {
    bot.raw[method] ??= vi
      .fn()
      .mockResolvedValue(method.startsWith('send') ? { message_id: 7 } : true);
    return bot.raw[method];
  };
  return { channel, bot, raw };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    state.bots.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('incoming', () => {
    it('emits text messages with group, reply and topic metadata', async () => {
      const { channel, bot } = await started();
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      await bot.handlers.get('message:text')!(
        ctx(
          {
            text: 'hi',
            reply_to_message: { message_id: 9 },
            message_thread_id: 44,
            is_topic_message: true,
          },
          'supergroup'
        )
      );

      expect(handler.mock.calls[0][0] as ChannelMessage).toEqual(
        expect.objectContaining({
          text: 'hi',
          userName: 'Ann Lee',
          groupId: '100',
          replyTo: '9',
          channelId: '100',
          topicId: '44',
        })
      );
    });

    it('downloads voice and audio files as attachments', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(3)) })
      );
      const { channel, bot, raw } = await started({ token: 'secret' });
      raw('getFile').mockResolvedValue({ file_path: 'music/a.mp3' });
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      await bot.handlers.get('message:audio')!(
        ctx({ audio: { file_id: 'f', duration: 3, mime_type: 'audio/mpeg', file_name: 'a.mp3' } })
      );

      expect(raw('getFile')).toHaveBeenCalledWith({ file_id: 'f' });
      expect((handler.mock.calls[0][0] as ChannelMessage).attachments?.[0]).toEqual(
        expect.objectContaining({ type: 'audio', mimeType: 'audio/mpeg', filename: 'a.mp3' })
      );
    });

    it('turns a button press into an action, and answers presses nobody handles', async () => {
      const { channel, bot, raw } = await started();
      const press = {
        callbackQuery: {
          id: 'q1',
          from: { id: 5, first_name: 'Ann' },
          data: 'pick:2',
          message: { message_id: 30, message_thread_id: 8, chat: { id: -100200, type: 'group' } },
        },
      };

      await bot.handlers.get('callback_query:data')!(press);
      expect(raw('answerCallbackQuery')).toHaveBeenCalledWith({ callback_query_id: 'q1' });

      const actions: ChannelAction[] = [];
      channel.onAction((action) => {
        actions.push(action);
        return Promise.resolve();
      });
      await bot.handlers.get('callback_query:data')!(press);
      expect(actions[0]).toEqual(
        expect.objectContaining({
          id: 'q1',
          channelId: '-100200',
          userId: '5',
          messageId: '30',
          topicId: '8',
          data: 'pick:2',
        })
      );

      await channel.answerAction('q1', { text: 'Done', alert: true });
      expect(raw('answerCallbackQuery')).toHaveBeenLastCalledWith({
        callback_query_id: 'q1',
        text: 'Done',
        show_alert: true,
      });
    });

    it('reports a stopped draft and lets every other update through', async () => {
      const { channel, bot } = await started();
      const stops: ChannelStop[] = [];
      channel.onStop((stop) => stops.push(stop));
      const next = vi.fn().mockResolvedValue(undefined);

      await bot.middleware[0]!(
        {
          update: {
            stopped_message_generation: { chat: { id: 77 }, draft_id: 12, message_thread_id: 3 },
          },
        },
        next
      );
      await bot.middleware[0]!({ update: { message: {} } }, next);

      expect(stops).toEqual([
        { channelType: 'telegram', channelId: '77', draftId: 12, topicId: '3' },
      ]);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('sending text', () => {
    it('sends Markdown as a rich message with everything the options ask for', async () => {
      const { channel, raw } = await started();

      const id = await channel.sendText('@paper', '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |', {
        format: 'markdown',
        replyTo: '3',
        topicId: '9',
        silent: true,
        protect: true,
        effect: '5104841245755180586',
        visibleTo: '42',
        buttons: [
          [
            { text: 'Yes', data: 'yes', style: 'success' },
            { text: 'Docs', url: 'https://cogitator.app' },
          ],
          [
            { text: 'Copy', copyText: 'code' },
            { text: 'Later', disabled: true },
          ],
        ],
      });

      expect(id).toBe('7');
      expect(raw('sendRichMessage')).toHaveBeenCalledWith({
        chat_id: '@paper',
        rich_message: { markdown: '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
        message_thread_id: 9,
        reply_parameters: { message_id: 3, allow_sending_without_reply: true },
        disable_notification: true,
        protect_content: true,
        message_effect_id: '5104841245755180586',
        ephemeral_message_parameters: { receiver_user_id: 42 },
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Yes', style: 'success', callback_data: 'yes' },
              { text: 'Docs', url: 'https://cogitator.app' },
            ],
            [
              { text: 'Copy', copy_text: { text: 'code' } },
              { text: 'Later', disabled: {} },
            ],
          ],
        },
      });
    });

    it('falls back to classic Markdown, split at the limit, when a rich message is refused', async () => {
      const { channel, raw } = await started();
      raw('sendRichMessage').mockRejectedValueOnce(
        apiError(400, 'Bad Request: RICH_MESSAGE_INVALID')
      );
      raw('sendMessage')
        .mockResolvedValueOnce({ message_id: 1 })
        .mockResolvedValueOnce({ message_id: 2 });
      const long = `## Heading\n\n${'word '.repeat(1000)}`;

      const id = await channel.sendText('100', long, {
        format: 'markdown',
        replyTo: '3',
        buttons: [[{ text: 'Ok', data: 'ok' }]],
      });

      expect(id).toBe('1');
      const calls = raw('sendMessage').mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(
        expect.objectContaining({
          parse_mode: 'Markdown',
          reply_parameters: { message_id: 3, allow_sending_without_reply: true },
        })
      );
      expect(String(calls[0]!.text)).toMatch(/^\*Heading\*/);
      expect(calls[0]).not.toHaveProperty('reply_markup');
      expect(calls[1]).not.toHaveProperty('reply_parameters');
      expect(calls[1]).toHaveProperty('reply_markup');
      expect(String(calls[0]!.text).length).toBeLessThanOrEqual(4096);
    });

    it('stops trying rich messages on a Bot API server that does not know them', async () => {
      const { channel, raw } = await started();
      raw('sendRichMessage').mockRejectedValueOnce(apiError(404, 'Not Found: method not found'));

      await channel.sendText('100', 'one', { format: 'markdown' });
      await channel.sendText('100', 'two', { format: 'markdown' });

      expect(raw('sendRichMessage')).toHaveBeenCalledTimes(1);
      expect(raw('sendMessage')).toHaveBeenCalledTimes(2);
    });

    it('sends classic Markdown as written when rich messages are off', async () => {
      const { channel, raw } = await started({ richMessages: false });
      expect(channel.nativeMarkdown).toBe(false);
      expect(channel.maxMessageChars).toBe(4096);

      await channel.sendText('100', '*bold*', { format: 'markdown' });

      expect(raw('sendRichMessage')).not.toHaveBeenCalled();
      expect(raw('sendMessage')).toHaveBeenCalledWith(
        expect.objectContaining({ text: '*bold*', parse_mode: 'Markdown' })
      );
    });

    it('sends HTML with the HTML parse mode, and plain text when it cannot be parsed', async () => {
      const { channel, raw } = await started();
      raw('sendMessage').mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));

      await channel.sendText('100', '<b>bold', { format: 'html', linkPreview: false });

      const [first, second] = raw('sendMessage').mock.calls.map(
        (call) => call[0] as Record<string, unknown>
      );
      expect(first).toEqual(
        expect.objectContaining({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      );
      expect(second).not.toHaveProperty('parse_mode');
    });

    it('takes numeric ids as numbers and public usernames as they are', () => {
      expect(telegramChatId('-1003921845978')).toBe(-1003921845978);
      expect(telegramChatId('42')).toBe(42);
      expect(telegramChatId('@dailypaper')).toBe('@dailypaper');
    });

    it('refuses a button with too much data or nothing to do', () => {
      expect(() => telegramKeyboard([[{ text: 'x', data: 'x'.repeat(65) }]])).toThrow('64 bytes');
      expect(() => telegramKeyboard([[{ text: 'x' }]])).toThrow('needs data');
    });
  });

  describe('editing', () => {
    it('edits as a rich message, ignores "not modified" and falls back to classic text', async () => {
      const { channel, raw } = await started();
      await channel.editText('1', '2', '**done**');
      expect(raw('editMessageText')).toHaveBeenLastCalledWith({
        chat_id: 1,
        message_id: 2,
        rich_message: { markdown: '**done**' },
      });

      raw('editMessageText').mockRejectedValueOnce(
        new Error('Bad Request: message is not modified')
      );
      await expect(channel.editText('1', '2', 'x')).resolves.toBeUndefined();

      raw('editMessageText').mockRejectedValueOnce(apiError(400, 'Bad Request: RICH_INVALID'));
      await channel.editText('1', '2', '**bold**');
      expect(raw('editMessageText')).toHaveBeenLastCalledWith({
        chat_id: 1,
        message_id: 2,
        text: '*bold*',
        parse_mode: 'Markdown',
      });

      raw('editMessageText').mockRejectedValueOnce(apiError(429, 'Too Many Requests'));
      await expect(channel.editText('1', '2', 'y')).rejects.toThrow('Too Many Requests');
    });

    it('replaces and removes buttons', async () => {
      const { channel, raw } = await started();
      await channel.editButtons('1', '2', [[{ text: 'Done', disabled: true, style: 'success' }]]);
      await channel.editButtons('1', '2', null);
      expect(raw('editMessageReplyMarkup').mock.calls.map((call) => call[0])).toEqual([
        {
          chat_id: 1,
          message_id: 2,
          reply_markup: { inline_keyboard: [[{ text: 'Done', style: 'success', disabled: {} }]] },
        },
        { chat_id: 1, message_id: 2, reply_markup: { inline_keyboard: [] } },
      ]);
    });
  });

  describe('files', () => {
    it('sends each kind with its method, a caption and the options', async () => {
      const { channel, raw } = await started();

      await channel.sendFile(
        '1',
        {
          type: 'image',
          mimeType: 'image/png',
          buffer: new Uint8Array([1]),
          filename: 'a.png',
          caption: '**Card**',
        },
        { format: 'markdown', buttons: [[{ text: 'Open', url: 'https://x.test' }]] }
      );
      await channel.sendFile('1', { type: 'image', mimeType: 'image/gif', url: 'https://g' });
      await channel.sendFile('1', { type: 'audio', mimeType: 'audio/ogg', url: 'https://v' });
      await channel.sendFile('1', { type: 'audio', mimeType: 'audio/mpeg', url: 'https://a' });
      await channel.sendFile('1', { type: 'video', mimeType: 'video/mp4', url: 'https://m' });

      expect(raw('sendPhoto')).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: 1,
          photo: expect.objectContaining({ filename: 'a.png' }),
          caption: '*Card*',
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://x.test' }]] },
        })
      );
      expect(raw('sendAnimation')).toHaveBeenCalledWith({ chat_id: 1, animation: 'https://g' });
      expect(raw('sendVoice')).toHaveBeenCalledWith({ chat_id: 1, voice: 'https://v' });
      expect(raw('sendAudio')).toHaveBeenCalledWith({ chat_id: 1, audio: 'https://a' });
      expect(raw('sendVideo')).toHaveBeenCalledWith({ chat_id: 1, video: 'https://m' });
      await expect(channel.sendFile('1', { type: 'file', mimeType: 'x/y' })).rejects.toThrow(
        'buffer or a url'
      );
    });

    it('sends a caption too long for the file as its own message after it', async () => {
      const { channel, raw } = await started();
      await channel.sendFile('1', {
        type: 'file',
        mimeType: 'application/pdf',
        url: 'https://d',
        caption: 'x'.repeat(1500),
      });
      expect(raw('sendDocument')).toHaveBeenCalledWith({ chat_id: 1, document: 'https://d' });
      expect(raw('sendMessage')).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'x'.repeat(1500) })
      );
    });

    it('sends GIFs on their own and long album captions after the album', async () => {
      const { channel, raw } = await started();
      raw('sendMediaGroup').mockResolvedValueOnce([{ message_id: 20 }, { message_id: 21 }]);
      const ids = await channel.sendFiles('1', [
        { type: 'image', mimeType: 'image/jpeg', url: 'https://1', caption: 'x'.repeat(1100) },
        { type: 'image', mimeType: 'image/gif', url: 'https://2' },
        { type: 'image', mimeType: 'image/jpeg', url: 'https://3' },
        { type: 'video', mimeType: 'video/mp4', url: 'https://4' },
      ]);

      expect(raw('sendPhoto')).toHaveBeenCalledWith({ chat_id: 1, photo: 'https://1' });
      expect(raw('sendMessage')).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'x'.repeat(1100) })
      );
      expect(raw('sendAnimation')).toHaveBeenCalledWith({ chat_id: 1, animation: 'https://2' });
      expect(raw('sendMediaGroup')).toHaveBeenCalledWith({
        chat_id: 1,
        media: [
          { type: 'photo', media: 'https://3' },
          { type: 'video', media: 'https://4' },
        ],
      });
      expect(ids).toEqual(['7', '7', '20', '21']);
    });

    it('keeps an oversized caption of an album file as a message after the album', async () => {
      const { channel, raw } = await started();
      raw('sendMediaGroup').mockResolvedValueOnce([{ message_id: 10 }, { message_id: 11 }]);
      const ids = await channel.sendFiles('1', [
        { type: 'image', mimeType: 'image/jpeg', url: 'https://1', caption: 'y'.repeat(1100) },
        { type: 'image', mimeType: 'image/jpeg', url: 'https://2' },
      ]);
      expect(raw('sendMediaGroup').mock.calls[0]?.[0]).toEqual({
        chat_id: 1,
        media: [
          { type: 'photo', media: 'https://1' },
          { type: 'photo', media: 'https://2' },
        ],
      });
      expect(raw('sendMessage')).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'y'.repeat(1100) })
      );
      expect(ids).toEqual(['10', '11', '7']);
    });

    it('groups photos and videos into albums and keeps documents apart', async () => {
      const { channel, raw } = await started();
      await channel.sendFiles(
        '1',
        [
          { type: 'image', mimeType: 'image/jpeg', url: 'https://1', caption: 'first' },
          { type: 'video', mimeType: 'video/mp4', url: 'https://2' },
          { type: 'file', mimeType: 'application/pdf', url: 'https://3' },
          { type: 'file', mimeType: 'application/pdf', url: 'https://4' },
        ],
        { replyTo: '5' }
      );

      const albums = raw('sendMediaGroup').mock.calls.map(
        (call) => call[0] as Record<string, unknown>
      );
      expect(albums).toHaveLength(2);
      expect(albums[0]).toEqual({
        chat_id: 1,
        media: [
          { type: 'photo', media: 'https://1', caption: 'first' },
          { type: 'video', media: 'https://2' },
        ],
        reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      });
      expect(albums[1]).toEqual({
        chat_id: 1,
        media: [
          { type: 'document', media: 'https://3' },
          { type: 'document', media: 'https://4' },
        ],
      });
    });
  });

  describe('drafts', () => {
    it('streams a rich draft with a stop button into a topic', async () => {
      const { channel, raw } = await started();
      await channel.sendDraft('77', 5, '**thinking**', {
        format: 'markdown',
        topicId: '2',
        canStop: true,
      });
      expect(raw('sendRichMessageDraft')).toHaveBeenCalledWith({
        chat_id: 77,
        draft_id: 5,
        message_thread_id: 2,
        can_stop: true,
        keep_on_stop: true,
        rich_message: { markdown: '**thinking**' },
      });
    });

    it('falls back to a classic draft, and refuses groups', async () => {
      const { channel, raw } = await started();
      raw('sendRichMessageDraft').mockRejectedValueOnce(apiError(400, 'Bad Request: RICH_INVALID'));

      await channel.sendDraft('77', 5, '**bold**', { format: 'markdown' });

      expect(raw('sendMessageDraft')).toHaveBeenCalledWith({
        chat_id: 77,
        draft_id: 5,
        text: '*bold*',
        parse_mode: 'Markdown',
      });
      await expect(channel.sendDraft('-100', 5, 'x')).rejects.toThrow('private chats');
    });
  });

  describe('commands and profile', () => {
    it('sets a command menu for one chat and refuses malformed commands', async () => {
      const { channel, raw } = await started();
      await channel.setCommands([{ command: 'status', description: 'What is going on' }], {
        chatId: '5527347495',
      });
      expect(raw('setMyCommands')).toHaveBeenCalledWith({
        commands: [{ command: 'status', description: 'What is going on' }],
        scope: { type: 'chat', chat_id: 5527347495 },
      });

      await channel.setCommandMenu([{ command: 'help', description: 'Help' }], {
        scope: { type: 'all_private_chats' },
        languageCode: 'en',
      });
      expect(raw('setMyCommands')).toHaveBeenLastCalledWith({
        commands: [{ command: 'help', description: 'Help' }],
        scope: { type: 'all_private_chats' },
        language_code: 'en',
      });

      await expect(channel.setCommands([{ command: 'Run-Now', description: 'x' }])).rejects.toThrow(
        'lowercase'
      );
    });

    it('sets only the profile fields it is given', async () => {
      const { channel, raw } = await started();
      await channel.setProfile({ name: 'Desk', shortDescription: 'Private' });
      expect(raw('setMyName')).toHaveBeenCalledWith({ name: 'Desk' });
      expect(raw('setMyShortDescription')).toHaveBeenCalledWith({ short_description: 'Private' });
      expect(raw('setMyDescription')).not.toHaveBeenCalled();
    });

    it('calls any Bot API method by name', async () => {
      const { channel, raw } = await started();
      await channel.call('sendPoll', { chat_id: 1, question: 'Q', options: [] });
      expect(raw('sendPoll')).toHaveBeenCalledWith({ chat_id: 1, question: 'Q', options: [] });
    });
  });

  it('throws when used before start', async () => {
    const channel = new TelegramChannel({ token: 't' });
    await expect(channel.sendText('1', 'x')).rejects.toThrow('not started');
  });

  it('webhook mode serves updates over HTTP and registers the webhook', async () => {
    const port = 41000 + Math.floor(Math.random() * 1000);
    const { channel, bot, raw } = await started({
      webhook: { url: 'https://bot.example.com/tg/hook', port, secretToken: 's3cret' },
    });

    expect(bot.init).toHaveBeenCalled();
    expect(bot.start).not.toHaveBeenCalled();
    expect(raw('setWebhook')).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://bot.example.com/tg/hook', secret_token: 's3cret' })
    );

    const hit = await fetch(`http://127.0.0.1:${port}/tg/hook`, { method: 'POST', body: '{}' });
    expect(hit.status).toBe(200);
    const miss = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', body: '{}' });
    expect(miss.status).toBe(404);

    await channel.stop();
    await expect(fetch(`http://127.0.0.1:${port}/tg/hook`, { method: 'POST' })).rejects.toThrow();
  });
});
