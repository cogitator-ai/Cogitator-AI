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
}

interface WebChatClient {
  send(data: string): void;
  readyState: number;
}

const WS_OPEN = 1;

export class WebChatChannel implements Channel {
  readonly type: ChannelType = 'webchat';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private server: { close(): void } | null = null;
  private clients = new Map<string, WebChatClient>();

  constructor(private readonly config: WebChatConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const { WebSocketServer } = await import('ws');

    const wss = new WebSocketServer({
      port: this.config.port,
      path: this.config.path ?? '/ws',
    });

    wss.on('connection', (ws: WebChatClient, req: { url?: string }) => {
      const clientId = `webchat_${nanoid(8)}`;

      if (this.config.auth) {
        const url = new URL(req.url ?? '/', `http://localhost:${this.config.port}`);
        const token = url.searchParams.get('token') ?? '';
        if (!this.config.auth(token)) {
          ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
          return;
        }
      }

      this.clients.set(clientId, ws as unknown as WebChatClient);

      ws.send(JSON.stringify({ type: 'connected', clientId }));

      (ws as unknown as { on(event: string, cb: (data: Buffer) => void): void }).on(
        'message',
        (data: Buffer) => {
          void this.onRawMessage(clientId, data.toString());
        }
      );

      (ws as unknown as { on(event: string, cb: () => void): void }).on('close', () => {
        this.clients.delete(clientId);
      });
    });

    this.server = wss;
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.clients.clear();
  }

  async sendText(channelId: string, text: string, _options?: SendOptions): Promise<string> {
    const client = this.clients.get(channelId);
    if (client?.readyState !== WS_OPEN) return '';

    const messageId = `msg_${nanoid(8)}`;
    client.send(JSON.stringify({ type: 'message', id: messageId, text }));
    return messageId;
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const client = this.clients.get(channelId);
    if (client?.readyState !== WS_OPEN) return;
    client.send(JSON.stringify({ type: 'edit', id: messageId, text }));
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    const client = this.clients.get(channelId);
    if (client?.readyState !== WS_OPEN) return;
    client.send(
      JSON.stringify({
        type: 'file',
        filename: file.filename,
        mimeType: file.mimeType,
        url: file.url,
      })
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    const client = this.clients.get(channelId);
    if (client?.readyState !== WS_OPEN) return;
    client.send(JSON.stringify({ type: 'typing' }));
  }

  private async onRawMessage(clientId: string, raw: string): Promise<void> {
    if (!this.handler) return;

    let parsed: { text?: string; id?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed.text) return;

    const msg: ChannelMessage = {
      id: parsed.id ?? `in_${nanoid(8)}`,
      channelType: 'webchat',
      channelId: clientId,
      userId: clientId,
      text: parsed.text,
      raw: parsed,
    };

    await this.handler(msg);
  }
}

export function webchatChannel(config: WebChatConfig): Channel {
  return new WebChatChannel(config);
}
