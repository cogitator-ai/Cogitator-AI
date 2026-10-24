import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import Koa from 'koa';
import request from 'supertest';
import WebSocket from 'ws';
import { CogitatorError, ErrorCode, type ResumeOptions } from '@cogitator-ai/types';
import { cogitatorApp } from '../app.js';
import { setupWebSocket } from '../websocket/handler.js';
import type { CogitatorAppOptions, CogitatorState, RouteContext } from '../types.js';

const agent = { config: { instructions: 'x', tools: [] } } as never;

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
    trace: { traceId: 'trace-1', spans: [] },
    ...overrides,
  };
}

const paused = () =>
  result({
    status: 'paused',
    pendingApprovals: [approval],
    checkpoint: { version: 1, messages: [{ role: 'system', content: 'SECRET_CHECKPOINT' }] },
  });

function buildApp(
  runtime: { run?: ReturnType<typeof vi.fn>; resume?: ReturnType<typeof vi.fn> },
  overrides: Partial<CogitatorAppOptions> = {}
) {
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({
    cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    agents: { bot: agent },
    ...overrides,
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}

function postJson(app: Koa<CogitatorState>, path: string, body: unknown) {
  return request(app.callback())
    .post(path)
    .set('Content-Type', 'application/json')
    .send(typeof body === 'string' ? body : JSON.stringify(body));
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('approvals over HTTP', () => {
  it('returns a paused run with its pending approvals and without the checkpoint', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(paused()) });

    const res = await postJson(app, '/agents/bot/run', { input: 'refund order 42' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      threadId: 'thread-1',
      status: 'paused',
      pendingApprovals: [approval],
    });
    expect(res.body).not.toHaveProperty('checkpoint');
    expect(res.text).not.toContain('SECRET_CHECKPOINT');
  });

  it('marks finished runs completed and includes their reasoning', async () => {
    const app = buildApp({
      run: vi.fn().mockResolvedValue(result({ output: 'hi', reasoning: 'thought about it' })),
    });

    const res = await postJson(app, '/agents/bot/run', { input: 'hi' });

    expect(res.body).toMatchObject({
      output: 'hi',
      status: 'completed',
      reasoning: 'thought about it',
    });
    expect(res.body).not.toHaveProperty('pendingApprovals');
  });

  it('streams approval-required before finish when the run pauses', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(paused()) });

    const res = await postJson(app, '/agents/bot/stream', { input: 'refund' });
    const events = parseSSE(res.text);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['approval-required', 'finish']);
    expect(events.at(-2)).toEqual({
      type: 'approval-required',
      threadId: 'thread-1',
      approvals: [approval],
    });
    expect(res.text).not.toContain('SECRET_CHECKPOINT');
  });

  it('does not emit approval-required for completed streams', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(result({ output: 'done' })) });

    const res = await postJson(app, '/agents/bot/stream', { input: 'hi' });

    expect(parseSSE(res.text).some((e) => e.type === 'approval-required')).toBe(false);
  });

  it('resumes the thread as the authenticated user with the decisions', async () => {
    const resume = vi.fn().mockResolvedValue(result({ output: 'refunded' }));
    const app = buildApp({ resume }, { auth: () => ({ userId: 'user-7' }) });

    const res = await postJson(app, '/agents/bot/resume', {
      threadId: 'thread-1',
      decisions: {
        call_1: { approved: true },
        call_2: { approved: false, reason: 'too risky' },
      },
      defaultDecision: { approved: false },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ output: 'refunded', status: 'completed' });
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
    const app = buildApp({ resume: vi.fn().mockResolvedValue(paused()) });

    const res = await postJson(app, '/agents/bot/resume', { threadId: 'thread-1' });

    expect(res.body).toMatchObject({ status: 'paused', pendingApprovals: [approval] });
    expect(res.text).not.toContain('SECRET_CHECKPOINT');
  });

  it.each([
    ['missing threadId', {}],
    ['blank threadId', { threadId: '  ' }],
    ['non-string threadId', { threadId: 7 }],
    ['non-object decisions', { threadId: 't', decisions: [] }],
    ['decision without approved', { threadId: 't', decisions: { call_1: {} } }],
    ['non-boolean approved', { threadId: 't', decisions: { call_1: { approved: 'yes' } } }],
    ['non-string reason', { threadId: 't', decisions: { call_1: { approved: false, reason: 1 } } }],
    ['malformed defaultDecision', { threadId: 't', defaultDecision: true }],
  ])('rejects a resume body with %s', async (_name, body) => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await postJson(app, '/agents/bot/resume', body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await postJson(app, '/agents/ghost/resume', { threadId: 't' });

    expect(res.status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it.each([
    [ErrorCode.RUN_NOT_PAUSED, 409],
    [ErrorCode.THREAD_ACCESS_DENIED, 403],
  ])('maps %s to %i', async (code, status) => {
    const app = buildApp({
      resume: vi.fn().mockRejectedValue(new CogitatorError({ message: 'nope', code })),
    });

    const res = await postJson(app, '/agents/bot/resume', { threadId: 'thread-1' });

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { message: 'nope', code } });
  });
});

describe('resume over SSE', () => {
  it('streams the rest of a paused run on its thread', async () => {
    const resume = vi.fn(async (_agent: unknown, _threadId: string, options: ResumeOptions) => {
      options.onToolCall?.({ id: 'call_1', name: 'refund', arguments: { orderId: 42 } });
      options.onToolResult?.({ callId: 'call_1', name: 'refund', result: { ok: true } });
      options.onToken?.('Refunded');
      return result({ output: 'Refunded' });
    });
    const app = buildApp({ resume }, { auth: () => ({ userId: 'user-7' }) });

    const res = await postJson(app, '/agents/bot/resume/stream', {
      threadId: 'thread-1',
      decisions: { call_1: { approved: true } },
      defaultDecision: { approved: false, reason: 'no' },
    });
    const events = parseSSE(res.text);

    expect(res.headers['content-type']).toContain('text/event-stream');
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
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);

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

  it('streams approval-required when the resumed run pauses again', async () => {
    const app = buildApp({ resume: vi.fn().mockResolvedValue(paused()) });

    const res = await postJson(app, '/agents/bot/resume/stream', { threadId: 'thread-1' });
    const events = parseSSE(res.text);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['approval-required', 'finish']);
    expect(events.at(-1)).toMatchObject({ status: 'paused' });
    expect(res.text).not.toContain('SECRET_CHECKPOINT');
  });

  it('answers 400 for an invalid body before streaming', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await postJson(app, '/agents/bot/resume/stream', {
      threadId: 't',
      decisions: { call_1: {} },
    });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await postJson(app, '/agents/ghost/resume/stream', { threadId: 't' });

    expect(res.status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it('refuses a thread the caller cannot access before streaming', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume }, { authorizeThread: () => false });

    const res = await postJson(app, '/agents/bot/resume/stream', { threadId: 'thread-1' });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('application/json');
    expect((res.body as { error: { code: string } }).error.code).toBe('THREAD_FORBIDDEN');
    expect(resume).not.toHaveBeenCalled();
  });

  it('ends the stream with an error event when the thread has no paused run', async () => {
    const app = buildApp({
      resume: vi
        .fn()
        .mockRejectedValue(
          new CogitatorError({ message: 'nothing to resume', code: ErrorCode.RUN_NOT_PAUSED })
        ),
    });

    const res = await postJson(app, '/agents/bot/resume/stream', { threadId: 'thread-1' });
    const events = parseSSE(res.text);

    expect(res.status).toBe(200);
    expect(events[0]).toMatchObject({ type: 'start', threadId: 'thread-1' });
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'nothing to resume',
      code: ErrorCode.RUN_NOT_PAUSED,
    });
  });

  it('aborts the resume when the client disconnects', async () => {
    let seeAbort!: () => void;
    const abortSeen = new Promise<void>((resolve) => (seeAbort = resolve));
    const resume = vi.fn(
      (_agent: unknown, _threadId: string, options: ResumeOptions) =>
        new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => {
            seeAbort();
            resolve(result());
          });
          options.onToken?.('Working');
        })
    );
    const server = createServer(buildApp({ resume }).callback());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new AbortController();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/agents/bot/resume/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-1' }),
        signal: client.signal,
      });
      await res.body!.getReader().read();
      client.abort();

      await abortSeen;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('approvals over WebSocket', () => {
  let server: Server | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.terminate();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function connect(runtime: Record<string, unknown>, userId?: string) {
    const ctx: RouteContext = {
      runtime: runtime as unknown as RouteContext['runtime'],
      agents: { bot: agent },
      workflows: {},
      swarms: {},
    };
    server = createServer();
    await setupWebSocket(server, ctx, userId ? { auth: () => ({ userId }) } : {});
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    return { messages, send: (message: unknown) => ws.send(JSON.stringify(message)) };
  }

  it('completes a paused run with its approvals and without the checkpoint', async () => {
    const client = await connect({ run: vi.fn().mockResolvedValue(paused()) });

    client.send({ type: 'run', id: 'r1', payload: { type: 'agent', name: 'bot', input: 'go' } });

    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    const payload = client.messages[0].payload as { type: string; result: Record<string, unknown> };
    expect(payload.type).toBe('complete');
    expect(payload.result).toMatchObject({ status: 'paused', pendingApprovals: [approval] });
    expect(payload.result).not.toHaveProperty('checkpoint');
  });

  it('resumes a paused run with the decisions as the connected user', async () => {
    const resume = vi.fn(
      async (_agent: unknown, _threadId: string, options: { onToken?: (t: string) => void }) => {
        options.onToken?.('Refunded');
        return result({ output: 'Refunded' });
      }
    );
    const client = await connect({ resume }, 'user-7');

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
      userId: 'user-7',
      decisions: { call_1: { approved: true } },
      stream: true,
    });
  });

  it('rejects a malformed resume payload', async () => {
    const resume = vi.fn();
    const client = await connect({ resume });

    client.send({ type: 'resume', id: 'r3', payload: { name: 'bot', threadId: 7 } });

    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    expect(client.messages[0]).toMatchObject({ type: 'error', id: 'r3' });
    expect(String(client.messages[0].error)).toContain('Invalid resume payload');
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
  let server: Server | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.terminate();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function connect(runtime: Record<string, unknown>) {
    const ctx: RouteContext = {
      runtime: runtime as unknown as RouteContext['runtime'],
      agents: { bot: agent },
      workflows: {},
      swarms: {},
    };
    server = createServer();
    await setupWebSocket(server, ctx, {});
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    return { messages, send: (message: unknown) => ws.send(JSON.stringify(message)) };
  }

  it('passes the multitask strategy of HTTP runs and streams into the run options', async () => {
    const run = vi.fn().mockResolvedValue(result());
    const app = buildApp({ run });

    await postJson(app, '/agents/bot/run', { input: 'hi', multitaskStrategy: 'reject' });
    await postJson(app, '/agents/bot/stream', { input: 'hi', multitaskStrategy: 'rollback' });
    await postJson(app, '/agents/bot/run', { input: 'hi' });

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
      const run = vi.fn();
      const app = buildApp({ run });

      const res = await postJson(app, path, { input: 'hi', multitaskStrategy: 'queue' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect(run).not.toHaveBeenCalled();
    }
  );

  it('answers a run on a busy thread with 409 THREAD_BUSY', async () => {
    const app = buildApp({
      run: vi
        .fn()
        .mockRejectedValue(
          new CogitatorError({ message: 'Thread is busy', code: ErrorCode.THREAD_BUSY })
        ),
    });

    const res = await postJson(app, '/agents/bot/run', {
      input: 'hi',
      threadId: 'thread-1',
      multitaskStrategy: 'reject',
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'THREAD_BUSY' } });
  });

  it('hands the answers of HTTP resumes and resume streams to cogitator.resume()', async () => {
    const resume = vi.fn().mockResolvedValue(result());
    const app = buildApp({ resume });
    const responses = { int_1: 'order 42' };

    await postJson(app, '/agents/bot/resume', { threadId: 'thread-1', responses });
    await postJson(app, '/agents/bot/resume/stream', { threadId: 'thread-1', responses });

    expect(resume.mock.calls.map(([, , options]) => options.responses)).toEqual([
      responses,
      responses,
    ]);
  });

  it('answers a resume whose answers are not an object with 400', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await postJson(app, '/agents/bot/resume', {
      threadId: 'thread-1',
      responses: 'yes',
    });

    expect(res.status).toBe(400);
    expect(resume).not.toHaveBeenCalled();
  });

  it('streams interrupt-required instead of approval-required when the run asks', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(asking()) });

    const res = await postJson(app, '/agents/bot/stream', { input: 'refund' });
    const events = parseSSE(res.text);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['interrupt-required', 'finish']);
    expect(events.at(-2)).toEqual({
      type: 'interrupt-required',
      threadId: 'thread-1',
      interrupts: [question],
    });
    expect(events.at(-1)).toMatchObject({ status: 'paused', interrupts: [question] });
    expect(res.text).not.toContain('kept on the server');
  });

  it('passes the multitask strategy and answers of WebSocket runs and resumes', async () => {
    const run = vi.fn().mockResolvedValue(asking());
    const resume = vi.fn().mockResolvedValue(result());
    const client = await connect({ run, resume });

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
    const run = vi.fn();
    const client = await connect({ run });

    client.send({
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'go', multitaskStrategy: 'queue' },
    });

    await vi.waitFor(() => expect(client.messages).toHaveLength(1));
    expect(client.messages[0]).toMatchObject({ type: 'error', id: 'r1' });
    expect(String(client.messages[0].error)).toContain('multitaskStrategy');
    expect(run).not.toHaveBeenCalled();
  });
});
