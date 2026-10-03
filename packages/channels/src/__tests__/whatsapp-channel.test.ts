import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelMessage } from '@cogitator-ai/types';

type Listener = (payload: unknown) => void;

const state = vi.hoisted(() => ({
  sockets: [] as Array<{
    listeners: Map<string, Listener>;
    sendMessage: ReturnType<typeof import('vitest').vi.fn>;
    end: ReturnType<typeof import('vitest').vi.fn>;
    opts: Record<string, unknown>;
  }>,
}));

vi.mock('@whiskeysockets/baileys', () => {
  const makeSocket = (opts: Record<string, unknown>) => {
    const listeners = new Map<string, Listener>();
    const socket = {
      opts,
      listeners,
      ev: { on: (event: string, cb: Listener) => listeners.set(event, cb) },
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'out1' } }),
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
      end: vi.fn(() => {
        listeners.get('connection.update')?.({
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: 428 } } },
        });
      }),
    };
    state.sockets.push(socket);
    return socket;
  };
  return {
    default: makeSocket,
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from('img')),
  };
});

const { WhatsAppChannel } = await import('../channels/whatsapp');

function upsert(socketIndex: number, message: Record<string, unknown>) {
  state.sockets[socketIndex].listeners.get('messages.upsert')!({
    type: 'notify',
    messages: [message],
  });
}

describe('WhatsAppChannel', () => {
  beforeEach(() => {
    state.sockets.length = 0;
  });

  it('does not pass the deprecated printQRInTerminal option and forwards QR codes', async () => {
    const qrCallback = vi.fn();
    const channel = new WhatsAppChannel({ qrCallback });
    await channel.start();

    expect(state.sockets[0].opts).not.toHaveProperty('printQRInTerminal');
    state.sockets[0].listeners.get('connection.update')!({ qr: 'QR-DATA' });
    await vi.waitFor(() => expect(qrCallback).toHaveBeenCalledWith('QR-DATA'));
  });

  it('stop() does not trigger a reconnect', async () => {
    const channel = new WhatsAppChannel({ printQr: false });
    await channel.start();
    await channel.stop();
    await new Promise((r) => setTimeout(r, 1200));
    expect(state.sockets).toHaveLength(1);
  });

  it('reconnects with backoff after an unexpected close', async () => {
    vi.useFakeTimers();
    try {
      const channel = new WhatsAppChannel({ printQr: false });
      await channel.start();
      state.sockets[0].listeners.get('connection.update')!({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      });
      expect(state.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(state.sockets).toHaveLength(2);
      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('identifies users by phone number when Baileys 7 addresses them by LID', async () => {
    const channel = new WhatsAppChannel({ printQr: false });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    upsert(0, {
      key: { remoteJid: '9001@lid', remoteJidAlt: '79990001122@s.whatsapp.net', id: 'd1' },
      message: { conversation: 'hi' },
    });
    upsert(0, {
      key: {
        remoteJid: '123@g.us',
        id: 'g1',
        participant: '9002@lid',
        participantAlt: '79990003344@s.whatsapp.net',
      },
      message: { conversation: 'hello group' },
    });
    upsert(0, {
      key: { remoteJid: '9003@lid', id: 'd2' },
      message: { conversation: 'no phone shared' },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));

    const [direct, group, hidden] = handler.mock.calls.map(([msg]) => msg as ChannelMessage);
    expect(direct).toMatchObject({ userId: '79990001122', channelId: '9001@lid' });
    expect(group).toMatchObject({ userId: '79990003344', channelId: '123@g.us' });
    expect(hidden).toMatchObject({ userId: '9003', channelId: '9003@lid' });
  });

  it('extracts captions and media attachments', async () => {
    const channel = new WhatsAppChannel({ printQr: false });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    upsert(0, {
      key: { remoteJid: '123@g.us', id: 'm1', participant: '555@s.whatsapp.net' },
      pushName: 'Ann',
      message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg).toEqual(
      expect.objectContaining({ text: 'look', userId: '555', groupId: '123@g.us', userName: 'Ann' })
    );
    expect(msg.attachments?.[0]).toEqual(
      expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' })
    );
  });

  it('quotes replies and edits with the correct key shape', async () => {
    const channel = new WhatsAppChannel({ printQr: false });
    channel.onMessage(vi.fn().mockResolvedValue(undefined));
    await channel.start();
    const original = {
      key: { remoteJid: '1@s.whatsapp.net', id: 'in1' },
      message: { conversation: 'hi' },
    };
    upsert(0, original);
    await new Promise((r) => setTimeout(r, 0));

    const id = await channel.sendText('1@s.whatsapp.net', '**hey**', { replyTo: 'in1' });
    await channel.editText('1@s.whatsapp.net', id, 'edited');

    const sock = state.sockets[0];
    expect(sock.sendMessage.mock.calls[0]).toEqual([
      '1@s.whatsapp.net',
      { text: '*hey*' },
      { quoted: original },
    ]);
    expect(sock.sendMessage.mock.calls[1][1]).toEqual({
      text: 'edited',
      edit: { remoteJid: '1@s.whatsapp.net', id: 'out1', fromMe: true },
    });
  });

  it('sends images as images', async () => {
    const channel = new WhatsAppChannel({ printQr: false });
    await channel.start();
    await channel.sendFile('1@s.whatsapp.net', {
      type: 'image',
      mimeType: 'image/png',
      buffer: new Uint8Array([1]),
    });
    expect(state.sockets[0].sendMessage.mock.calls[0][1]).toEqual(
      expect.objectContaining({ image: expect.any(Buffer), mimetype: 'image/png' })
    );
  });

  it('throws a clear error when Baileys returns no message', async () => {
    const channel = new WhatsAppChannel({ printQr: false });
    await channel.start();
    state.sockets[0].sendMessage.mockResolvedValueOnce(undefined);
    await expect(channel.sendText('1@s.whatsapp.net', 'x')).rejects.toThrow('message id');
  });
});
