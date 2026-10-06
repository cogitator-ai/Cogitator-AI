import { afterAll, describe, expect, mock, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { z } from 'zod';
import { cogitatorController } from '../index.js';
import type { Authenticate, CogitatorDeps } from '../index.js';
import {
  chatAgent,
  fakeCogitator,
  json,
  lastResumeCall,
  pausedResult,
  readStream,
  refundApproval,
  runResult,
} from './helpers.js';

function serveCogitator(deps: CogitatorDeps) {
  return serve(
    createApp({ routes: group('/cogitator', { children: [cogitatorController(deps)] }) })
  );
}

const userFromHeader: Authenticate = (ctx) => {
  const userId = ctx.req.headers.get('x-user');
  return userId ? { userId } : {};
};

function as(userId: string, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('x-user', userId);
  return { ...init, headers };
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe('a run paused for approvals', () => {
  test('answers with the pending approvals and never the checkpoint', async () => {
    const { cogitator } = fakeCogitator(() => Promise.resolve(pausedResult()));
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/chat/run', json({ input: 'Refund A-1' }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('checkpoint');
    expect(text).not.toContain('secret instructions');
    expect(JSON.parse(text)).toEqual({
      output: 'Let me do that.',
      threadId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [],
      status: 'paused',
      pendingApprovals: [refundApproval],
      traceId: 'trace-1',
    });
  });

  test('reports a completed run as completed', async () => {
    const { cogitator } = fakeCogitator(() => Promise.resolve(runResult({ status: 'completed' })));
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/chat/run', json({ input: 'hi' }));

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(body).not.toHaveProperty('pendingApprovals');
  });

  test('streams approval-required after the open part closes and before finish', async () => {
    const { cogitator } = fakeCogitator(async (_agent, options) => {
      options.onReasoning?.('Needs a refund');
      options.onToken?.('Let me do that.');
      return pausedResult();
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const { events, done } = await readStream(
      await request('/cogitator/agents/chat/stream', json({ input: 'Refund A-1' }))
    );

    expect(done).toBe(true);
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
      threadId: 'thread-1',
      approvals: [refundApproval],
    });
    expect(JSON.stringify(events)).not.toContain('secret instructions');
  });

  test('does not stream approval-required for a completed run', async () => {
    const { cogitator } = fakeCogitator(async (_agent, options) => {
      options.onToken?.('Done');
      return runResult({ status: 'completed' });
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const { events } = await readStream(
      await request('/cogitator/agents/chat/stream', json({ input: 'hi' }))
    );

    expect(events.map((event) => event.type)).not.toContain('approval-required');
  });
});

describe('resume route', () => {
  test('resumes the thread as the caller with the decisions', async () => {
    const { cogitator, resume } = fakeCogitator(undefined, undefined, () =>
      Promise.resolve(runResult({ output: 'Refunded', status: 'completed' }))
    );
    const request = serveCogitator({
      cogitator,
      agents: { chat: chatAgent() },
      auth: userFromHeader,
    });

    const res = await request(
      '/cogitator/agents/chat/resume',
      as(
        'ada',
        json({
          threadId: 't-1',
          decisions: {
            'call-1': { approved: true, reason: 'ignored' },
            'call-2': { approved: false, reason: 'Too much' },
            'call-3': { approved: false },
          },
          defaultDecision: { approved: false },
        })
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ output: 'Refunded', status: 'completed' });
    const { threadId, options } = lastResumeCall(resume);
    expect(threadId).toBe('t-1');
    expect(options.userId).toBe('ada');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.decisions).toEqual({
      'call-1': { approved: true },
      'call-2': { approved: false, reason: 'Too much' },
      'call-3': { approved: false },
    });
    expect(options.defaultDecision).toEqual({ approved: false });
  });

  test('answers a run that pauses again with its new approvals', async () => {
    const { cogitator } = fakeCogitator(undefined, undefined, () =>
      Promise.resolve(pausedResult())
    );
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/chat/resume', json({ threadId: 't-1' }));

    const text = await res.text();
    expect(text).not.toContain('checkpoint');
    expect(JSON.parse(text)).toMatchObject({
      status: 'paused',
      pendingApprovals: [refundApproval],
    });
  });

  test('refuses an invalid body with every issue', async () => {
    const { cogitator, resume } = fakeCogitator();
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request(
      '/cogitator/agents/chat/resume',
      json({ threadId: '', decisions: { 'call-1': { approved: 'yes' } } })
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: Array<{ path: string[] }> };
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(body.issues.map((issue) => issue.path.join('.'))).toEqual([
      'body.threadId',
      'body.decisions.call-1.approved',
    ]);
    expect(resume).not.toHaveBeenCalled();
  });

  test('refuses malformed JSON', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/chat/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"threadId":',
    });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('MALFORMED_JSON');
  });

  test('answers 404 for an unknown agent', async () => {
    const { cogitator, resume } = fakeCogitator();
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/ghost/resume', json({ threadId: 't-1' }));

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('AGENT_NOT_FOUND');
    expect(resume).not.toHaveBeenCalled();
  });

  test('answers 403 THREAD_FORBIDDEN when authorizeThread refuses the thread', async () => {
    const { cogitator, resume } = fakeCogitator();
    const request = serveCogitator({
      cogitator,
      agents: { chat: chatAgent() },
      authorizeThread: (_auth, threadId) => threadId !== 'private',
    });

    const res = await request('/cogitator/agents/chat/resume', json({ threadId: 'private' }));

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('THREAD_FORBIDDEN');
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('resume stream', () => {
  test('streams the rest of the run', async () => {
    const { cogitator, resume } = fakeCogitator(undefined, undefined, async (_agent, _id, opts) => {
      opts.onToolResult?.({ callId: 'call-1', name: 'refund', result: { refunded: 'A-1' } });
      opts.onToken?.('Refunded');
      return runResult({ output: 'Refunded', status: 'completed' });
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const { events, done } = await readStream(
      await request(
        '/cogitator/agents/chat/resume/stream',
        json({ threadId: 't-1', defaultDecision: { approved: true } })
      )
    );

    expect(done).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    const { threadId, options } = lastResumeCall(resume);
    expect(threadId).toBe('t-1');
    expect(options.defaultDecision).toEqual({ approved: true });
    expect(options.stream).toBe(true);
  });

  test('streams approval-required when the run pauses again', async () => {
    const { cogitator } = fakeCogitator(undefined, undefined, () =>
      Promise.resolve(pausedResult())
    );
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const { events } = await readStream(
      await request('/cogitator/agents/chat/resume/stream', json({ threadId: 't-1' }))
    );

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'approval-required',
      'finish',
    ]);
    expect(events[0]).toMatchObject({ threadId: 't-1' });
    expect(events.at(-1)).toMatchObject({ threadId: 'thread-1', status: 'paused' });
  });

  test('ends with an error event when the thread has no paused run', async () => {
    const { cogitator } = fakeCogitator(undefined, undefined, async () => {
      throw new CogitatorError({
        message: 'Thread t-1 has no paused run',
        code: ErrorCode.RUN_NOT_PAUSED,
      });
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const { events, done } = await readStream(
      await request('/cogitator/agents/chat/resume/stream', json({ threadId: 't-1' }))
    );

    expect(done).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Thread t-1 has no paused run',
      code: 'RUN_NOT_PAUSED',
    });
  });
});

describe('approvals with the real runtime', () => {
  const refundImpl = mock(async ({ order }: { order: string }) => ({ refunded: order }));
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
        toolCalls: [{ id: 'call-1', name: 'refund', arguments: { order: 'A-1' } }],
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
  const cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
  const agent = new Agent({
    name: 'support',
    model: 'mock/m',
    instructions: 'Handle refunds.',
    tools: [refund],
  });
  const request = serveCogitator({ cogitator, agents: { support: agent }, auth: userFromHeader });

  afterAll(() => cogitator.close());

  test('pauses, refuses other users and 409s once the run went on', async () => {
    const paused = await request(
      '/cogitator/agents/support/run',
      as('ada', json({ input: 'Refund A-1', threadId: 'ada-refund' }))
    );
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      status: 'paused',
      threadId: 'ada-refund',
      pendingApprovals: [{ toolCallId: 'call-1', toolName: 'refund', arguments: { order: 'A-1' } }],
    });
    expect(refundImpl).not.toHaveBeenCalled();

    const foreign = await request(
      '/cogitator/agents/support/resume',
      as('grace', json({ threadId: 'ada-refund', defaultDecision: { approved: true } }))
    );
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe('THREAD_ACCESS_DENIED');
    expect(refundImpl).not.toHaveBeenCalled();

    const resumed = await request(
      '/cogitator/agents/support/resume',
      as('ada', json({ threadId: 'ada-refund', decisions: { 'call-1': { approved: true } } }))
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as { status: string; output: string };
    expect(body.status).toBe('completed');
    expect(body.output).toContain('A-1');
    expect(refundImpl).toHaveBeenCalledTimes(1);

    const again = await request(
      '/cogitator/agents/support/resume',
      as('ada', json({ threadId: 'ada-refund', defaultDecision: { approved: true } }))
    );
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('RUN_NOT_PAUSED');
    expect(refundImpl).toHaveBeenCalledTimes(1);
  });
});
