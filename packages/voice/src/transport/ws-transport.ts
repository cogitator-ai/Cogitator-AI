import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import type { WebSocketTransportConfig } from '../types.js';

/** @deprecated Use `WebSocketTransportConfig`. */
export type WebSocketTransportOptions = WebSocketTransportConfig;

function rejectUpgrade(socket: Duplex, code: number, message: string): void {
  const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 403;
  const reason = message.replace(/[^\x20-\x7e]/g, ' ').trim() || 'Forbidden';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
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

  terminate(): void {
    this.ws.terminate();
  }
}

interface TransportEvents {
  connection: [client: VoiceClient];
}

export class WebSocketTransport extends EventEmitter<TransportEvents> {
  private readonly path: string;
  private readonly maxConnections: number;
  private readonly verifyClient?: WebSocketTransportConfig['verifyClient'];
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private ownsServer = false;
  private clients = new Set<VoiceClient>();
  private upgradeHandler:
    ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pendingUpgrades = 0;

  constructor(config?: WebSocketTransportConfig) {
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
      let pathname: string;
      try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        pathname = '';
      }
      if (pathname !== this.path) {
        if (this.ownsServer) {
          socket.on('error', () => socket.destroy());
          rejectUpgrade(socket, 404, 'Not Found');
        }
        return;
      }

      socket.on('error', () => socket.destroy());
      void this.handleUpgrade(req, socket, head);
    };

    server.on('upgrade', this.upgradeHandler);
    this.startKeepalive();
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    if (!this.wss) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    if (this.clients.size + this.pendingUpgrades >= this.maxConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    this.pendingUpgrades++;
    try {
      if (this.verifyClient) {
        let result: Awaited<ReturnType<NonNullable<WebSocketTransportConfig['verifyClient']>>>;
        try {
          result = await this.verifyClient(req);
        } catch {
          rejectUpgrade(socket, 500, 'Internal Server Error');
          return;
        }
        if (result !== true) {
          rejectUpgrade(socket, result.code, result.message);
          return;
        }
      }

      const wss = this.wss;
      if (!wss || socket.destroyed) {
        if (!socket.destroyed) rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = new VoiceClient(ws);
        this.clients.add(client);
        client.on('close', () => this.clients.delete(client));
        this.emit('connection', client);
      });
    } finally {
      this.pendingUpgrades--;
    }
  }

  private startKeepalive(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          this.clients.delete(client);
          client.terminate();
          continue;
        }
        client.markDead();
        client.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.pingInterval.unref();
  }

  private stopKeepalive(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
