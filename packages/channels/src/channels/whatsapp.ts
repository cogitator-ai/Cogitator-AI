import type {
  Attachment,
  AttachmentType,
  Channel,
  ChannelMessage,
  SendOptions,
} from '@cogitator-ai/types';
import { markdownToWhatsApp } from '../formatters/whatsapp-markdown';

export interface WhatsAppChannelConfig {
  sessionPath?: string;
  qrCallback?: (qr: string) => void;
  /**
   * Render the pairing QR code in the terminal when no `qrCallback` is set.
   * Requires the optional `qrcode-terminal` package. Default: true.
   */
  printQr?: boolean;
}

interface BaileysMessageKey {
  remoteJid?: string | null;
  id?: string | null;
  fromMe?: boolean | null;
  participant?: string | null;
}

interface BaileysMediaMessage {
  caption?: string | null;
  mimetype?: string | null;
  fileName?: string | null;
}

interface BaileysMessage {
  key: BaileysMessageKey;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: BaileysMediaMessage | null;
    audioMessage?: BaileysMediaMessage | null;
    videoMessage?: BaileysMediaMessage | null;
    documentMessage?: BaileysMediaMessage | null;
  } | null;
  pushName?: string | null;
}

type OutgoingContent =
  | { text: string; edit?: BaileysMessageKey }
  | { image: Buffer; mimetype?: string; caption?: string }
  | { audio: Buffer; mimetype?: string }
  | { video: Buffer; mimetype?: string; caption?: string }
  | { document: Buffer; mimetype: string; fileName: string };

interface BaileysSocket {
  ev: {
    on(event: string, handler: (...args: unknown[]) => void): void;
  };
  sendMessage(
    jid: string,
    content: OutgoingContent,
    options?: { quoted?: BaileysMessage }
  ): Promise<{ key: BaileysMessageKey } | undefined>;
  sendPresenceUpdate(type: string, jid: string): Promise<void>;
  end(reason?: Error): void;
}

interface BaileysModule {
  default: (opts: Record<string, unknown>) => BaileysSocket;
  useMultiFileAuthState: (
    path: string
  ) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  DisconnectReason: Record<string, number>;
  downloadMediaMessage: (
    message: BaileysMessage,
    type: 'buffer',
    options: Record<string, unknown>
  ) => Promise<Buffer>;
}

interface QrTerminalModule {
  generate(text: string, options: { small: boolean }): void;
}

interface ConnectionUpdate {
  connection?: string;
  qr?: string;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
}

type MessageHandler = (msg: ChannelMessage) => Promise<void>;

const MAX_RECENT_MESSAGES = 200;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

const MEDIA_KINDS: ReadonlyArray<{
  key: 'imageMessage' | 'audioMessage' | 'videoMessage' | 'documentMessage';
  type: AttachmentType;
  fallbackMime: string;
}> = [
  { key: 'imageMessage', type: 'image', fallbackMime: 'image/jpeg' },
  { key: 'audioMessage', type: 'audio', fallbackMime: 'audio/ogg' },
  { key: 'videoMessage', type: 'video', fallbackMime: 'video/mp4' },
  { key: 'documentMessage', type: 'file', fallbackMime: 'application/octet-stream' },
];

async function loadOptional<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

export class WhatsAppChannel implements Channel {
  readonly type = 'whatsapp';
  private handler: MessageHandler | null = null;
  private sock: BaileysSocket | null = null;
  private baileys: BaileysModule | null = null;
  private readonly config: WhatsAppChannelConfig;
  private readonly recent = new Map<string, BaileysMessage>();
  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: WhatsAppChannelConfig = {}) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.sock) return;
    this.stopped = false;

    const baileys = await loadOptional<BaileysModule>('@whiskeysockets/baileys');
    if (!baileys) {
      this.stopped = true;
      throw new Error(
        '@whiskeysockets/baileys is required for WhatsApp. Install it: pnpm add @whiskeysockets/baileys'
      );
    }
    this.baileys = baileys;

    await this.connect(baileys);
  }

  private async connect(baileys: BaileysModule): Promise<void> {
    const sessionPath = this.config.sessionPath ?? '.cogitator/whatsapp-session';
    const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionPath);

    const sock = baileys.default({ auth: state });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void saveCreds().catch((err: unknown) => {
        console.error('[whatsapp] Failed to persist credentials:', err);
      });
    });

    sock.ev.on('connection.update', (update: unknown) => {
      this.handleConnectionUpdate(sock, baileys, update as ConnectionUpdate);
    });

    sock.ev.on('messages.upsert', (upsert: unknown) => {
      const { messages, type } = upsert as { messages: BaileysMessage[]; type: string };
      if (type !== 'notify') return;
      for (const msg of messages) {
        void this.handleIncoming(msg).catch((err: unknown) => {
          console.error('[whatsapp] Message handler error:', err);
        });
      }
    });
  }

  private handleConnectionUpdate(
    sock: BaileysSocket,
    baileys: BaileysModule,
    update: ConnectionUpdate
  ): void {
    if (update.qr) void this.presentQr(update.qr);

    if (update.connection === 'open') {
      this.reconnectAttempts = 0;
      return;
    }

    if (update.connection !== 'close' || this.sock !== sock) return;

    this.sock = null;
    const statusCode = update.lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
    if (this.stopped || loggedOut) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connect(baileys).catch((err: unknown) => {
        console.error('[whatsapp] Reconnect failed:', err);
      });
    }, delay);
  }

  private async presentQr(qr: string): Promise<void> {
    if (this.config.qrCallback) {
      this.config.qrCallback(qr);
      return;
    }
    if (this.config.printQr === false) return;

    const qrTerminal = await loadOptional<QrTerminalModule & { default?: QrTerminalModule }>(
      'qrcode-terminal'
    );
    const generator = qrTerminal?.default ?? qrTerminal;
    if (generator?.generate) {
      generator.generate(qr, { small: true });
      return;
    }
    console.warn(
      '[whatsapp] Scan required but qrcode-terminal is not installed (pnpm add qrcode-terminal). ' +
        'Pass qrCallback to render the QR code yourself. Raw QR payload:',
      qr
    );
  }

  private extractText(msg: BaileysMessage): string {
    const m = msg.message;
    if (!m) return '';
    return (
      m.conversation ??
      m.extendedTextMessage?.text ??
      m.imageMessage?.caption ??
      m.videoMessage?.caption ??
      m.documentMessage?.caption ??
      ''
    );
  }

  private async extractAttachments(msg: BaileysMessage): Promise<Attachment[]> {
    const m = msg.message;
    if (!m || !this.baileys) return [];

    const attachments: Attachment[] = [];
    for (const kind of MEDIA_KINDS) {
      const media = m[kind.key];
      if (!media) continue;
      try {
        const buffer = await this.baileys.downloadMediaMessage(msg, 'buffer', {});
        attachments.push({
          type: kind.type,
          mimeType: media.mimetype?.split(';')[0]?.trim() || kind.fallbackMime,
          buffer,
          ...(media.fileName ? { filename: media.fileName } : {}),
        });
      } catch (err) {
        console.error('[whatsapp] Failed to download media:', err);
      }
    }
    return attachments;
  }

  private async handleIncoming(msg: BaileysMessage): Promise<void> {
    if (msg.key.fromMe || !msg.message || !this.handler) return;

    const jid = msg.key.remoteJid ?? '';
    const id = msg.key.id ?? '';
    if (!jid || !id) return;

    const text = this.extractText(msg);
    const attachments = await this.extractAttachments(msg);
    if (!text && attachments.length === 0) return;

    this.recent.set(id, msg);
    if (this.recent.size > MAX_RECENT_MESSAGES) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }

    const sender = msg.key.participant ?? jid;
    const userId = sender.split('@')[0];
    const isGroup = jid.endsWith('@g.us');

    await this.handler({
      id,
      channelType: 'whatsapp',
      channelId: jid,
      userId,
      userName: msg.pushName ?? userId,
      text,
      raw: msg,
      ...(isGroup ? { groupId: jid } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      const sock = this.sock;
      this.sock = null;
      sock.end();
    }
    this.recent.clear();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  private requireSocket(): BaileysSocket {
    if (!this.sock) throw new Error('WhatsApp not connected');
    return this.sock;
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const sock = this.requireSocket();
    const quoted = options?.replyTo ? this.recent.get(options.replyTo) : undefined;
    const sent = await sock.sendMessage(
      channelId,
      { text: markdownToWhatsApp(text) },
      quoted ? { quoted } : undefined
    );
    const id = sent?.key.id;
    if (!id) throw new Error('WhatsApp did not return a message id');
    return id;
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const sock = this.requireSocket();
    await sock.sendMessage(channelId, {
      text: markdownToWhatsApp(text),
      edit: { remoteJid: channelId, id: messageId, fromMe: true },
    });
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    const sock = this.requireSocket();

    let buffer: Buffer;
    if (file.buffer) {
      buffer = Buffer.from(file.buffer);
    } else if (file.url) {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`Failed to download ${file.url}: HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error('Attachment must have either a buffer or a url');
    }

    switch (file.type) {
      case 'image':
        await sock.sendMessage(channelId, { image: buffer, mimetype: file.mimeType });
        return;
      case 'audio':
        await sock.sendMessage(channelId, { audio: buffer, mimetype: file.mimeType });
        return;
      case 'video':
        await sock.sendMessage(channelId, { video: buffer, mimetype: file.mimeType });
        return;
      default:
        await sock.sendMessage(channelId, {
          document: buffer,
          mimetype: file.mimeType,
          fileName: file.filename ?? 'file',
        });
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendPresenceUpdate('composing', channelId);
  }
}

export function whatsappChannel(config?: WhatsAppChannelConfig): Channel {
  return new WhatsAppChannel(config);
}
