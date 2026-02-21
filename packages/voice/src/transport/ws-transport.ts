import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import type { WebSocketTransportConfig } from '../types.js';

interface VoiceClientEvents {
  audio: [chunk: Buffer];
  message: [msg: Record<string, unknown>];
  close: [];
  error: [error: Error];
}

export class VoiceClient extends EventEmitter<VoiceClientEvents> {
  readonly id: string;

  constructor(private readonly ws: WebSocket) {
    super();
    this.id = nanoid();

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        this.emit('audio', Buffer.from(data as Buffer));
      } else {
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          this.emit('message', parsed);
        } catch (err) {
          this.emit('error', new Error(`Invalid JSON: ${(err as Error).message}`));
        }
      }
    });

    ws.on('close', () => this.emit('close'));
    ws.on('error', (err) => this.emit('error', err));
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  sendMessage(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

interface TransportEvents {
  connection: [client: VoiceClient];
}

export class WebSocketTransport extends EventEmitter<TransportEvents> {
  private readonly path: string;
  private readonly maxConnections: number;
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private ownsServer = false;
  private clients = new Set<VoiceClient>();

  constructor(config?: WebSocketTransportConfig) {
    super();
    this.path = config?.path ?? '/voice';
    this.maxConnections = config?.maxConnections ?? 100;
  }

  async listen(port: number): Promise<void> {
    this.server = http.createServer();
    this.ownsServer = true;
    this.setupWss(this.server);
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
  }

  attachToServer(server: http.Server): void {
    this.server = server;
    this.ownsServer = false;
    this.setupWss(server);
  }

  get port(): number | undefined {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return undefined;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.close(1001, 'server shutting down');
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.ownsServer && this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((err) => (err ? reject(err) : resolve()))
      );
      this.server = null;
    }
  }

  private setupWss(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname !== this.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      if (this.clients.size >= this.maxConnections) {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          ws.close(1013, 'max connections reached');
        });
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const client = new VoiceClient(ws);
        this.clients.add(client);
        client.on('close', () => this.clients.delete(client));
        this.emit('connection', client);
      });
    });
  }
}
