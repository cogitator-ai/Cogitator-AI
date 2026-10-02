import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '@cogitator-ai/types';

type Handler = (ctx: unknown) => Promise<void>;

const state = vi.hoisted(() => ({
  bots: [] as Array<{
    handlers: Map<string, Handler>;
    api: Record<string, ReturnType<typeof import('vitest').vi.fn>>;
    start: ReturnType<typeof import('vitest').vi.fn>;
    stop: ReturnType<typeof import('vitest').vi.fn>;
    init: ReturnType<typeof import('vitest').vi.fn>;
  }>,
  webhookHandler: null as
    null | ((req: unknown, res: { end(): void; statusCode: number }) => Promise<void>),
}));

vi.mock('grammy', () => {
  class Bot {
    handlers = new Map<string, Handler>();
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      sendPhoto: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
      sendAudio: vi.fn().mockResolvedValue({}),
      sendVideo: vi.fn().mockResolvedValue({}),
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(true),
      setWebhook: vi.fn().mockResolvedValue(true),
      deleteWebhook: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file.oga' }),
      setMessageReaction: vi.fn().mockResolvedValue(true),
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
    catch() {}
  }
  class InputFile {
    constructor(
      public file: Uint8Array,
      public filename?: string
    ) {}
  }
  const webhookCallback = vi.fn(() => {
    const handler = async (_req: unknown, res: { end(): void; statusCode: number }) => {
      res.statusCode = 200;
      res.end();
    };
    state.webhookHandler = handler;
    return handler;
  });
  return { Bot, InputFile, webhookCallback };
});

const { TelegramChannel } = await import('../channels/telegram');

function ctx(message: Record<string, unknown>, chatType = 'private') {
  return {
    message: { message_id: 1, ...message },
    chat: { id: 100, type: chatType },
    from: { id: 5, first_name: 'Ann', last_name: 'Lee' },
  };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    state.bots.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits text messages with group and reply metadata', async () => {
    const channel = new TelegramChannel({ token: 't' });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    await state.bots[0].handlers.get('message:text')!(
      ctx({ text: 'hi', reply_to_message: { message_id: 9 } }, 'group')
    );

    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg).toEqual(
      expect.objectContaining({
        text: 'hi',
        userName: 'Ann Lee',
        groupId: '100',
        replyTo: '9',
        channelId: '100',
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
    const channel = new TelegramChannel({ token: 'secret' });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    await state.bots[0].handlers.get('message:audio')!(
      ctx({ audio: { file_id: 'f', duration: 3, mime_type: 'audio/mpeg', file_name: 'a.mp3' } })
    );

    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg.attachments?.[0]).toEqual(
      expect.objectContaining({ type: 'audio', mimeType: 'audio/mpeg', filename: 'a.mp3' })
    );
  });

  it('falls back to plain text when Markdown cannot be parsed', async () => {
    const channel = new TelegramChannel({ token: 't' });
    await channel.start();
    const api = state.bots[0].api;
    api.sendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));

    const id = await channel.sendText('100', '*broken', { format: 'markdown', replyTo: '3' });

    expect(id).toBe('7');
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1][2]).toEqual({
      reply_parameters: { message_id: 3, allow_sending_without_reply: true },
    });
  });

  it('editText ignores "not modified" and propagates other errors', async () => {
    const channel = new TelegramChannel({ token: 't' });
    await channel.start();
    const api = state.bots[0].api;

    api.editMessageText.mockRejectedValueOnce(new Error('Bad Request: message is not modified'));
    await expect(channel.editText('1', '2', 'x')).resolves.toBeUndefined();

    api.editMessageText.mockRejectedValueOnce(new Error('Too Many Requests'));
    await expect(channel.editText('1', '2', 'x')).rejects.toThrow('Too Many Requests');
  });

  it('sends buffers through InputFile using type-specific methods', async () => {
    const channel = new TelegramChannel({ token: 't' });
    await channel.start();
    const api = state.bots[0].api;

    await channel.sendFile('1', {
      type: 'image',
      mimeType: 'image/png',
      buffer: new Uint8Array([1]),
      filename: 'a.png',
    });
    await channel.sendFile('1', { type: 'video', mimeType: 'video/mp4', url: 'https://v' });

    expect(api.sendPhoto.mock.calls[0][1]).toEqual(expect.objectContaining({ filename: 'a.png' }));
    expect(api.sendVideo).toHaveBeenCalledWith(1, 'https://v');
    await expect(channel.sendFile('1', { type: 'file', mimeType: 'x/y' })).rejects.toThrow(
      'buffer or a url'
    );
  });

  it('throws when used before start', async () => {
    const channel = new TelegramChannel({ token: 't' });
    await expect(channel.sendText('1', 'x')).rejects.toThrow('not started');
  });

  it('webhook mode serves updates over HTTP and registers the webhook', async () => {
    const port = 41000 + Math.floor(Math.random() * 1000);
    const channel = new TelegramChannel({
      token: 't',
      webhook: { url: 'https://bot.example.com/tg/hook', port, secretToken: 's3cret' },
    });
    await channel.start();
    const bot = state.bots[0];

    expect(bot.init).toHaveBeenCalled();
    expect(bot.start).not.toHaveBeenCalled();
    expect(bot.api.setWebhook).toHaveBeenCalledWith(
      'https://bot.example.com/tg/hook',
      expect.objectContaining({ secret_token: 's3cret' })
    );

    const hit = await fetch(`http://127.0.0.1:${port}/tg/hook`, { method: 'POST', body: '{}' });
    expect(hit.status).toBe(200);
    const miss = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', body: '{}' });
    expect(miss.status).toBe(404);

    await channel.stop();
    await expect(fetch(`http://127.0.0.1:${port}/tg/hook`, { method: 'POST' })).rejects.toThrow();
  });
});
