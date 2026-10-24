import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CogitatorError, ErrorCode, type ResumeOptions } from '@cogitator-ai/types';
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

describe('resume over SSE', () => {
  it('streams the rest of a paused run on its thread', async () => {
    const resume = vi.fn(async (_agent: unknown, _threadId: string, options: ResumeOptions) => {
      options.onToolCall?.({ id: 'call_1', name: 'refund', arguments: { orderId: 42 } });
      options.onToolResult?.({ callId: 'call_1', name: 'refund', result: { ok: true } });
      options.onToken?.('Refunded');
      return result({ output: 'Refunded' });
    });
    const app = buildApp({ resume }, { auth: () => ({ userId: 'user-7' }) });

    const res = await app.request(
      '/agents/bot/resume/stream',
      post({
        threadId: 'thread-1',
        decisions: { call_1: { approved: true } },
        defaultDecision: { approved: false, reason: 'no' },
      })
    );
    const raw = await res.text();
    const events = parseSSE(raw);

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

  it('streams approval-required when the resumed run pauses again', async () => {
    const app = buildApp({ resume: vi.fn().mockResolvedValue(paused()) });

    const raw = await (
      await app.request('/agents/bot/resume/stream', post({ threadId: 'thread-1' }))
    ).text();
    const events = parseSSE(raw);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['approval-required', 'finish']);
    expect(events.at(-1)).toMatchObject({ status: 'paused' });
    expect(raw).not.toContain('SECRET_CHECKPOINT');
  });

  it.each([
    ['malformed JSON', '{oops'],
    ['decision without approved', { threadId: 't', decisions: { call_1: {} } }],
  ])('answers 400 for a body with %s before streaming', async (_name, body) => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await app.request('/agents/bot/resume/stream', post(body));

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await app.request('/agents/ghost/resume/stream', post({ threadId: 't' }));

    expect(res.status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it('refuses a thread the caller cannot access before streaming', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume }, { authorizeThread: () => false });

    const res = await app.request('/agents/bot/resume/stream', post({ threadId: 'thread-1' }));

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('THREAD_FORBIDDEN');
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

    const res = await app.request('/agents/bot/resume/stream', post({ threadId: 'thread-1' }));
    const events = parseSSE(await res.text());

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
    const app = buildApp({ resume });
    const client = new AbortController();

    const res = await app.fetch(
      new Request('http://localhost/agents/bot/resume/stream', {
        ...post({ threadId: 'thread-1' }),
        signal: client.signal,
      })
    );
    await res.body!.getReader().read();
    client.abort();

    await abortSeen;
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

  it('passes the multitask strategy of HTTP runs and streams into the run options', async () => {
    const run = vi.fn().mockResolvedValue(result());
    const app = buildApp({ run });

    await app.request('/agents/bot/run', post({ input: 'hi', multitaskStrategy: 'reject' }));
    await (
      await app.request('/agents/bot/stream', post({ input: 'hi', multitaskStrategy: 'rollback' }))
    ).text();
    await app.request('/agents/bot/run', post({ input: 'hi' }));

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

      const res = await app.request(path, post({ input: 'hi', multitaskStrategy: 'queue' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
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

    const res = await app.request(
      '/agents/bot/run',
      post({ input: 'hi', threadId: 'thread-1', multitaskStrategy: 'reject' })
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'THREAD_BUSY' } });
  });

  it('streams a run on a busy thread as 200 and an error event with THREAD_BUSY', async () => {
    const app = buildApp({
      run: vi
        .fn()
        .mockRejectedValue(
          new CogitatorError({ message: 'Thread is busy', code: ErrorCode.THREAD_BUSY })
        ),
    });

    const res = await app.request(
      '/agents/bot/stream',
      post({ input: 'hi', threadId: 'thread-1', multitaskStrategy: 'reject' })
    );

    expect(res.status).toBe(200);
    expect(parseSSE(await res.text()).map((event) => [event.type, event.code])).toEqual([
      ['start', undefined],
      ['error', 'THREAD_BUSY'],
    ]);
  });

  it('hands the answers of HTTP resumes and resume streams to cogitator.resume()', async () => {
    const resume = vi.fn().mockResolvedValue(result());
    const app = buildApp({ resume });
    const responses = { int_1: 'order 42' };

    await app.request('/agents/bot/resume', post({ threadId: 'thread-1', responses }));
    await (
      await app.request('/agents/bot/resume/stream', post({ threadId: 'thread-1', responses }))
    ).text();

    expect(resume.mock.calls.map(([, , options]) => options.responses)).toEqual([
      responses,
      responses,
    ]);
  });

  it('answers a resume whose answers are not an object with 400', async () => {
    const resume = vi.fn();
    const app = buildApp({ resume });

    const res = await app.request(
      '/agents/bot/resume',
      post({ threadId: 'thread-1', responses: 'yes' })
    );

    expect(res.status).toBe(400);
    expect(resume).not.toHaveBeenCalled();
  });

  it('streams interrupt-required instead of approval-required when the run asks', async () => {
    const app = buildApp({ run: vi.fn().mockResolvedValue(asking()) });

    const raw = await (await app.request('/agents/bot/stream', post({ input: 'refund' }))).text();
    const events = parseSSE(raw);

    expect(events.map((e) => e.type).slice(-2)).toEqual(['interrupt-required', 'finish']);
    expect(events.at(-2)).toEqual({
      type: 'interrupt-required',
      threadId: 'thread-1',
      interrupts: [question],
    });
    expect(events.at(-1)).toMatchObject({ status: 'paused', interrupts: [question] });
    expect(raw).not.toContain('kept on the server');
  });

  it('passes the multitask strategy and answers of WebSocket runs and resumes', async () => {
    const { socket, responses } = mockSocket();
    const run = vi.fn().mockResolvedValue(asking());
    const resume = vi.fn().mockResolvedValue(result());
    const ctx = context({ run, resume });

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'r1',
        payload: { type: 'agent', name: 'bot', input: 'go', multitaskStrategy: 'interrupt' },
      }),
      ctx,
      createClientState()
    );
    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'resume',
        id: 'r2',
        payload: { name: 'bot', threadId: 'thread-1', responses: { int_1: 'order 42' } },
      }),
      ctx,
      createClientState()
    );

    expect(run.mock.calls[0][1].multitaskStrategy).toBe('interrupt');
    expect(resume.mock.calls[0][2].responses).toEqual({ int_1: 'order 42' });
    expect(responses()[0].payload).toMatchObject({
      type: 'complete',
      result: { status: 'paused', interrupts: [question] },
    });
  });

  it('refuses a WebSocket run with an unknown multitask strategy', async () => {
    const { socket, responses } = mockSocket();
    const run = vi.fn();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'r1',
        payload: { type: 'agent', name: 'bot', input: 'go', multitaskStrategy: 'queue' },
      }),
      context({ run }),
      createClientState()
    );

    expect(responses()[0]).toMatchObject({ type: 'error', id: 'r1' });
    expect(String(responses()[0].error)).toContain('multitaskStrategy');
    expect(run).not.toHaveBeenCalled();
  });
});
