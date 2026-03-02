import type { Channel, ChannelMessage } from '@cogitator-ai/types';
import { markdownToWhatsApp } from '../formatters/whatsapp-markdown';

export interface WhatsAppChannelConfig {
  sessionPath?: string;
  qrCallback?: (qr: string) => void;
  printQr?: boolean;
}

interface BaileysSocket {
  ev: {
    on(event: string, handler: (...args: unknown[]) => void): void;
  };
  sendMessage(
    jid: string,
    content: {
      text?: string;
      edit?: { key: { remoteJid: string; id: string } };
      document?: Buffer;
      mimetype?: string;
      fileName?: string;
    }
  ): Promise<{ key: { id: string } }>;
  sendPresenceUpdate(type: string, jid: string): Promise<void>;
  logout(): Promise<void>;
  end(reason?: Error): void;
}

interface BaileysMessage {
  key: { remoteJid?: string; id?: string; fromMe?: boolean; participant?: string };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: unknown;
    documentMessage?: unknown;
  };
  pushName?: string;
}

type MessageHandler = (msg: ChannelMessage) => Promise<void>;

export class WhatsAppChannel implements Channel {
  readonly type = 'whatsapp';
  private handler: MessageHandler | null = null;
  private sock: BaileysSocket | null = null;
  private config: WhatsAppChannelConfig;

  constructor(config: WhatsAppChannelConfig = {}) {
    this.config = config;
  }

  async start(): Promise<void> {
    let baileys: {
      default: (opts: Record<string, unknown>) => BaileysSocket;
      useMultiFileAuthState: (
        path: string
      ) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
      DisconnectReason: Record<string, number>;
    };

    try {
      // @ts-expect-error optional peer dependency
      baileys = await import('@whiskeysockets/baileys');
    } catch {
      throw new Error(
        '@whiskeysockets/baileys is required for WhatsApp. Install it: pnpm add @whiskeysockets/baileys'
      );
    }

    const sessionPath = this.config.sessionPath ?? '.cogitator/whatsapp-session';
    const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionPath);

    const sock = baileys.default({
      auth: state,
      printQRInTerminal: this.config.printQr ?? true,
    });

    this.sock = sock;

    sock.ev.on('creds.update', saveCreds as () => void);

    sock.ev.on('connection.update', (update: unknown) => {
      const { connection, qr } = update as {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
      };

      if (qr && this.config.qrCallback) {
        this.config.qrCallback(qr);
      }

      if (connection === 'close') {
        const { lastDisconnect } = update as {
          lastDisconnect?: { error?: { output?: { statusCode?: number } } };
        };
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;

        if (!loggedOut) {
          void this.start();
        }
      }
    });

    sock.ev.on('messages.upsert', (upsert: unknown) => {
      const { messages, type } = upsert as { messages: BaileysMessage[]; type: string };
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const text = msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? '';

        if (!text) continue;

        const jid = msg.key.remoteJid ?? '';
        const userId = msg.key.participant ?? jid;
        const isGroup = jid.endsWith('@g.us');

        const channelMsg: ChannelMessage = {
          id: msg.key.id ?? '',
          channelType: 'whatsapp',
          channelId: jid,
          userId: userId.split('@')[0],
          userName: msg.pushName ?? userId.split('@')[0],
          text,
          raw: msg,
          ...(isGroup ? { groupId: jid } : {}),
        };

        if (this.handler) {
          void this.handler(channelMsg);
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end();
      this.sock = null;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendText(channelId: string, text: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    const waText = markdownToWhatsApp(text);
    const sent = await this.sock.sendMessage(channelId, { text: waText });
    return sent.key.id ?? '';
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.sock) return;
    const waText = markdownToWhatsApp(text);
    await this.sock.sendMessage(channelId, {
      text: waText,
      edit: { key: { remoteJid: channelId, id: messageId } },
    });
  }

  async sendFile(
    channelId: string,
    file: { buffer?: Buffer; mimeType: string; filename?: string }
  ): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    if (!file.buffer) return;

    await this.sock.sendMessage(channelId, {
      document: file.buffer,
      mimetype: file.mimeType,
      fileName: file.filename ?? 'file',
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendPresenceUpdate('composing', channelId);
  }
}

export function whatsappChannel(config?: WhatsAppChannelConfig): Channel {
  return new WhatsAppChannel(config);
}
