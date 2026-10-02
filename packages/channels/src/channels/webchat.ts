import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  SendOptions,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export interface WebChatConfig {
  port: number;
  path?: string;
  auth?: (token: string) => boolean;
  /** Maximum size of an incoming frame in bytes. Default: 1 MiB. */
  maxPayload?: number;
}

const WS_OPEN = 1;
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const POLICY_VIOLATION = 1008;
const GOING_AWAY = 1001;

interface IncomingPayload {
  text: string;
  id?: string;
}

function parsePayload(raw: string): IncomingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== 'string' || record.text.trim().length === 0) return null;
  return {
    text: record.text,
    ...(typeof record.id === 'string' && record.id ? { id: record.id } : {}),
  };
}

export class WebChatChannel implements Channel {
  readonly type: ChannelType = 'webchat';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private server: WebSocketServer | null = null;
  private readonly clients = new Map<string, WebSocket>();

  constructor(private readonly config: WebChatConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server) return;

    let ws: typeof import('ws');
    try {
      ws = await import('ws');
    } catch {
      throw new Error('ws is required for WebChat support. Install it: pnpm add ws');
    }

    const wss = new ws.WebSocketServer({
      port: this.config.port,
      path: this.config.path ?? '/ws',
      maxPayload: this.config.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        wss.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        wss.off('error', onError);
        resolve();
      };
      wss.once('error', onError);
      wss.once('listening', onListening);
    });

    wss.on('error', (err) => {
      console.error('[webchat] Server error:', err.message);
    });
    wss.on('connection', (socket, req) => this.handleConnection(socket, req));

    this.server = wss;
  }

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    if (this.config.auth) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      if (!this.config.auth(token)) {
        socket.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        socket.close(POLICY_VIOLATION, 'unauthorized');
        return;
      }
    }

    const clientId = `webchat_${nanoid(8)}`;
    this.clients.set(clientId, socket);
    socket.send(JSON.stringify({ type: 'connected', clientId }));

    socket.on('message', (data) => {
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString('utf-8')
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf-8');
      void this.onRawMessage(clientId, raw).catch((err: unknown) => {
        console.error('[webchat] Message handler error:', err);
      });
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
    });

    socket.on('error', () => {
      this.clients.delete(clientId);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    for (const socket of this.clients.values()) {
      socket.close(GOING_AWAY, 'server shutting down');
    }
    this.clients.clear();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private send(channelId: string, payload: Record<string, unknown>): boolean {
    const client = this.clients.get(channelId);
    if (client?.readyState !== WS_OPEN) return false;
    client.send(JSON.stringify(payload));
    return true;
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const messageId = `msg_${nanoid(8)}`;
    const delivered = this.send(channelId, {
      type: 'message',
      id: messageId,
      text,
      ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
    });
    if (!delivered) throw new Error(`WebChat client ${channelId} is not connected`);
    return messageId;
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    this.send(channelId, { type: 'edit', id: messageId, text });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.send(channelId, { type: 'delete', id: messageId });
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    if (!file.url && !file.buffer) {
      throw new Error('Attachment must have either a buffer or a url');
    }
    this.send(channelId, {
      type: 'file',
      filename: file.filename,
      mimeType: file.mimeType,
      ...(file.url ? { url: file.url } : {}),
      ...(file.buffer ? { data: Buffer.from(file.buffer).toString('base64') } : {}),
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    this.send(channelId, { type: 'typing' });
  }

  private async onRawMessage(clientId: string, raw: string): Promise<void> {
    if (!this.handler) return;

    const payload = parsePayload(raw);
    if (!payload) return;

    const msg: ChannelMessage = {
      id: payload.id ?? `in_${nanoid(8)}`,
      channelType: 'webchat',
      channelId: clientId,
      userId: clientId,
      text: payload.text,
      raw: payload,
    };

    await this.handler(msg);
  }
}

export function webchatChannel(config: WebChatConfig): Channel {
  return new WebChatChannel(config);
}
