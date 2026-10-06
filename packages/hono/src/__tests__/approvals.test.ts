import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { cogitatorApp } from '../app.js';
import { createClientState, handleWebSocketMessage } from '../websocket/handler.js';
import type { CogitatorAppOptions, CogitatorContext } from '../types.js';

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
  return cogitatorApp({
    cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    agents: { bot: agent },
    ...overrides,
  });
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  };
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

    const res = await app.request('/agents/bot/run', post({ input: 'refund order 42' }));
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
    const app = buildApp({
      run: vi.fn().mockResolvedValue(result({ output: 'hi', reasoning: 'thought about it' })),
    });

    const body = (await (await app.request('/agents/bot/run', post({ input: 'hi' }))).json()) as
      Record<string, unknown> | undefined;

    expect(body).toMatchObject({
      output: 'hi',
      status: 'completed',
      reasoning: 'thought about it',
    });
    expect(body).not.toHaveProperty('pendingApprovals');
  });

  it('streams approval-required before finish when the run pauses', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(paused()) });

    const res = await app.request('/agents/bot/stream', post({ input: 'refund' }));
    const raw = await res.text();
    const events = parseSSE(raw);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['approval-required', 'finish']);
    expect(events.at(-2)).toEqual({
      type: 'approval-required',
      threadId: 'thread-1',
      approvals: [approval],
    });
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it('does not emit approval-required for completed streams', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(result({ output: 'done' })) });

    const events = parseSSE(
      await (await app.request('/agents/bot/stream', post({ input: 'hi' }))).text()
    );

    expect(events.some((e) => e.type === 'approval-required')).toBe(false);
  });

  it('resumes the thread as the authenticated user with the decisions', async () => {
    const resume = vi.fn().mockResolvedValue(result({ output: 'refunded' }));
    const app = buildApp({ resume }, { auth: () => ({ userId: 'user-7' }) });

    const res = await app.request(
      '/agents/bot/resume',
      post({
        threadId: 'thread-1',
        decisions: {
          call_1: { approved: true },
          call_2: { approved: false, reason: 'too risky' },
        },
        defaultDecision: { approved: false },
      })
    );

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
    const app = buildApp({ resume: vi.fn().mockResolvedValue(paused()) });

    const raw = await (
      await app.request('/agents/bot/resume', post({ threadId: 'thread-1' }))
    ).text();

    expect(JSON.parse(raw)).toMatchObject({ status: 'paused', pendingApprovals: [approval] });
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it.each([
    ['malformed JSON', '{oops'],
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

    const res = await app.request('/agents/bot/resume', post(body));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await app.request('/agents/ghost/resume', post({ threadId: 't' }));

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

    const res = await app.request('/agents/bot/resume', post({ threadId: 'thread-1' }));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { message: 'nope', code } });
  });
});

describe('approvals over WebSocket', () => {
  function mockSocket() {
    const messages: string[] = [];
    return {
      socket: { send: vi.fn((data: string) => messages.push(data)), readyState: 1 },
      responses: () => messages.map((m) => JSON.parse(m) as Record<string, unknown>),
    };
  }

  function context(runtime: Record<string, unknown>): CogitatorContext {
    return {
      runtime: runtime as unknown as CogitatorContext['runtime'],
      agents: { bot: agent },
      workflows: {},
      swarms: {},
    };
  }

  it('completes a paused run with its approvals and without the checkpoint', async () => {
    const { socket, responses } = mockSocket();
    const ctx = context({ run: vi.fn().mockResolvedValue(paused()) });

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'r1',
        payload: { type: 'agent', name: 'bot', input: 'go' },
      }),
      ctx,
      createClientState()
    );

    const [complete] = responses();
    const payload = complete.payload as { type: string; result: Record<string, unknown> };
    expect(payload.type).toBe('complete');
    expect(payload.result).toMatchObject({ status: 'paused', pendingApprovals: [approval] });
    expect(payload.result).not.toHaveProperty('checkpoint');
  });

  it('resumes a paused run with the decisions as the connected user', async () => {
    const { socket, responses } = mockSocket();
    const resume = vi.fn(
      async (_agent: unknown, _threadId: string, options: { onToken?: (t: string) => void }) => {
        options.onToken?.('Refunded');
        return paused();
      }
    );

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'resume',
        id: 'r2',
        payload: { name: 'bot', threadId: 'thread-1', decisions: { call_1: { approved: true } } },
      }),
      context({ resume }),
      createClientState({ userId: 'user-7' })
    );

    expect(resume.mock.calls[0][1]).toBe('thread-1');
    expect(resume.mock.calls[0][2]).toMatchObject({
      userId: 'user-7',
      decisions: { call_1: { approved: true } },
      stream: true,
    });
    const events = responses().map((r) => r.payload as { type: string; result?: object });
    expect(events.map((e) => e.type)).toEqual(['token', 'complete']);
    expect(events[1].result).not.toHaveProperty('checkpoint');
  });

  it('rejects a malformed resume payload', async () => {
    const { socket, responses } = mockSocket();
    const resume = vi.fn();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({ type: 'resume', id: 'r3', payload: { name: 'bot' } }),
      context({ resume }),
      createClientState()
    );

    expect(responses()[0]).toMatchObject({ type: 'error', id: 'r3' });
    expect(String(responses()[0].error)).toContain('Invalid resume payload');
    expect(resume).not.toHaveBeenCalled();
  });

  it('reports a resume of a thread without a paused run', async () => {
    const { socket, responses } = mockSocket();
    const resume = vi
      .fn()
      .mockRejectedValue(
        new CogitatorError({ message: 'No paused run', code: ErrorCode.RUN_NOT_PAUSED })
      );

    await handleWebSocketMessage(
      socket,
      JSON.stringify({ type: 'resume', id: 'r4', payload: { name: 'bot', threadId: 't' } }),
      context({ resume }),
      createClientState()
    );

    expect(responses()[0]).toEqual({ type: 'error', id: 'r4', error: 'No paused run' });
  });
});
