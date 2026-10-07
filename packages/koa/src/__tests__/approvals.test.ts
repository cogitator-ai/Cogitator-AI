import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import Koa from 'koa';
import request from 'supertest';
import WebSocket from 'ws';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
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
