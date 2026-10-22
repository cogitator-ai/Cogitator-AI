import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import type { Cogitator } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import { InMemoryCheckpointStore, WorkflowBuilder } from '@cogitator-ai/workflows';
import {
  describeServerAdapter,
  describeResumeStream,
  parseSSEEvents,
  type ServerFactory,
} from '../../helpers/server-test-utils';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from '../../helpers/setup';

const ollamaSkip = await ollamaSkipReason();
import {
  createFailingWorkflow,
  createOfflineCogitator,
} from '../../helpers/server-adapter-fixtures';

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
describeResumeStream('Express', factory);

describe('Express adapter: streaming and WebSocket', () => {
  let cogitator: Cogitator;
  let server: Server;
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
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

  it.skipIf(ollamaSkip !== null)('streams model tokens over SSE until finish', async () => {
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

  it.skipIf(ollamaSkip !== null)('runs an agent over WebSocket', async () => {
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

describe('Express adapter: errors', () => {
  let cogitator: Cogitator;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    cogitator = createOfflineCogitator();
    const app = express();
    const cogitatorServer = new CogitatorServer({
      app,
      cogitator,
      agents: {},
      workflows: { failing: createFailingWorkflow() },
      config: { basePath: '/cogitator', enableSwagger: false },
    });
    await cogitatorServer.init();
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    base = `http://localhost:${(server.address() as AddressInfo).port}/cogitator`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
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

describe('Express adapter: workflow checkpoints', () => {
  let cogitator: Cogitator;
  let base: string;
  let checkpointServer: Server;
  const store = new InMemoryCheckpointStore();
  let failures = 1;

  const post = (path: string, body: unknown, user: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': user },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    cogitator = createOfflineCogitator();
    const shipping = new WorkflowBuilder<{ steps: string[] }>('shipping')
      .initialState({ steps: [] })
      .addNode('pack', async (ctx) => ({ state: { steps: [...ctx.state.steps, 'pack'] } }))
      .addNode(
        'ship',
        async (ctx) => {
          if (failures-- > 0) throw new Error('carrier unavailable');
          return { state: { steps: [...ctx.state.steps, 'ship'] } };
        },
        { after: ['pack'] }
      )
      .build();
    const app = express();
    const cogitatorServer = new CogitatorServer({
      app,
      cogitator,
      agents: {},
      workflows: { shipping },
      config: {
        basePath: '/cogitator',
        enableSwagger: false,
        auth: (req) => ({ userId: req.get('x-user') }),
        workflowCheckpoints: store,
      },
    });
    await cogitatorServer.init();
    checkpointServer = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    base = `http://localhost:${(checkpointServer.address() as AddressInfo).port}/cogitator`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => checkpointServer?.close(() => resolve()));
    await cogitator?.close();
  });

  it('answers a failed run with its checkpoint and resumes it for its owner only', async () => {
    const failed = await post('/workflows/shipping/run', { options: { checkpoint: true } }, 'ada');
    expect(failed.status).toBe(500);
    const { error } = (await failed.json()) as { error: { checkpointId?: string } };
    expect(error.checkpointId).toEqual(expect.any(String));
    expect((await store.load(error.checkpointId!))?.owner).toBe('ada');

    const stranger = await post(
      '/workflows/shipping/resume',
      { checkpointId: error.checkpointId },
      'eve'
    );
    expect(stranger.status).toBe(404);

    const resumed = await post(
      '/workflows/shipping/resume',
      { checkpointId: error.checkpointId },
      'ada'
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as { state: { steps: string[] }; checkpointId?: string };
    expect(body.state.steps).toEqual(['pack', 'ship']);
    expect(body.checkpointId).toEqual(expect.any(String));
  });
});
