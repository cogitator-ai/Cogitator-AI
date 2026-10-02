import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelMessage } from '@cogitator-ai/types';

interface FakeMessage {
  id: string;
  content: string;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  clients: [] as Array<{
    options: Record<string, unknown>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
  messages: new Map<string, FakeMessage>(),
  nextId: 0,
}));

vi.mock('discord.js', () => {
  const textChannel = {
    id: 'chan',
    isTextBased: () => true,
    sendTyping: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (opts: { content?: string }) => {
      const id = `d${++state.nextId}`;
      const message: FakeMessage = {
        id,
        content: opts.content ?? '',
        edit: vi.fn(async (content: string) => {
          message.content = content;
        }),
        delete: vi.fn(async () => {
          state.messages.delete(id);
        }),
        react: vi.fn().mockResolvedValue(undefined),
      };
      state.messages.set(id, message);
      return message;
    }),
    messages: {
      fetch: vi.fn(async (id: string) => {
        const found = state.messages.get(id);
        if (!found) throw new Error('Unknown Message');
        return found;
      }),
    },
  };

  class Client {
    user = { id: 'BOT' };
    channels = { fetch: vi.fn().mockResolvedValue(textChannel) };
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(public options: Record<string, unknown>) {
      state.clients.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
    }
    once(event: string, cb: (...args: unknown[]) => void) {
      this.on(event, cb);
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
    async login() {
      setTimeout(() => this.emit('clientReady'), 0);
    }
    async destroy() {}
  }

  return {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 },
    Partials: { Channel: 1 },
    Events: { ClientReady: 'clientReady' },
  };
});

const { DiscordChannel } = await import('../channels/discord');

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in1',
    content: 'hello',
    author: { id: 'u1', bot: false, username: 'ann', displayName: 'Ann' },
    channel: { id: 'chan' },
    guild: { id: 'g1' },
    ...overrides,
  };
}

describe('DiscordChannel', () => {
  beforeEach(() => {
    state.clients.length = 0;
    state.messages.clear();
    state.nextId = 0;
  });

  it('enables DM partials and waits for ready', async () => {
    const channel = new DiscordChannel({ token: 't' });
    await channel.start();
    expect(state.clients[0].options.partials).toEqual([1]);
  });

  it('mentionOnly accepts nickname mentions and strips them', async () => {
    const channel = new DiscordChannel({ token: 't', mentionOnly: true });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    state.clients[0].emit('messageCreate', incoming({ content: 'no mention' }));
    state.clients[0].emit('messageCreate', incoming({ content: '<@!BOT> ping' }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect((handler.mock.calls[0][0] as ChannelMessage).text).toBe('ping');
  });

  it('maps attachments and allows attachment-only messages', async () => {
    const channel = new DiscordChannel({ token: 't' });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    const attachments = new Map([
      ['a', { url: 'https://cdn/v.ogg', name: 'voice.ogg', contentType: 'audio/ogg' }],
    ]);
    state.clients[0].emit('messageCreate', incoming({ content: '', guild: null, attachments }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg.groupId).toBeUndefined();
    expect(msg.attachments).toEqual([
      { type: 'audio', url: 'https://cdn/v.ogg', mimeType: 'audio/ogg', filename: 'voice.ogg' },
    ]);
  });

  it('sendText returns the first message id and editText updates continuations in place', async () => {
    const channel = new DiscordChannel({ token: 't' });
    await channel.start();

    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const id = await channel.sendText('chan', long);
    expect(id).toBe('d1');
    const sentAfterSend = state.nextId;
    expect(sentAfterSend).toBeGreaterThan(1);

    await channel.editText('chan', id, `${long}\nmore`);
    await channel.editText('chan', id, `${long}\nmore and more`);
    expect(state.nextId).toBe(sentAfterSend);

    await channel.editText('chan', id, 'short now');
    expect(state.messages.size).toBe(1);
    expect(state.messages.get('d1')?.content).toBe('short now');
  });

  it('deleteMessage removes continuation messages too', async () => {
    const channel = new DiscordChannel({ token: 't' });
    await channel.start();
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const id = await channel.sendText('chan', long);

    await channel.deleteMessage('chan', id);

    expect(state.messages.size).toBe(0);
  });

  it('sendFile accepts buffers and rejects empty attachments', async () => {
    const channel = new DiscordChannel({ token: 't' });
    await channel.start();
    await channel.sendFile('chan', {
      type: 'file',
      mimeType: 'text/plain',
      buffer: new Uint8Array([65]),
      filename: 'a.txt',
    });
    await expect(channel.sendFile('chan', { type: 'file', mimeType: 'x' })).rejects.toThrow(
      'buffer or a url'
    );
  });
});
