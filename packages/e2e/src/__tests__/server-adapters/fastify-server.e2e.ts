import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { Cogitator } from '@cogitator-ai/core';
import { cogitatorPlugin } from '@cogitator-ai/fastify';
import {
  describeServerAdapter,
  parseSSEEvents,
  type ServerFactory,
} from '../../helpers/server-test-utils';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import {
  createFailingWorkflow,
  createOfflineCogitator,
} from '../../helpers/server-adapter-fixtures';

let fastify: FastifyInstance;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    fastify = Fastify({ logger: false });
    await fastify.register(cogitatorPlugin, {
      cogitator,
      agents,
      prefix: '/cogitator',
      enableSwagger: false,
    });
    await fastify.listen({ port: 0 });
    const addr = fastify.server.address() as AddressInfo;
    return { port: addr.port };
  },
  async stop() {
    await fastify?.close();
  },
};

describeServerAdapter('Fastify', factory);

describe('Fastify adapter: streaming, validation and WebSocket', () => {
  let cogitator: Cogitator;
  let app: FastifyInstance;
  let base: string;
  let wsUrl: string;
  let ollamaAvailable = false;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaRunning();
    cogitator = createTestCogitator();
    app = Fastify({ logger: false });
    await app.register(cogitatorPlugin, {
      cogitator,
      agents: { TestAgent: createTestAgent() },
      prefix: '/cogitator',
      enableSwagger: false,
      enableWebSocket: true,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}/cogitator`;
    wsUrl = `ws://127.0.0.1:${port}/cogitator/ws`;
  });

  afterAll(async () => {
    await app?.close();
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

  it('answers schema validation failures with 400', async () => {
    const res = await fetch(`${base}/agents/TestAgent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_INPUT');
  });
});

describe('Fastify adapter: errors', () => {
  let cogitator: Cogitator;
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    cogitator = createOfflineCogitator();
    app = Fastify({ logger: false });
    await app.register(cogitatorPlugin, {
      cogitator,
      agents: {},
      workflows: { failing: createFailingWorkflow() },
      prefix: '/cogitator',
      enableSwagger: false,
    });
    await app.listen({ port: 0 });
    base = `http://localhost:${(app.server.address() as AddressInfo).port}/cogitator`;
  });

  afterAll(async () => {
    await app?.close();
    await cogitator?.close();
  });

  it('reports a failing workflow without leaking internals', async () => {
    const run = await fetch(`${base}/workflows/failing/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const stream = await fetch(`${base}/workflows/failing/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const events = await stream.text();

    expect(run.status).toBe(500);
    expect(await run.text()).not.toContain('hunter2');
    expect(events).toContain('node_error');
    expect(events).not.toContain('hunter2');
  });
});
