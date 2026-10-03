import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ResumeOptions,
  RunOptions,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { createAgentHandler } from '../handlers/agent.js';
import { createChatHandler } from '../handlers/chat.js';
import { createResumeHandler } from '../handlers/resume.js';
import { StreamWriter } from '../streaming/stream-writer.js';

const refundApproval = {
  toolCallId: 'call_1',
  toolName: 'refund',
  arguments: { order: 'A-1', amount: 500 },
  description: 'Refund an order',
  sideEffects: ['payment'],
};

function runResult(overrides: Record<string, unknown> = {}) {
  return {
    output: 'Done',
    threadId: 'thread_1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    toolCalls: [],
    trace: { traceId: 't', spans: [] },
    status: 'completed',
    ...overrides,
  };
}

function pausedResult(overrides: Record<string, unknown> = {}) {
  return runResult({
    output: 'Let me refund that.',
    status: 'paused',
    pendingApprovals: [refundApproval],
    checkpoint: {
      version: 1,
      threadId: 'thread_1',
      userId: 'ada',
      messages: [{ role: 'system', content: 'secret instructions' }],
    },
    ...overrides,
  });
}

type ResumeImpl = (threadId: string, options: ResumeOptions) => Promise<unknown> | unknown;

function fakeCogitator(
  run: (options: RunOptions) => Promise<unknown> | unknown = () => runResult(),
  resume: ResumeImpl = () => runResult()
) {
  const runMock = vi.fn(async (_agent: Agent, options: RunOptions) => run(options));
  const resumeMock = vi.fn(async (_agent: Agent, threadId: string, options: ResumeOptions) =>
    resume(threadId, options)
  );
  return {
    cogitator: { run: runMock, resume: resumeMock } as unknown as Cogitator,
    run: runMock,
    resume: resumeMock,
  };
}

const fakeAgent = { id: 'agent_1' } as unknown as Agent;

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function parseEvents(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe('a run paused for approvals', () => {
  it('answers the agent handler with the pending approvals and never the checkpoint', async () => {
    const { cogitator } = fakeCogitator(() => pausedResult());
    const res = await createAgentHandler(
      cogitator,
      fakeAgent
    )(post('/api/agent', { input: 'Refund A-1' }));

    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('checkpoint');
    expect(text).not.toContain('secret instructions');
    expect(JSON.parse(text)).toMatchObject({
      output: 'Let me refund that.',
      threadId: 'thread_1',
      status: 'paused',
      pendingApprovals: [refundApproval],
    });
  });

  it('reports a completed run without pending approvals', async () => {
    const { cogitator } = fakeCogitator();
    const res = await createAgentHandler(cogitator, fakeAgent)(post('/api/agent', { input: 'hi' }));

    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toBe('completed');
    expect(data).not.toHaveProperty('pendingApprovals');
  });

  it('streams approval-required after the open part closes and before finish', async () => {
    const { cogitator } = fakeCogitator((options) => {
      options.onReasoning?.('Needs a refund');
      options.onToken?.('Let me refund that.');
      return pausedResult();
    });
    const res = await createChatHandler(
      cogitator,
      fakeAgent
    )(post('/api/chat', { messages: [{ role: 'user', content: 'Refund A-1' }] }));

    const raw = await res.text();
    const events = parseEvents(raw);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'approval-required',
      'finish',
    ]);
    expect(events[7]).toEqual({
      type: 'approval-required',
      threadId: 'thread_1',
      approvals: [refundApproval],
    });
    expect(raw).not.toContain('secret instructions');
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('does not stream approval-required for a completed run', async () => {
    const { cogitator } = fakeCogitator();
    const res = await createChatHandler(
      cogitator,
      fakeAgent
    )(post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }));

    const types = parseEvents(await res.text()).map((event) => event.type);
    expect(types).not.toContain('approval-required');
  });
});

describe('StreamWriter.approvalRequired', () => {
  it('writes the approval-required event', async () => {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = new StreamWriter(writable.getWriter());
    const text = new Response(readable).text();

    await writer.approvalRequired('thread_1', [refundApproval]);
    await writer.close();

    expect(parseEvents(await text)).toEqual([
      { type: 'approval-required', threadId: 'thread_1', approvals: [refundApproval] },
    ]);
  });
});

describe('createResumeHandler', () => {
  it('resumes the thread as the user beforeRun returns, with the decisions', async () => {
    const { cogitator, resume } = fakeCogitator(undefined, () => runResult({ output: 'Refunded' }));
    const beforeRun = vi.fn(async () => ({ userId: 'ada' }));
    const afterRun = vi.fn(async () => {});
    const handler = createResumeHandler(cogitator, fakeAgent, { beforeRun, afterRun });

    const res = await handler(
      post('/api/resume', {
        threadId: 'thread_1',
        decisions: {
          call_1: { approved: true, reason: 'ignored' },
          call_2: { approved: false, reason: 'Too much' },
          call_3: { approved: false },
        },
        defaultDecision: { approved: false },
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ output: 'Refunded', status: 'completed' });
    const [, threadId, options] = resume.mock.calls[0];
    expect(threadId).toBe('thread_1');
    expect(options.userId).toBe('ada');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.decisions).toEqual({
      call_1: { approved: true },
      call_2: { approved: false, reason: 'Too much' },
      call_3: { approved: false },
    });
    expect(options.defaultDecision).toEqual({ approved: false });
    expect(beforeRun).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ threadId: 'thread_1' })
    );
    expect(afterRun).toHaveBeenCalledOnce();
  });

  it('answers a run that pauses again with its new approvals and no checkpoint', async () => {
    const { cogitator } = fakeCogitator(undefined, () => pausedResult());
    const res = await createResumeHandler(
      cogitator,
      fakeAgent
    )(post('/api/resume', { threadId: 'thread_1' }));

    const text = await res.text();
    expect(text).not.toContain('checkpoint');
    expect(JSON.parse(text)).toMatchObject({
      status: 'paused',
      pendingApprovals: [refundApproval],
    });
  });

  it.each([
    [{}, 'threadId must be a non-empty string'],
    [{ threadId: '' }, 'threadId must be a non-empty string'],
    [{ threadId: 't', decisions: [] }, 'decisions must be an object keyed by tool call id'],
    [
      { threadId: 't', decisions: { call_1: { approved: 'yes' } } },
      'decisions.call_1 must be an object with a boolean approved',
    ],
    [
      { threadId: 't', decisions: { call_1: { approved: false, reason: 5 } } },
      'decisions.call_1.reason must be a string',
    ],
    [
      { threadId: 't', defaultDecision: true },
      'defaultDecision must be an object with a boolean approved',
    ],
  ])('refuses %j with 400 without resuming', async (body, error) => {
    const { cogitator, resume } = fakeCogitator();
    const res = await createResumeHandler(cogitator, fakeAgent)(post('/api/resume', body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(resume).not.toHaveBeenCalled();
  });

  it('refuses invalid JSON with 400', async () => {
    const { cogitator, resume } = fakeCogitator();
    const res = await createResumeHandler(
      cogitator,
      fakeAgent
    )(post('/api/resume', '{"threadId":'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(resume).not.toHaveBeenCalled();
  });

  it('answers 401 when beforeRun throws, without resuming', async () => {
    const { cogitator, resume } = fakeCogitator();
    const res = await createResumeHandler(cogitator, fakeAgent, {
      beforeRun: async () => {
        throw new Error('Sign in first');
      },
    })(post('/api/resume', { threadId: 'thread_1' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in first' });
    expect(resume).not.toHaveBeenCalled();
  });

  it('uses a custom parseInput', async () => {
    const { cogitator, resume } = fakeCogitator();
    await createResumeHandler(cogitator, fakeAgent, {
      parseInput: async () => ({ threadId: 'from_parser', defaultDecision: { approved: true } }),
    })(post('/api/resume', { threadId: 'ignored' }));

    const [, threadId, options] = resume.mock.calls[0];
    expect(threadId).toBe('from_parser');
    expect(options.defaultDecision).toEqual({ approved: true });
  });

  it('maps runtime errors to their status and code', async () => {
    const { cogitator } = fakeCogitator(undefined, () => {
      throw new CogitatorError({ message: 'No paused run', code: ErrorCode.RUN_NOT_PAUSED });
    });
    const res = await createResumeHandler(
      cogitator,
      fakeAgent
    )(post('/api/resume', { threadId: 'thread_1' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No paused run', code: 'RUN_NOT_PAUSED' });
  });

  it('streams the rest of the run with stream: true', async () => {
    const { cogitator, resume } = fakeCogitator(undefined, (_threadId, options) => {
      options.onToolResult?.({ callId: 'call_1', name: 'refund', result: { refunded: 'A-1' } });
      options.onToken?.('Refunded');
      return runResult({ output: 'Refunded' });
    });
    const res = await createResumeHandler(cogitator, fakeAgent, {
      stream: true,
      beforeRun: async () => ({ userId: 'ada' }),
    })(post('/api/resume', { threadId: 'thread_1', defaultDecision: { approved: true } }));

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const events = parseEvents(await res.text());
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    const [, , options] = resume.mock.calls[0];
    expect(options).toMatchObject({
      userId: 'ada',
      stream: true,
      defaultDecision: { approved: true },
    });
  });

  it('streams an error event when a streamed resume fails', async () => {
    const { cogitator } = fakeCogitator(undefined, () => {
      throw new CogitatorError({ message: 'No paused run', code: ErrorCode.RUN_NOT_PAUSED });
    });
    const res = await createResumeHandler(cogitator, fakeAgent, { stream: true })(
      post('/api/resume', { threadId: 'thread_1' })
    );

    expect(parseEvents(await res.text()).at(-1)).toEqual({
      type: 'error',
      message: 'No paused run',
      code: 'RUN_NOT_PAUSED',
    });
  });
});

describe('approvals with the real runtime', () => {
  const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
  const refund = tool({
    name: 'refund',
    description: 'Refund an order',
    parameters: z.object({ order: z.string() }),
    requiresApproval: true,
    execute: refundImpl,
  });
  const respond = (request: ChatRequest): ChatResponse => {
    const results = request.messages.filter((message) => message.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me refund it.',
        toolCalls: [{ id: 'call_1', name: 'refund', arguments: { order: 'A-1' } }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'r2',
      content: `Done: ${results.map((message) => String(message.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: async (request) => respond(request),
    chatStream: async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    },
  };
  const runtimes: Cogitator[] = [];
  const agent = new Agent({
    name: 'support',
    model: 'mock/m',
    instructions: 'Handle refunds.',
    tools: [refund],
  });
  const userFrom = async (req: Request) => ({ userId: req.headers.get('x-user') ?? undefined });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((cog) => cog.close()));
    refundImpl.mockClear();
  });

  it('pauses, refuses other users and answers 409 once the run went on', async () => {
    const cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
    runtimes.push(cogitator);
    const run = createAgentHandler(cogitator, agent, { beforeRun: userFrom });
    const resume = createResumeHandler(cogitator, agent, { beforeRun: userFrom });

    const paused = await run(
      post('/api/agent', { input: 'Refund A-1', threadId: 'ada-refund' }, { 'x-user': 'ada' })
    );
    expect(await paused.json()).toMatchObject({
      status: 'paused',
      threadId: 'ada-refund',
      pendingApprovals: [{ toolCallId: 'call_1', toolName: 'refund', arguments: { order: 'A-1' } }],
    });
    expect(refundImpl).not.toHaveBeenCalled();

    const foreign = await resume(
      post(
        '/api/resume',
        { threadId: 'ada-refund', defaultDecision: { approved: true } },
        { 'x-user': 'grace' }
      )
    );
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { code: string }).code).toBe('THREAD_ACCESS_DENIED');
    expect(refundImpl).not.toHaveBeenCalled();

    const resumed = await resume(
      post(
        '/api/resume',
        { threadId: 'ada-refund', decisions: { call_1: { approved: true } } },
        { 'x-user': 'ada' }
      )
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as { status: string; output: string };
    expect(body.status).toBe('completed');
    expect(body.output).toContain('A-1');
    expect(refundImpl).toHaveBeenCalledOnce();

    const again = await resume(
      post(
        '/api/resume',
        { threadId: 'ada-refund', defaultDecision: { approved: true } },
        { 'x-user': 'ada' }
      )
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('RUN_NOT_PAUSED');
    expect(refundImpl).toHaveBeenCalledOnce();
  });
});
