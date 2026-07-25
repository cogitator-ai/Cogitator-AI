import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import type { WebSocketTransportConfig } from '../types.js';

export interface WebSocketTransportOptions extends WebSocketTransportConfig {
  verifyClient?: (req: http.IncomingMessage) => true | { code: number; message: string };
}

const KEEPALIVE_INTERVAL_MS = 30_000;

interface VoiceClientEvents {
  audio: [chunk: Buffer];
  message: [msg: Record<string, unknown>];
  close: [];
  error: [error: Error];
}

export class VoiceClient extends EventEmitter<VoiceClientEvents> {
  readonly id: string;
  private alive = true;

  constructor(private readonly ws: WebSocket) {
    super();
    this.id = nanoid();

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data))
          : data;
      if (isBinary) {
        this.emit('audio', buf);
      } else {
        try {
          const raw = buf.toString();
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          this.emit('message', parsed);
        } catch (err) {
          this.emit('error', new Error(`Invalid JSON: ${(err as Error).message}`));
        }
      }
    });

    ws.on('pong', () => {
      this.alive = true;
    });

    ws.on('close', () => this.emit('close'));
    ws.on('error', (err) => this.emit('error', err));
  }

  get isAlive(): boolean {
    return this.alive;
  }

  markDead(): void {
    this.alive = false;
  }

  ping(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
    }
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
  private readonly verifyClient?: WebSocketTransportOptions['verifyClient'];
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private ownsServer = false;
  private clients = new Set<VoiceClient>();
  private upgradeHandler:
    | ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: WebSocketTransportOptions) {
    super();
    this.path = config?.path ?? '/voice';
    this.maxConnections = config?.maxConnections ?? 100;
    this.verifyClient = config?.verifyClient;
  }

  async listen(port: number): Promise<void> {
    if (this.wss) throw new Error('Transport already listening');
    this.server = http.createServer();
    this.ownsServer = true;
    this.setupWss(this.server);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  attachToServer(server: http.Server): void {
    if (this.wss) throw new Error('Transport already set up — call close() first');
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
    this.stopKeepalive();

    if (this.server && this.upgradeHandler) {
      this.server.removeListener('upgrade', this.upgradeHandler);
      this.upgradeHandler = null;
    }

    for (const client of this.clients) {
      client.close(1001, 'server shutting down');
    }

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    this.clients.clear();

    if (this.ownsServer && this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((err) => (err ? reject(err) : resolve()))
      );
      this.server = null;
    }
  }

  private setupWss(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    this.upgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy());

      if (!this.wss) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname !== this.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      if (this.verifyClient) {
        const result = this.verifyClient(req);
        if (result !== true) {
          socket.write(`HTTP/1.1 ${result.code} ${result.message}\r\n\r\n`);
          socket.destroy();
          return;
        }
      }

      if (this.clients.size >= this.maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const client = new VoiceClient(ws);
        this.clients.add(client);
        client.on('close', () => this.clients.delete(client));
        this.emit('connection', client);
      });
    };

    server.on('upgrade', this.upgradeHandler);
    this.startKeepalive();
  }

  private startKeepalive(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.close(1001, 'pong timeout');
          this.clients.delete(client);
          continue;
        }
        client.markDead();
        client.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
