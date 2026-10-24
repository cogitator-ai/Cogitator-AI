import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import { createServer, type IncomingMessage, type Server } from 'http';
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
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
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

describe('resume over SSE', () => {
  it('streams the rest of a paused run on its thread', async () => {
    const { base, resume } = await start(
      {
        resume: async (_threadId, options) => {
          options.onToolCall?.({ id: 'call_1', name: 'refund', arguments: { orderId: 42 } });
          options.onToolResult?.({ callId: 'call_1', name: 'refund', result: { ok: true } });
          options.onToken?.('Refunded');
          return result({ output: 'Refunded' });
        },
      },
      { auth: () => ({ userId: 'user-7' }) }
    );

    const res = await post(`${base}/agents/bot/resume/stream`, {
      threadId: 'thread-1',
      decisions: { call_1: { approved: true } },
      defaultDecision: { approved: false, reason: 'no' },
    });
    const raw = await res.text();
    const events = parseEvents(raw);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(events[0]).toMatchObject({ threadId: 'thread-1' });
    expect(events.at(-1)).toMatchObject({ threadId: 'thread-1', status: 'completed' });
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const [calledAgent, threadId, options] = resume.mock.calls[0];
    expect(calledAgent).toBe(agent);
    expect(threadId).toBe('thread-1');
    expect(options).toMatchObject({
      userId: 'user-7',
      decisions: { call_1: { approved: true } },
      defaultDecision: { approved: false, reason: 'no' },
      stream: true,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the resume when the client disconnects', async () => {
    let seeAbort!: () => void;
    const abortSeen = new Promise<void>((resolve) => (seeAbort = resolve));
    const { base } = await start({
      resume: (_threadId, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => {
            seeAbort();
            resolve(result());
          });
          options.onToken?.('Working');
        }),
    });
    const client = new AbortController();

    const res = await fetch(`${base}/agents/bot/resume/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1' }),
      signal: client.signal,
    });
    await res.body!.getReader().read();
    client.abort();

    await abortSeen;
  });

  it('streams approval-required when the resumed run pauses again', async () => {
    const { base } = await start({ resume: async () => paused() });

    const raw = await (
      await post(`${base}/agents/bot/resume/stream`, { threadId: 'thread-1' })
    ).text();
    const events = parseEvents(raw);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['approval-required', 'finish']);
    expect(events.at(-1)).toMatchObject({ status: 'paused' });
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it('answers 400 for an invalid body before streaming', async () => {
    const { base, resume } = await start();

    const res = await post(`${base}/agents/bot/resume/stream`, {
      threadId: 't',
      decisions: { call_1: {} },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent', async () => {
    const { base, resume } = await start();

    const res = await post(`${base}/agents/ghost/resume/stream`, { threadId: 't' });

    expect(res.status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it('refuses a thread the caller cannot access before streaming', async () => {
    const { base, resume } = await start({}, { authorizeThread: () => false });

    const res = await post(`${base}/agents/bot/resume/stream`, { threadId: 'thread-1' });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('THREAD_FORBIDDEN');
    expect(resume).not.toHaveBeenCalled();
  });

  it('ends the stream with an error event when the thread has no paused run', async () => {
    const { base } = await start({
      resume: async () => {
        throw new CogitatorError({ message: 'nothing to resume', code: ErrorCode.RUN_NOT_PAUSED });
      },
    });

    const res = await post(`${base}/agents/bot/resume/stream`, { threadId: 'thread-1' });
    const events = parseEvents(await res.text());

    expect(res.status).toBe(200);
    expect(events[0]).toMatchObject({ type: 'start', threadId: 'thread-1' });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'nothing to resume',
      code: ErrorCode.RUN_NOT_PAUSED,
    });
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

describe('request deps and thread authorization', () => {
  function connect(url: string): Promise<{
    messages: WebSocketResponse[];
    send: (message: unknown) => void;
  }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { 'x-tenant': 'acme' } });
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

  const tenantDeps = {
    deps: (req: express.Request) => ({ tenant: req.headers['x-tenant'] }),
  };

  it('hands HTTP runs, streams and resumes the deps built for the request, never the body', async () => {
    const { base, run, resume } = await start({}, tenantDeps);
    const send = (path: string, body: Record<string, unknown>) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant': 'acme' },
        body: JSON.stringify({ ...body, deps: { tenant: 'evil' } }),
      }).then((res) => res.text());

    await send('/agents/bot/run', { input: 'hi' });
    await send('/agents/bot/stream', { input: 'hi' });
    await send('/agents/bot/resume', { threadId: 'thread-1' });

    expect(run.mock.calls.map(([, options]) => options.deps)).toEqual([
      { tenant: 'acme' },
      { tenant: 'acme' },
    ]);
    expect(resume.mock.calls[0][2].deps).toEqual({ tenant: 'acme' });
  });

  it('passes no deps without the hook', async () => {
    const { base, run } = await start();
    await post(`${base}/agents/bot/run`, { input: 'hi', deps: { tenant: 'evil' } });
    expect(run.mock.calls[0][1]).not.toHaveProperty('deps');
  });

  it('hands WebSocket runs and resumes the deps websocket.deps builds from the upgrade request', async () => {
    const { wsUrl, run, resume } = await start(
      {},
      {
        ...tenantDeps,
        websocket: {
          deps: (req: IncomingMessage) => ({ tenant: req.headers['x-tenant'], via: 'ws' }),
        },
      }
    );
    const client = await connect(wsUrl);

    client.send({ type: 'run', id: 'r1', payload: { type: 'agent', name: 'bot', input: 'go' } });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    client.send({ type: 'resume', id: 'r2', payload: { name: 'bot', threadId: 'thread-1' } });
    await vi.waitFor(() => expect(client.messages).toHaveLength(2));

    expect(run.mock.calls[0][1].deps).toEqual({ tenant: 'acme', via: 'ws' });
    expect(resume.mock.calls[0][2].deps).toEqual({ tenant: 'acme', via: 'ws' });
  });

  it('never calls the HTTP deps hook with a WebSocket upgrade request', async () => {
    const deps = vi.fn((req: express.Request) => ({ tenant: req.get('x-tenant') }));
    const { wsUrl, run } = await start({}, { deps });
    const client = await connect(wsUrl);

    client.send({ type: 'run', id: 'r1', payload: { type: 'agent', name: 'bot', input: 'go' } });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));

    expect(deps).not.toHaveBeenCalled();
    expect(run.mock.calls[0][1]).not.toHaveProperty('deps');
  });

  it.each([
    [
      'websocket.deps',
      {
        websocket: {
          deps: () => {
            throw new Error('tenant lookup failed');
          },
        },
      },
    ],
    [
      'authorizeThread',
      {
        authorizeThread: () => {
          throw new Error('policy store down');
        },
      },
    ],
  ])(
    'answers a WebSocket run whose %s hook throws with an error frame and starts no run',
    async (_hook, config) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { wsUrl, run } = await start({}, config);
      const client = await connect(wsUrl);

      client.send({
        type: 'run',
        id: 'r1',
        payload: { type: 'agent', name: 'bot', input: 'go', threadId: 'thread-1' },
      });
      await vi.waitFor(() =>
        expect(client.messages).toEqual([
          { type: 'error', id: 'r1', error: 'Internal server error' },
        ])
      );

      client.send({ type: 'ping', id: 'p1' });
      await vi.waitFor(() => expect(client.messages.at(-1)).toEqual({ type: 'pong', id: 'p1' }));
      expect(run).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    }
  );

  it('refuses a WebSocket run and resume on a thread authorizeThread keeps the caller from', async () => {
    const authorizeThread = vi.fn((_auth: unknown, threadId: string) => threadId !== 'private');
    const { wsUrl, run, resume } = await start(
      {},
      { auth: () => ({ userId: 'user-7' }), authorizeThread }
    );
    const client = await connect(wsUrl);

    client.send({
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'go', threadId: 'private' },
    });
    client.send({ type: 'resume', id: 'r2', payload: { name: 'bot', threadId: 'private' } });

    await vi.waitFor(() =>
      expect(client.messages).toEqual([
        { type: 'error', id: 'r1', error: "Access to thread 'private' is not allowed" },
        { type: 'error', id: 'r2', error: "Access to thread 'private' is not allowed" },
      ])
    );
    expect(authorizeThread).toHaveBeenCalledWith({ userId: 'user-7' }, 'private');
    expect(run).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('lets a WebSocket run on a thread authorizeThread allows', async () => {
    const { wsUrl, run } = await start({}, { authorizeThread: () => true });
    const client = await connect(wsUrl);

    client.send({
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'go', threadId: 'mine' },
    });

    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    expect(run.mock.calls[0][1].threadId).toBe('mine');
  });

  it('refuses an HTTP resume before it reaches core', async () => {
    const { base, resume } = await start({}, { authorizeThread: () => false });
    const res = await post(`${base}/agents/bot/resume`, { threadId: 'thread-1' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('THREAD_FORBIDDEN');
    expect(resume).not.toHaveBeenCalled();
  });
});

const question = {
  id: 'int_1',
  kind: 'input',
  reason: 'pick_order',
  message: 'Which order should be refunded?',
  responseSchema: { type: 'string' },
  toolCallId: 'call_2',
  toolName: 'refund',
};

const asking = () =>
  result({
    status: 'paused',
    pendingApprovals: [],
    interrupts: [{ ...question, response: 'kept on the server' }],
  });

describe('multitask strategies and interrupt answers', () => {
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

  it('passes the multitask strategy of HTTP runs and streams into the run options', async () => {
    const { base, run } = await start();

    await post(`${base}/agents/bot/run`, { input: 'hi', multitaskStrategy: 'reject' });
    await (
      await post(`${base}/agents/bot/stream`, { input: 'hi', multitaskStrategy: 'rollback' })
    ).text();
    await post(`${base}/agents/bot/run`, { input: 'hi' });

    expect(run.mock.calls.map(([, options]) => options.multitaskStrategy)).toEqual([
      'reject',
      'rollback',
      undefined,
    ]);
    expect(run.mock.calls[2][1]).not.toHaveProperty('multitaskStrategy');
  });

  it.each(['/agents/bot/run', '/agents/bot/stream'])(
    'answers %s with 400 INVALID_INPUT for an unknown multitask strategy',
    async (path) => {
      const { base, run } = await start();

      const res = await post(`${base}${path}`, { input: 'hi', multitaskStrategy: 'queue' });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect(run).not.toHaveBeenCalled();
    }
  );

  it('answers a run on a busy thread with 409 THREAD_BUSY', async () => {
    const { base } = await start({
      run: async () => {
        throw new CogitatorError({ message: 'Thread is busy', code: ErrorCode.THREAD_BUSY });
      },
    });

    const res = await post(`${base}/agents/bot/run`, {
      input: 'hi',
      threadId: 'thread-1',
      multitaskStrategy: 'reject',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'THREAD_BUSY' } });
  });

  it('streams a run on a busy thread as 200 and an error event with THREAD_BUSY', async () => {
    const { base } = await start({
      run: async () => {
        throw new CogitatorError({ message: 'Thread is busy', code: ErrorCode.THREAD_BUSY });
      },
    });

    const res = await post(`${base}/agents/bot/stream`, {
      input: 'hi',
      threadId: 'thread-1',
      multitaskStrategy: 'reject',
    });

    expect(res.status).toBe(200);
    expect(parseEvents(await res.text()).map((event) => [event.type, event.code])).toEqual([
      ['start', undefined],
      ['error', 'THREAD_BUSY'],
    ]);
  });

  it('hands the answers of HTTP resumes and resume streams to cogitator.resume()', async () => {
    const { base, resume } = await start();
    const responses = { int_1: 'order 42' };

    await post(`${base}/agents/bot/resume`, { threadId: 'thread-1', responses });
    await (
      await post(`${base}/agents/bot/resume/stream`, { threadId: 'thread-1', responses })
    ).text();

    expect(resume.mock.calls.map(([, , options]) => options.responses)).toEqual([
      responses,
      responses,
    ]);
  });

  it('answers a resume whose answers are not an object with 400', async () => {
    const { base, resume } = await start();

    const res = await post(`${base}/agents/bot/resume`, { threadId: 'thread-1', responses: 'yes' });

    expect(res.status).toBe(400);
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers a run paused for questions with its interrupts', async () => {
    const { base } = await start({ run: async () => asking() });

    const raw = await (await post(`${base}/agents/bot/run`, { input: 'refund' })).text();

    expect(JSON.parse(raw)).toMatchObject({ status: 'paused', interrupts: [question] });
    expect(raw).not.toContain('kept on the server');
  });

  it('streams interrupt-required instead of approval-required when the run asks', async () => {
    const { base } = await start({ run: async () => asking() });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'refund' })).text()
    );

    expect(events.map((e) => e.type).slice(-2)).toEqual(['interrupt-required', 'finish']);
    expect(events.at(-2)).toEqual({
      type: 'interrupt-required',
      threadId: 'thread-1',
      interrupts: [question],
    });
    expect(events.at(-1)).toMatchObject({ status: 'paused', interrupts: [question] });
  });

  it('passes the multitask strategy and answers of WebSocket runs and resumes', async () => {
    const { wsUrl, run, resume } = await start({ run: async () => asking() });
    const client = await connect(wsUrl);

    client.send({
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'go', multitaskStrategy: 'interrupt' },
    });
    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    client.send({
      type: 'resume',
      id: 'r2',
      payload: { name: 'bot', threadId: 'thread-1', responses: { int_1: 'order 42' } },
    });
    await vi.waitFor(() => expect(client.messages).toHaveLength(2));

    expect(run.mock.calls[0][1].multitaskStrategy).toBe('interrupt');
    expect(resume.mock.calls[0][2].responses).toEqual({ int_1: 'order 42' });
    expect(client.messages[0].payload).toMatchObject({
      type: 'complete',
      result: { status: 'paused', interrupts: [question] },
    });
  });

  it('refuses a WebSocket run with an unknown multitask strategy', async () => {
    const { wsUrl, run } = await start();
    const client = await connect(wsUrl);

    client.send({
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'go', multitaskStrategy: 'queue' },
    });

    await vi.waitFor(() =>
      expect(client.messages[0]).toEqual({ type: 'error', id: 'r1', error: 'Invalid run payload' })
    );
    expect(run).not.toHaveBeenCalled();
  });
});
