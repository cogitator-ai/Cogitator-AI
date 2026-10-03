import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, type WebSocketServer } from 'ws';
import {
  CogitatorError,
  ErrorCode,
  type ResumeOptions,
  type RunOptions,
} from '@cogitator-ai/types';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig, WebSocketResponse } from '../types.js';

type Cogitator = CogitatorServerConfig['cogitator'];
type Agent = NonNullable<CogitatorServerConfig['agents']>[string];
type RunImpl = (options: RunOptions) => Promise<unknown>;
type ResumeImpl = (threadId: string, options: ResumeOptions) => Promise<unknown>;

const agent = { name: 'bot', config: { instructions: 'x', tools: [] } } as unknown as Agent;

const approval = {
  toolCallId: 'call_1',
  toolName: 'refund',
  arguments: { orderId: 42 },
  description: 'Refund order 42',
  sideEffects: ['payments'],
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    output: '',
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    toolCalls: [],
    trace: { traceId: 't', spans: [] },
    ...overrides,
  };
}

const paused = () =>
  result({
    status: 'paused',
    pendingApprovals: [approval],
    checkpoint: { version: 1, messages: [{ role: 'system', content: 'SECRET_CHECKPOINT' }] },
  });

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
  impls: { run?: RunImpl; resume?: ResumeImpl } = {},
  config: CogitatorServerConfig['config'] = {}
) {
  const run = vi.fn((_agent: Agent, options: RunOptions) =>
    (impls.run ?? (async () => result()))(options)
  );
  const resume = vi.fn((_agent: Agent, threadId: string, options: ResumeOptions) =>
    (impls.resume ?? (async () => result({ output: 'refunded' })))(threadId, options)
  );
  const app = express();
  const server = new CogitatorServer({
    app,
    cogitator: { run, resume } as unknown as Cogitator,
    agents: { bot: agent },
    config: { basePath: '/api', enableSwagger: false, enableWebSocket: true, ...config },
  });
  await server.init();
  httpServer = createServer(app);
  wss = await server.attachWebSocket(httpServer);
  await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    run,
    resume,
    base: `http://127.0.0.1:${port}/api`,
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
  };
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseEvents(raw: string): Array<{ type: string; [key: string]: unknown }> {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as { type: string });
}

describe('approvals over HTTP', () => {
  it('returns a paused run with its pending approvals and without the checkpoint', async () => {
    const { base } = await start({ run: async () => paused() });

    const res = await post(`${base}/agents/bot/run`, { input: 'refund order 42' });
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      threadId: 'thread-1',
      status: 'paused',
      pendingApprovals: [approval],
    });
    expect(body).not.toHaveProperty('checkpoint');
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it('marks finished runs completed and includes their reasoning', async () => {
    const { base } = await start({
      run: async () => result({ output: 'hi', reasoning: 'thought about it' }),
    });

    const body = (await (await post(`${base}/agents/bot/run`, { input: 'hi' })).json()) as Record<
      string,
      unknown
    >;

    expect(body).toMatchObject({
      output: 'hi',
      status: 'completed',
      reasoning: 'thought about it',
    });
    expect(body).not.toHaveProperty('pendingApprovals');
  });

  it('streams approval-required before finish when the run pauses', async () => {
    const { base } = await start({
      run: async (options) => {
        options.onToolCall?.({ id: 'call_1', name: 'refund', arguments: { orderId: 42 } });
        return paused();
      },
    });

    const raw = await (await post(`${base}/agents/bot/stream`, { input: 'refund' })).text();
    const events = parseEvents(raw);
    const types = events.map((e) => e.type);

    expect(types.slice(-2)).toEqual(['approval-required', 'finish']);
    expect(events.at(-2)).toEqual({
      type: 'approval-required',
      threadId: 'thread-1',
      approvals: [approval],
    });
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it('does not emit approval-required for completed streams', async () => {
    const { base } = await start({ run: async () => result({ output: 'done' }) });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'hi' })).text()
    );

    expect(events.some((e) => e.type === 'approval-required')).toBe(false);
  });

  it('resumes the thread as the authenticated user with the decisions', async () => {
    const { base, resume } = await start({}, { auth: () => ({ userId: 'user-7' }) });

    const res = await post(`${base}/agents/bot/resume`, {
      threadId: 'thread-1',
      decisions: {
        call_1: { approved: true },
        call_2: { approved: false, reason: 'too risky' },
      },
      defaultDecision: { approved: false },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ output: 'refunded', status: 'completed' });
    expect(resume).toHaveBeenCalledTimes(1);
    const [calledAgent, threadId, options] = resume.mock.calls[0];
    expect(calledAgent).toBe(agent);
    expect(threadId).toBe('thread-1');
    expect(options).toMatchObject({
      userId: 'user-7',
      decisions: {
        call_1: { approved: true },
        call_2: { approved: false, reason: 'too risky' },
      },
      defaultDecision: { approved: false },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a run that paused again without its checkpoint', async () => {
    const { base } = await start({ resume: async () => paused() });

    const res = await post(`${base}/agents/bot/resume`, { threadId: 'thread-1' });
    const raw = await res.text();

    expect(JSON.parse(raw)).toMatchObject({ status: 'paused', pendingApprovals: [approval] });
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it.each([
    ['no body', undefined],
    ['missing threadId', {}],
    ['blank threadId', { threadId: '  ' }],
    ['non-string threadId', { threadId: 7 }],
    ['non-object decisions', { threadId: 't', decisions: [] }],
    ['decision without approved', { threadId: 't', decisions: { call_1: {} } }],
    ['non-boolean approved', { threadId: 't', decisions: { call_1: { approved: 'yes' } } }],
    ['non-string reason', { threadId: 't', decisions: { call_1: { approved: false, reason: 1 } } }],
    ['malformed defaultDecision', { threadId: 't', defaultDecision: true }],
  ])('rejects a resume body with %s', async (_name, body) => {
    const { base, resume } = await start();

    const res = await post(`${base}/agents/bot/resume`, body);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent', async () => {
    const { base, resume } = await start();

    const res = await post(`${base}/agents/ghost/resume`, { threadId: 't' });

    expect(res.status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it.each([
    [ErrorCode.RUN_NOT_PAUSED, 409],
    [ErrorCode.THREAD_ACCESS_DENIED, 403],
  ])('maps %s to %i', async (code, status) => {
    const { base } = await start({
      resume: async () => {
        throw new CogitatorError({ message: 'nope', code });
      },
    });

    const res = await post(`${base}/agents/bot/resume`, { threadId: 'thread-1' });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { message: 'nope', code } });
  });
});

describe('approvals over WebSocket', () => {
  function connect(url: string): Promise<{
    messages: WebSocketResponse[];
    send: (message: unknown) => void;
  }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      const messages: WebSocketResponse[] = [];
      socket.on('message', (data) =>
        messages.push(JSON.parse(data.toString()) as WebSocketResponse)
      );
      socket.on('open', () =>
        resolve({ messages, send: (message) => socket.send(JSON.stringify(message)) })
      );
      socket.on('error', reject);
    });
  }

  it('completes a paused run with its approvals and without the checkpoint', async () => {
    const { wsUrl } = await start({ run: async () => paused() });
    const client = await connect(wsUrl);

    client.send({ type: 'run', id: 'r1', payload: { type: 'agent', name: 'bot', input: 'go' } });

    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    const payload = client.messages[0].payload as { type: string; result: Record<string, unknown> };
    expect(payload.type).toBe('complete');
    expect(payload.result).toMatchObject({ status: 'paused', pendingApprovals: [approval] });
    expect(payload.result).not.toHaveProperty('checkpoint');
  });

  it('resumes a paused run with the decisions', async () => {
    const { wsUrl, resume } = await start({
      resume: async (_threadId, options) => {
        options.onToken?.('Refunded');
        return result({ output: 'Refunded' });
      },
    });
    const client = await connect(wsUrl);

    client.send({
      type: 'resume',
      id: 'r2',
      payload: { name: 'bot', threadId: 'thread-1', decisions: { call_1: { approved: true } } },
    });

    await vi.waitFor(() =>
      expect(client.messages.map((m) => (m.payload as { type: string }).type)).toEqual([
        'token',
        'complete',
      ])
    );
    expect(resume.mock.calls[0][1]).toBe('thread-1');
    expect(resume.mock.calls[0][2]).toMatchObject({
      decisions: { call_1: { approved: true } },
      stream: true,
    });
  });

  it('rejects a malformed resume payload', async () => {
    const { wsUrl, resume } = await start();
    const client = await connect(wsUrl);

    client.send({ type: 'resume', id: 'r3', payload: { name: 'bot' } });

    await vi.waitFor(() =>
      expect(client.messages[0]).toEqual({
        type: 'error',
        id: 'r3',
        error: 'Invalid resume payload',
      })
    );
    expect(resume).not.toHaveBeenCalled();
  });
});
