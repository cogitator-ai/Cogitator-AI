import http from 'node:http';
import net from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketTransport, type VoiceClient } from '../../transport/ws-transport';
import type { VerifyClientResult } from '../../types';

function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: localhost:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

function open(port: number, path = '/voice'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('WebSocketTransport hardening', () => {
  let transport: WebSocketTransport | undefined;
  let server: http.Server | undefined;

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('supports async verifyClient', async () => {
    transport = new WebSocketTransport({
      verifyClient: async (req) => {
        await new Promise((r) => setTimeout(r, 5));
        return req.headers['x-token'] === 'ok' ? true : { code: 401, message: 'Unauthorized' };
      },
    });
    await transport.listen(0);

    const response = await rawUpgrade(transport.port!, '/voice');
    expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${transport!.port}/voice`, {
        headers: { 'x-token': 'ok' },
      });
      client.on('open', () => resolve(client));
      client.on('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects with 500 when verifyClient throws', async () => {
    transport = new WebSocketTransport({
      verifyClient: () => {
        throw new Error('db down');
      },
    });
    await transport.listen(0);

    const response = await rawUpgrade(transport.port!, '/voice');
    expect(response).toMatch(/^HTTP\/1\.1 500 Internal Server Error\r\n/);
  });

  it('sanitizes the rejection status line (no header injection)', async () => {
    transport = new WebSocketTransport({
      verifyClient: () => ({ code: 403, message: 'Nope\r\nSet-Cookie: evil=1' }),
    });
    await transport.listen(0);

    const response = await rawUpgrade(transport.port!, '/voice');
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 403 Nope  Set-Cookie: evil=1');
    expect(response).not.toMatch(/^Set-Cookie/m);
  });

  it('falls back to 403 for an invalid status code', async () => {
    transport = new WebSocketTransport({
      verifyClient: () => ({ code: 200, message: 'OK' }),
    });
    await transport.listen(0);

    const response = await rawUpgrade(transport.port!, '/voice');
    expect(response).toMatch(/^HTTP\/1\.1 403 OK\r\n/);
  });

  it('leaves upgrades for other paths alone when attached to a foreign server', async () => {
    server = http.createServer();
    const otherHandler = vi.fn((_req: http.IncomingMessage, socket: net.Socket) => {
      socket.end('HTTP/1.1 418 Teapot\r\n\r\n');
    });
    server.on('upgrade', otherHandler);
    await new Promise<void>((r) => server!.listen(0, () => r()));
    const port = (server.address() as net.AddressInfo).port;

    transport = new WebSocketTransport();
    transport.attachToServer(server);

    const response = await rawUpgrade(port, '/other');
    expect(response).toMatch(/^HTTP\/1\.1 418 Teapot/);
    expect(otherHandler).toHaveBeenCalled();
  });

  it('answers 404 for unknown paths on its own server', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);

    const response = await rawUpgrade(transport.port!, '/nope');
    expect(response).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
  });

  it('counts in-flight upgrades against maxConnections', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport = new WebSocketTransport({
      maxConnections: 1,
      verifyClient: async (): Promise<VerifyClientResult> => {
        await gate;
        return true;
      },
    });
    await transport.listen(0);

    const first = open(transport.port!);
    await new Promise((r) => setTimeout(r, 20));
    const second = await rawUpgrade(transport.port!, '/voice');
    expect(second).toMatch(/^HTTP\/1\.1 503 /);

    release();
    const ws = await first;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('terminates clients that miss a pong instead of waiting for a close handshake', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      transport = new WebSocketTransport();
      await transport.listen(0);
      const connected = new Promise<VoiceClient>((r) => transport!.on('connection', r));
      const ws = await open(transport.port!);
      const client = await connected;
      const terminate = vi.spyOn(client, 'terminate');
      client.markDead();
      vi.advanceTimersByTime(30_000);

      expect(terminate).toHaveBeenCalledOnce();
      ws.terminate();
    } finally {
      vi.useRealTimers();
    }
  });
});
