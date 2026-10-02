import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import type { Cogitator } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import {
  describeServerAdapter,
  parseSSEEvents,
  type ServerFactory,
} from '../../helpers/server-test-utils';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';

let httpServer: Server;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    const app = express();
    const server = new CogitatorServer({
      app,
      cogitator,
      agents,
      config: { basePath: '/cogitator', enableSwagger: false },
    });
    await server.init();

    return new Promise((resolve) => {
      httpServer = app.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        resolve({ port: addr.port });
      });
    });
  },
  async stop() {
    return new Promise((resolve) => {
      httpServer?.close(() => resolve());
    });
  },
};

describeServerAdapter('Express', factory);

describe('Express adapter: streaming and WebSocket', () => {
  let cogitator: Cogitator;
  let server: Server;
  let base: string;
  let wsUrl: string;
  let ollamaAvailable = false;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaRunning();
    cogitator = createTestCogitator();
    const app = express();
    const cogitatorServer = new CogitatorServer({
      app,
      cogitator,
      agents: { TestAgent: createTestAgent() },
      config: { basePath: '/cogitator', enableSwagger: false, enableWebSocket: true },
    });
    await cogitatorServer.init();
    server = createServer(app);
    await cogitatorServer.attachWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}/cogitator`;
    wsUrl = `ws://127.0.0.1:${port}/cogitator/ws`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cogitator?.close();
  });

  it('streams model tokens over SSE until finish', async () => {
    if (!ollamaAvailable) return;

    const res = await fetch(`${base}/agents/TestAgent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Say hello in one short sentence.' }),
    });
    const events = parseSSEEvents(await res.text());
    const payloads = events
      .map((e) => e.data)
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null);

    const text = payloads
      .filter((d) => d.type === 'text-delta')
      .map((d) => String(d.delta))
      .join('');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(payloads.map((d) => d.type)).toContain('finish');
    expect(events.at(-1)?.data).toBe('[DONE]');
  });

  it('runs an agent over WebSocket', async () => {
    if (!ollamaAvailable) return;

    const socket = new WebSocket(wsUrl);
    const payloadTypes: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; payload?: { type: string } };
        if (message.type === 'error') reject(new Error(JSON.stringify(message)));
        if (message.payload) payloadTypes.push(message.payload.type);
        if (message.payload?.type === 'complete') resolve();
      });
      socket.on('error', reject);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'run',
        id: 'r1',
        payload: { type: 'agent', name: 'TestAgent', input: 'Say hi.' },
      })
    );

    await done;
    socket.close();
    expect(payloadTypes).toContain('token');
    expect(payloadTypes.at(-1)).toBe('complete');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await fetch(`${base}/agents/TestAgent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"input": ',
    });
    expect(res.status).toBe(400);
  });
});
