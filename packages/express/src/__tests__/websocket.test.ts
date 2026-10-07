import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, type WebSocketServer } from 'ws';
import type { RunOptions } from '@cogitator-ai/types';
import { conformancePausedResult, toAgentRunResponse } from '@cogitator-ai/server-shared';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig, WebSocketResponse } from '../types.js';

type Cogitator = CogitatorServerConfig['cogitator'];
type Agent = NonNullable<CogitatorServerConfig['agents']>[string];

const agent = { name: 'bot', config: { instructions: 'x', tools: [] } } as unknown as Agent;

let httpServer: Server | undefined;
let wss: WebSocketServer | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) =>
    httpServer ? httpServer.close(() => resolve()) : resolve()
  );
  wss = undefined;
  httpServer = undefined;
});

async function start(
  run: (options: RunOptions) => Promise<unknown>,
  config: CogitatorServerConfig['config'] = {}
) {
  const runMock = vi.fn(async (_agent: Agent, options: RunOptions) => ({
    runId: 'run-1',
    agentId: 'bot',
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
    messages: [],
    trace: { traceId: 'trace-1', spans: [] },
    ...((await run(options)) as object),
  }));
  const app = express();
  const server = new CogitatorServer({
    app,
    cogitator: { run: runMock } as unknown as Cogitator,
    agents: { bot: agent },
    config: { basePath: '/api', enableSwagger: false, enableWebSocket: true, ...config },
  });
  await server.init();
  httpServer = createServer(app);
  wss = await server.attachWebSocket(httpServer);
  await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { runMock, url: `ws://127.0.0.1:${port}/api/ws` };
}

interface Client {
  socket: WebSocket;
  messages: WebSocketResponse[];
  send: (message: unknown) => void;
}

function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    const messages: WebSocketResponse[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as WebSocketResponse));
    socket.on('open', () =>
      resolve({ socket, messages, send: (message) => socket.send(JSON.stringify(message)) })
    );
    socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.on('error', reject);
  });
}

const runMessage = (id: string) => ({
  type: 'run',
  id,
  payload: { type: 'agent', name: 'bot', input: 'hello' },
});

describe('WebSocket', () => {
  it('requires enableWebSocket and init before attaching', async () => {
    const app = express();
    const disabled = new CogitatorServer({ app, cogitator: {} as Cogitator });
    await disabled.init();
    await expect(disabled.attachWebSocket(createServer())).rejects.toThrow('enableWebSocket');

    const notInitialized = new CogitatorServer({
      app: express(),
      cogitator: {} as Cogitator,
      config: { enableWebSocket: true },
    });
    await expect(notInitialized.attachWebSocket(createServer())).rejects.toThrow('init()');
  });

  it('streams agent events and completes the run', async () => {
    const { url } = await start(async (options) => {
      options.onToken?.('Hi');
      return { output: 'Hi' };
    });
    const client = await connect(url);
    client.send(runMessage('r1'));

    await vi.waitFor(() =>
      expect(client.messages.map((m) => (m.payload as { type: string }).type)).toEqual([
        'token',
        'complete',
      ])
    );
    expect(client.messages.every((m) => m.id === 'r1')).toBe(true);
  });

  it('streams reasoning deltas as reasoning events', async () => {
    const { url } = await start(async (options) => {
      options.onReasoning?.('thinking');
      options.onToken?.('Hi');
      return { output: 'Hi', reasoning: 'thinking' };
    });
    const client = await connect(url);
    client.send(runMessage('r1'));

    await vi.waitFor(() =>
      expect(client.messages.map((m) => (m.payload as { type: string }).type)).toEqual([
        'reasoning',
        'token',
        'complete',
      ])
    );
    expect(client.messages[0]).toMatchObject({
      type: 'event',
      id: 'r1',
      payload: { type: 'reasoning', delta: 'thinking' },
    });
  });

  it('stop aborts the running agent', async () => {
    let signal: AbortSignal | undefined;
    const { url } = await start(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const client = await connect(url);
    client.send(runMessage('r1'));
    await vi.waitFor(() => expect(signal).toBeDefined());

    client.send({ type: 'stop' });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toMatchObject({ id: 'r1', payload: { type: 'cancelled' } })
    );
  });

  it('applies the auth function to the upgrade request', async () => {
    const { url, runMock } = await start(async () => ({ output: 'ok' }), {
      auth: (req) => {
        if (req.headers.authorization !== 'Bearer good') throw new Error('nope');
        return { userId: 'u-1' };
      },
    });

    await expect(connect(url)).rejects.toThrow('HTTP 401');

    const client = await connect(url, { authorization: 'Bearer good' });
    client.send(runMessage('r1'));
    await vi.waitFor(() => expect(runMock).toHaveBeenCalled());
    expect(runMock.mock.calls[0][1].userId).toBe('u-1');
  });

  it('publishes run events to subscribers of the agent channel', async () => {
    const { url } = await start(async (options) => {
      options.onToken?.('Hi');
      return { output: 'Hi' };
    });
    const observer = await connect(url);
    observer.send({ type: 'subscribe', id: 's1', channel: 'agent:bot' });
    await vi.waitFor(() => expect(observer.messages[0]).toMatchObject({ type: 'subscribed' }));

    const runner = await connect(url);
    runner.send(runMessage('r1'));

    await vi.waitFor(() =>
      expect(observer.messages.slice(1).map((m) => (m.payload as { type: string }).type)).toEqual([
        'token',
        'complete',
      ])
    );
    expect(observer.messages[1]).toMatchObject({ channel: 'agent:bot', id: 'r1' });

    observer.send({ type: 'unsubscribe', channel: 'agent:bot' });
    await vi.waitFor(() =>
      expect(observer.messages.at(-1)).toMatchObject({ type: 'unsubscribed' })
    );
    const before = observer.messages.length;
    runner.send(runMessage('r2'));
    await vi.waitFor(() => expect(runner.messages.filter((m) => m.id === 'r2')).toHaveLength(2));
    expect(observer.messages).toHaveLength(before);
  });

  it("keeps another user's run events away from a subscriber", async () => {
    const { url } = await start(
      async (options) => {
        options.onToken?.(`secret of ${options.userId}`);
        return { output: 'done' };
      },
      { auth: (req) => ({ userId: String(req.headers['x-user']) }) }
    );
    const alice = await connect(url, { 'x-user': 'alice' });
    const aliceTab = await connect(url, { 'x-user': 'alice' });
    for (const client of [alice, aliceTab]) {
      client.send({ type: 'subscribe', channel: 'agent:bot' });
      await vi.waitFor(() => expect(client.messages[0]).toMatchObject({ type: 'subscribed' }));
    }

    const bob = await connect(url, { 'x-user': 'bob' });
    bob.send(runMessage('bob-run'));
    await vi.waitFor(() => expect(bob.messages).toHaveLength(2));

    alice.send(runMessage('alice-run'));
    await vi.waitFor(() =>
      expect(aliceTab.messages.slice(1).map((m) => m.id)).toEqual(['alice-run', 'alice-run'])
    );
    expect(JSON.stringify(aliceTab.messages)).not.toContain('secret of bob');
    expect(alice.messages.some((m) => m.id === 'bob-run')).toBe(false);
  });

  it.each([
    ['non-JSON text', 'not json'],
    ['null', 'null'],
    ['unknown type', JSON.stringify({ type: 'explode' })],
  ])('answers %s with an error', async (_name, raw) => {
    const { url } = await start(async () => ({ output: 'ok' }));
    const client = await connect(url);
    client.socket.send(raw);
    await vi.waitFor(() =>
      expect(client.messages[0]).toEqual({ type: 'error', error: 'Invalid message' })
    );
  });

  it('rejects run payloads without a string input', async () => {
    const { url, runMock } = await start(async () => ({ output: 'ok' }));
    const client = await connect(url);
    client.send({ type: 'run', id: 'r1', payload: { type: 'agent', name: 'bot', input: 7 } });
    await vi.waitFor(() =>
      expect(client.messages[0]).toEqual({ type: 'error', id: 'r1', error: 'Invalid run payload' })
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it('completes a run with the client-facing answer, never the prompt, history or trace', async () => {
    const result = conformancePausedResult('thread-1');
    const { url } = await start(async () => result);
    const client = await connect(url);
    client.send(runMessage('r1'));

    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    const [complete] = client.messages;
    expect(complete.payload).toEqual({ type: 'complete', result: toAgentRunResponse(result) });
    const text = JSON.stringify(complete);
    expect(text).not.toContain('SECRET OPERATOR INSTRUCTIONS');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('checkpoint');
  });

  it('refuses a run whose context the server does not accept', async () => {
    const { url, runMock } = await start(async () => ({ output: 'ok' }));
    const client = await connect(url);
    client.send({
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'hi', context: { policy: 'x' } },
    });

    await vi.waitFor(() =>
      expect(client.messages).toEqual([{ type: 'error', id: 'r1', error: 'Invalid run payload' }])
    );
    expect(runMock).not.toHaveBeenCalled();
  });
});
