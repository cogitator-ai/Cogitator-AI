import { describe, it, expect, vi } from 'vitest';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode, type RunOptions } from '@cogitator-ai/types';
import { createChatHandler } from '../handlers/chat.js';
import { createResumeHandler } from '../handlers/resume.js';
import { createAgentHandler } from '../handlers/agent.js';

const agent = { id: 'agent_1', name: 'assistant' } as unknown as Agent;

function runtime() {
  const result = {
    output: 'done',
    threadId: 't1',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    toolCalls: [],
    trace: { traceId: 'trace_1', spans: [] },
  };
  return {
    run: vi.fn(async (_agent: unknown, _options: RunOptions) => result),
    resume: vi.fn(async () => result),
  };
}

function post(body: unknown): Request {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('server contract in the route handlers', () => {
  it('refuses a chat on a thread authorizeThread keeps the caller from, before it streams', async () => {
    const cog = runtime();
    const handler = createChatHandler(cog as unknown as Cogitator, agent, {
      authorizeThread: (_req, threadId) => threadId !== 'locked',
    });

    const res = await handler(
      post({ threadId: 'locked', messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { message: "Access to thread 'locked' is not allowed", code: 'THREAD_FORBIDDEN' },
    });
    expect(cog.run).not.toHaveBeenCalled();
  });

  it('refuses a streamed resume of a caller beforeRun gave no user under anonymous deny', async () => {
    const cog = runtime();
    const handler = createResumeHandler(cog as unknown as Cogitator, agent, {
      stream: true,
      anonymous: 'deny',
      beforeRun: async () => ({}),
    });

    const res = await handler(post({ threadId: 't1', decisions: {} }));

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(cog.resume).not.toHaveBeenCalled();
  });

  it('runs a caller beforeRun names under anonymous deny, with the deps of the request', async () => {
    const cog = runtime();
    const handler = createAgentHandler(cog as unknown as Cogitator, agent, {
      anonymous: 'deny',
      beforeRun: async (req) => ({ userId: req.headers.get('x-user') ?? undefined }),
      deps: (req) => ({ tenant: new URL(req.url).hostname }),
    });

    const res = await handler(
      new Request('http://acme.test/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user': 'ann' },
        body: JSON.stringify({ input: 'hi' }),
      })
    );

    expect(res.status).toBe(200);
    expect(cog.run.mock.calls[0]![1]).toMatchObject({
      userId: 'ann',
      deps: { tenant: 'acme.test' },
    });
  });

  it('answers a run the provider rate limited with Retry-After in whole seconds', async () => {
    const cog = runtime();
    cog.run.mockRejectedValueOnce(
      new CogitatorError({
        message: 'Slow down',
        code: ErrorCode.LLM_RATE_LIMITED,
        retryAfter: 2500,
      })
    );
    const handler = createAgentHandler(cog as unknown as Cogitator, agent);

    const res = await handler(post({ input: 'hi' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
  });

  it('asks authorizeThread about the thread beforeRun sends the run to', async () => {
    const cog = runtime();
    const handler = createAgentHandler(cog as unknown as Cogitator, agent, {
      beforeRun: async () => ({ threadId: 'locked' }),
      authorizeThread: (_req, threadId) => threadId !== 'locked',
    });

    const res = await handler(post({ input: 'hi' }));

    expect(res.status).toBe(403);
    expect(cog.run).not.toHaveBeenCalled();
  });

  it('answers an error thrown by authorizeThread or deps in the error envelope', async () => {
    const cog = runtime();
    const handler = createChatHandler(cog as unknown as Cogitator, agent, {
      deps: () => {
        throw new CogitatorError({
          message: 'tenant store is busy',
          code: ErrorCode.LLM_RATE_LIMITED,
          retryAfter: 4000,
        });
      },
    });

    const res = await handler(post({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('4');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('LLM_RATE_LIMITED');
  });

  it('keeps the text and code of an error beforeRun did not answer with on purpose', async () => {
    const handler = createAgentHandler(runtime() as unknown as Cogitator, agent, {
      beforeRun: async () => {
        throw Object.assign(new Error('Sign in first'), { code: 'ECONNREFUSED' });
      },
    });
    const refused = createAgentHandler(runtime() as unknown as Cogitator, agent, {
      beforeRun: async () => {
        throw Object.assign(new Error('Plan expired'), { status: 402, code: 'PLAN_EXPIRED' });
      },
    });

    const res = await handler(post({ input: 'hi' }));
    const paid = await refused(post({ input: 'hi' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
    expect(paid.status).toBe(402);
    expect(await paid.json()).toEqual({ error: { message: 'Plan expired', code: 'PLAN_EXPIRED' } });
  });
});
