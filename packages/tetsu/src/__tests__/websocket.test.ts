import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '@tetsujs/core';
import type { FailureReport } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps, WebSocketServerMessage } from '../index.js';
import { chatAgent, fakeCogitator, lastRunOptions, runResult } from './helpers.js';

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

function serveSockets(deps: Omit<CogitatorDeps, 'websocket'>, reports: FailureReport[] = []) {
  return serve(
    createApp({
      routes: cogitatorController({ ...deps, websocket: true }),
      reportError: (report) => {
        reports.push(report);
      },
    })
  );
}

interface Connection {
  socket: WebSocket;
  next(): Promise<WebSocketServerMessage>;
  until(type: string): Promise<WebSocketServerMessage[]>;
  send(message: unknown): void;
  closed: Promise<CloseEvent>;
}

async function connect(baseUrl: URL, headers?: Record<string, string>): Promise<Connection> {
  const url = new URL('/ws', baseUrl);
  url.protocol = 'ws:';
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const inbox: WebSocketServerMessage[] = [];
  const waiting: Array<(message: WebSocketServerMessage) => void> = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as WebSocketServerMessage;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener('close', resolve, { once: true })
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('handshake refused')), { once: true });
  });

  const next = () =>
    new Promise<WebSocketServerMessage>((resolve) => {
      const queued = inbox.shift();
      if (queued) resolve(queued);
      else waiting.push(resolve);
    });

  return {
    socket,
    next,
    async until(type) {
      const received: WebSocketServerMessage[] = [];
      for (;;) {
        const message = await next();
        received.push(message);
        const payloadType = (message.payload as { type?: string } | undefined)?.type;
        if (message.type === type || payloadType === type) return received;
      }
    },
    send: (message) => socket.send(JSON.stringify(message)),
    closed,
  };
}

describe('websocket', () => {
  test('answers a ping', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveSockets({ cogitator });
    const connection = await connect(request.url);

    connection.send({ type: 'ping', id: 'p-1' });

    expect(await connection.next()).toEqual({ type: 'pong', id: 'p-1' });
  });

  test('streams an agent run and completes it', async () => {
    const { cogitator, run } = fakeCogitator(async (_agent, options) => {
      options.onToken?.('Hi');
      options.onToolCall?.({ id: 'c-1', name: 'get_weather', arguments: { city: 'Oslo' } });
      options.onToolResult?.({ callId: 'c-1', name: 'get_weather', result: 'Cold' });
      return runResult({ output: 'Hi there' });
    });
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'hello', threadId: 't-9' },
    });
    const received = await connection.until('complete');

    expect(received.map((message) => (message.payload as { type: string }).type)).toEqual([
      'token',
      'tool-call',
      'tool-result',
      'complete',
    ]);
    expect(received.every((message) => message.id === 'r-1')).toBe(true);
    expect(received.at(-1)?.payload).toMatchObject({ result: { output: 'Hi there' } });
    expect(lastRunOptions(run).threadId).toBe('t-9');
  });

  test('stops a run on request', async () => {
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('working');
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'go' },
    });
    await connection.next();
    connection.send({
      type: 'run',
      id: 'r-2',
      payload: { type: 'agent', name: 'chat', input: 'go' },
    });
    expect(await connection.next()).toMatchObject({
      type: 'error',
      id: 'r-2',
      code: 'RUN_IN_PROGRESS',
    });

    connection.send({ type: 'stop' });

    expect(await connection.next()).toEqual({
      type: 'event',
      id: 'r-1',
      payload: { type: 'cancelled' },
    });
  });

  test('aborts a run when the socket closes', async () => {
    let runSignal: AbortSignal | undefined;
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise(() => {
          runSignal = options.signal;
          options.onToken?.('working');
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: 'go' } });
    await connection.next();
    connection.socket.close();
    await connection.closed;

    for (let i = 0; i < 50 && !runSignal?.aborted; i++) await Bun.sleep(10);
    expect(runSignal?.aborted).toBe(true);
  });

  test('answers an invalid frame without closing the socket', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveSockets({ cogitator });
    const connection = await connect(request.url);

    connection.socket.send('not json');
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });

    connection.send({ type: 'run', payload: { type: 'robot', name: 'x', input: 'y' } });
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });

    connection.send({ type: 'ping' });
    expect(await connection.next()).toEqual({ type: 'pong' });
  });

  test('reports an unknown agent as an error frame', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveSockets({ cogitator });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'ghost', input: 'x' },
    });

    expect(await connection.next()).toEqual({
      type: 'error',
      id: 'r-1',
      error: "Agent 'ghost' not found",
      code: 'AGENT_NOT_FOUND',
    });
  });

  test('hides an unexpected failure and reports it', async () => {
    const reports: FailureReport[] = [];
    const { cogitator } = fakeCogitator(() => Promise.reject(new Error('secret detail')));
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } }, reports);
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'x' },
    });

    expect(await connection.next()).toEqual({
      type: 'error',
      id: 'r-1',
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
    for (let i = 0; i < 50 && reports.length === 0; i++) await Bun.sleep(10);
    expect(reports.map((report) => report.source)).toEqual(['websocket']);
  });

  test('runs the handshake through auth and passes the user to the run', async () => {
    const { cogitator, run } = fakeCogitator();
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      auth: (ctx) =>
        ctx.req.headers.get('authorization') === 'Bearer ada' ? { userId: 'ada' } : undefined,
    });

    const refused = await connect(request.url).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('handshake refused');

    const connection = await connect(request.url, { authorization: 'Bearer ada' });
    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: 'hi' } });
    await connection.until('complete');
    expect(lastRunOptions(run).userId).toBe('ada');
  });

  test('is not served unless enabled', async () => {
    const { cogitator } = fakeCogitator();
    const request = serve(createApp({ routes: cogitatorController({ cogitator }) }));
    expect((await request('/ws')).status).toBe(404);
  });
});
