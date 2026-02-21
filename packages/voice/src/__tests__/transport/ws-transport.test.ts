import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketTransport, VoiceClient } from '../../transport/ws-transport';
import { WebSocket } from 'ws';
import http from 'node:http';

function connectWs(port: number, path = '/voice'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForEvent<T>(
  emitter: { on: (event: string, cb: (...args: unknown[]) => void) => unknown },
  event: string
): Promise<T> {
  return new Promise((resolve) => {
    emitter.on(event, (...args: unknown[]) =>
      resolve(args.length === 1 ? (args[0] as T) : (args as T))
    );
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on('close', () => resolve());
    ws.close();
  });
}

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
    if (transport) await transport.close();
  });

  async function connect(port: number, path = '/voice'): Promise<WebSocket> {
    const ws = await connectWs(port, path);
    openSockets.push(ws);
    return ws;
  }

  it('starts on specified port', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    expect(transport.port).toBeTypeOf('number');
    expect(transport.port).toBeGreaterThan(0);
  });

  it('port getter returns correct port with port=0', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const port = transport.port!;
    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('accepts WebSocket connections on correct path', async () => {
    transport = new WebSocketTransport({ path: '/voice' });
    await transport.listen(0);
    const ws = await connect(transport.port!);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('emits connection with VoiceClient', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    await connect(transport.port!);
    const client = await clientPromise;
    expect(client).toBeInstanceOf(VoiceClient);
  });

  it('VoiceClient has id', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    await connect(transport.port!);
    const client = await clientPromise;
    expect(client.id).toBeTypeOf('string');
    expect(client.id.length).toBeGreaterThan(0);
  });

  it('rejects connections over maxConnections with code 1013', async () => {
    transport = new WebSocketTransport({ maxConnections: 1 });
    await transport.listen(0);
    const port = transport.port!;

    const code = await new Promise<number>((resolve) => {
      transport.once('connection', () => {
        const ws2 = new WebSocket(`ws://localhost:${port}/voice`);
        openSockets.push(ws2);
        ws2.on('close', (c: number) => resolve(c));
        ws2.on('error', () => {});
      });

      const ws1 = new WebSocket(`ws://localhost:${port}/voice`);
      openSockets.push(ws1);
    });

    expect(code).toBe(1013);
  });

  it('rejects connections on wrong path', async () => {
    transport = new WebSocketTransport({ path: '/voice' });
    await transport.listen(0);

    const ws = new WebSocket(`ws://localhost:${transport.port!}/wrong`);
    openSockets.push(ws);

    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it('VoiceClient receives binary audio frames', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(transport.port!);
    const client = await clientPromise;

    const audioData = Buffer.from([1, 2, 3, 4, 5]);
    const audioPromise = waitForEvent<Buffer>(client, 'audio');
    ws.send(audioData);
    const received = await audioPromise;
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(Buffer.compare(received, audioData)).toBe(0);
  });

  it('VoiceClient receives JSON text frames', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(transport.port!);
    const client = await clientPromise;

    const msg = { type: 'start', language: 'en' };
    const msgPromise = waitForEvent<Record<string, unknown>>(client, 'message');
    ws.send(JSON.stringify(msg));
    const received = await msgPromise;
    expect(received).toEqual(msg);
  });

  it('VoiceClient.sendAudio() sends binary', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(transport.port!);
    const client = await clientPromise;

    const audioData = Buffer.from([10, 20, 30]);
    const dataPromise = new Promise<Buffer>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) resolve(Buffer.from(data as ArrayBuffer));
      });
    });
    client.sendAudio(audioData);
    const received = await dataPromise;
    expect(Buffer.compare(received, audioData)).toBe(0);
  });

  it('VoiceClient.sendMessage() sends JSON text', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(transport.port!);
    const client = await clientPromise;

    const msg = { type: 'response', text: 'hello' };
    const dataPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) resolve(JSON.parse(data.toString()));
      });
    });
    client.sendMessage(msg);
    const received = await dataPromise;
    expect(received).toEqual(msg);
  });

  it('VoiceClient.close() closes connection', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(transport.port!);
    const client = await clientPromise;

    const closePromise = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });
    client.close(1000, 'done');
    await closePromise;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('VoiceClient emits close on disconnect', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(transport.port!);
    const client = await clientPromise;

    const closePromise = waitForEvent(client, 'close');
    ws.close();
    await closePromise;
  });

  it('close() shuts down server', async () => {
    transport = new WebSocketTransport();
    await transport.listen(0);
    const port = transport.port!;
    await transport.close();

    await expect(connectWs(port)).rejects.toThrow();
  });

  it('attachToServer() works with existing HTTP server', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    transport = new WebSocketTransport();
    transport.attachToServer(server);

    const clientPromise = waitForEvent<VoiceClient>(transport, 'connection');
    const ws = await connect(port);
    const client = await clientPromise;
    expect(client).toBeInstanceOf(VoiceClient);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    await closeWs(ws);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });
});
