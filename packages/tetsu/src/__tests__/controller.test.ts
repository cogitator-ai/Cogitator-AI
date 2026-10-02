import { describe, expect, test } from 'bun:test';
import { createApp, group, HttpError } from '@tetsujs/core';
import type { FailureReport } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';
import {
  chatAgent,
  deferred,
  fakeCogitator,
  lastRunOptions,
  fakeMemory,
  json,
  readStream,
  runResult,
} from './helpers.js';

function serveCogitator(deps: CogitatorDeps, reports: FailureReport[] = []) {
  return serve(
    createApp({
      routes: group('/cogitator', { children: [cogitatorController(deps)] }),
      reportError: (report) => {
        reports.push(report);
      },
    })
  );
}

describe('health', () => {
  const { cogitator } = fakeCogitator();
  const request = serveCogitator({ cogitator, auth: () => undefined });

  test('answers without authentication', async () => {
    const res = await request('/cogitator/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect((await request('/cogitator/ready')).status).toBe(200);
  });
});

describe('agents', () => {
  const { cogitator, run } = fakeCogitator(() =>
    Promise.resolve(
      runResult({
        toolCalls: [
          {
            id: 'call-1',
            name: 'get_weather',
            arguments: { city: 'Paris' },
            replay: {
              itemId: 'fc_1',
              precedingItems: [{ type: 'reasoning', encrypted_content: 'opaque' }],
            },
          },
        ],
        structured: { mood: 'sunny' },
      })
    )
  );
  const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

  test('lists agents with their tools', async () => {
    const res = await request('/cogitator/agents');
    expect(await res.json()).toEqual({
      agents: [{ name: 'chat', description: 'Answers questions', tools: ['get_weather'] }],
    });
  });

  test('lists the tools of every agent with their JSON Schema', async () => {
    const body = (await (await request('/cogitator/tools')).json()) as {
      tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }>;
    };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('get_weather');
    expect(Object.keys(body.tools[0].parameters.properties)).toEqual(['city']);
  });

  test('runs an agent and keeps provider state out of the response', async () => {
    const res = await request(
      '/cogitator/agents/chat/run',
      json({ input: 'Weather?', threadId: 't-1', context: { lang: 'en' } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      output: 'hello world',
      structured: { mood: 'sunny' },
      threadId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { city: 'Paris' } }],
    });
    const options = lastRunOptions(run);
    expect(options.input).toBe('Weather?');
    expect(options.threadId).toBe('t-1');
    expect(options.context).toEqual({ lang: 'en' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.userId).toBeUndefined();
  });

  test('answers 404 for an unknown agent and for inherited object keys', async () => {
    for (const name of ['ghost', 'toString', '__proto__']) {
      const res = await request(`/cogitator/agents/${name}/run`, json({ input: 'hi' }));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('AGENT_NOT_FOUND');
    }
  });

  test('refuses an invalid body with every issue', async () => {
    const res = await request('/cogitator/agents/chat/run', json({ input: '', threadId: 5 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: Array<{ path: string[] }> };
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(body.issues.map((issue) => issue.path.join('.'))).toEqual([
      'body.input',
      'body.threadId',
    ]);
  });

  test('refuses malformed JSON', async () => {
    const res = await request('/cogitator/agents/chat/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('MALFORMED_JSON');
  });
});

describe('errors', () => {
  test('maps a CogitatorError to its status, code and Retry-After', async () => {
    const { cogitator } = fakeCogitator(async () => {
      throw new CogitatorError({
        message: 'Slow down',
        code: ErrorCode.LLM_RATE_LIMITED,
        retryAfter: 2500,
      });
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/chat/run', json({ input: 'hi' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({
      status: 429,
      message: 'Slow down',
      error: 'LLM_RATE_LIMITED',
    });
  });

  test('hides an unexpected error from the client and reports it', async () => {
    const reports: FailureReport[] = [];
    const { cogitator } = fakeCogitator(() => Promise.reject(new Error('db password leaked')));
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } }, reports);

    const res = await request('/cogitator/agents/chat/run', json({ input: 'hi' }));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('password');
    expect(JSON.parse(text)).toEqual({
      status: 500,
      message: 'Internal Server Error',
      error: 'INTERNAL_SERVER_ERROR',
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].source).toBe('unhandled');
  });
});

describe('auth', () => {
  const { cogitator, run } = fakeCogitator();
  const request = serveCogitator({
    cogitator,
    agents: { chat: chatAgent() },
    auth: (ctx) => {
      const token = ctx.req.headers.get('authorization');
      if (token === 'Bearer banned') throw new HttpError(403);
      return token === 'Bearer ada' ? { userId: 'ada', roles: ['user'] } : undefined;
    },
    authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}:`),
  });

  test('refuses a request without credentials before reading its body', async () => {
    const res = await request('/cogitator/agents/chat/run', {
      method: 'POST',
      body: '{ not even json',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('UNAUTHORIZED');
  });

  test('passes an HttpError from auth through', async () => {
    const res = await request('/cogitator/agents', { headers: { authorization: 'Bearer banned' } });
    expect(res.status).toBe(403);
  });

  test('runs as the authenticated user', async () => {
    const res = await request('/cogitator/agents/chat/run', {
      ...json({ input: 'hi', threadId: 'ada:1' }),
      headers: { authorization: 'Bearer ada', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(lastRunOptions(run).userId).toBe('ada');
  });

  test("refuses another user's thread", async () => {
    const before = run.mock.calls.length;
    const res = await request('/cogitator/agents/chat/run', {
      ...json({ input: 'hi', threadId: 'grace:1' }),
      headers: { authorization: 'Bearer ada', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('THREAD_FORBIDDEN');
    expect(run.mock.calls.length).toBe(before);
  });
});

describe('threads', () => {
  test('answers 503 without a memory adapter', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveCogitator({ cogitator });
    const res = await request('/cogitator/threads/t-1');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('MEMORY_NOT_CONFIGURED');
  });

  test('reads, appends to and deletes a thread', async () => {
    const memory = fakeMemory([
      { message: { role: 'user', content: 'hi' }, createdAt: new Date(1000) },
      { message: { role: 'assistant', content: 'hello' }, createdAt: new Date(2000) },
    ]);
    const { cogitator } = fakeCogitator(undefined, memory);
    const request = serveCogitator({ cogitator });

    const read = await request('/cogitator/threads/t-1');
    expect(await read.json()).toEqual({
      id: 't-1',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    });

    const added = await request(
      '/cogitator/threads/t-1/messages',
      json({ role: 'user', content: 'more', metadata: { source: 'api' } })
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ success: true });
    const entry = memory.addEntry.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(entry[0]).toMatchObject({
      threadId: 't-1',
      message: { role: 'user', content: 'more' },
      metadata: { source: 'api' },
    });
    expect(entry[0].tokenCount).toBeGreaterThan(0);

    const deleted = await request('/cogitator/threads/t-1', { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(memory.clearThread).toHaveBeenCalledWith('t-1');
  });

  test('refuses a message with an unknown role', async () => {
    const { cogitator } = fakeCogitator(undefined, fakeMemory());
    const request = serveCogitator({ cogitator });
    const res = await request(
      '/cogitator/threads/t-1/messages',
      json({ role: 'tool', content: 'x' })
    );
    expect(res.status).toBe(422);
  });
});

describe('agent stream', () => {
  test('streams text, tool calls and the finish event in order', async () => {
    const { cogitator } = fakeCogitator(async (_agent, options) => {
      options.onToken?.('Hel');
      options.onToolCall?.({ id: 'call-1', name: 'get_weather', arguments: { city: 'Paris' } });
      options.onToolResult?.({ callId: 'call-1', name: 'get_weather', result: 'Sunny' });
      options.onToken?.('lo');
      return runResult();
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const res = await request('/cogitator/agents/chat/stream', json({ input: 'hi' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const { events, done } = await readStream(res);
    expect(done).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(events[3]).toEqual({ type: 'tool-call-start', id: 'call-1', toolName: 'get_weather' });
    expect(events[4]).toEqual({
      type: 'tool-call-delta',
      id: 'call-1',
      argsTextDelta: '{"city":"Paris"}',
    });
    expect(events[6]).toMatchObject({ type: 'tool-result', toolCallId: 'call-1', result: 'Sunny' });
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  test('ends with an error event when the run fails', async () => {
    const { cogitator } = fakeCogitator(async (_agent, options) => {
      options.onToken?.('partial');
      throw new CogitatorError({ message: 'Model is down', code: ErrorCode.LLM_UNAVAILABLE });
    });
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    const { events, done } = await readStream(
      await request('/cogitator/agents/chat/stream', json({ input: 'hi' }))
    );

    expect(done).toBe(false);
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: 'text-end' }),
      { type: 'error', message: 'Model is down', code: 'LLM_UNAVAILABLE' },
    ]);
  });

  test('reports an unexpected failure after telling the client', async () => {
    const reports: FailureReport[] = [];
    const { cogitator } = fakeCogitator(() => Promise.reject(new Error('boom')));
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } }, reports);

    const { events } = await readStream(
      await request('/cogitator/agents/chat/stream', json({ input: 'hi' }))
    );

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(reports.map((report) => report.source)).toEqual(['stream']);
  });

  test('answers 404 before opening a stream', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });
    const res = await request('/cogitator/agents/ghost/stream', json({ input: 'hi' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('aborts the run when the client goes away', async () => {
    const started = deferred<AbortSignal>();
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal;
          if (!signal) return;
          options.onToken?.('first');
          started.resolve(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });
    const client = new AbortController();

    const res = await request('/cogitator/agents/chat/stream', {
      ...json({ input: 'hi' }),
      signal: client.signal,
    });
    const reader = res.body?.getReader();
    await reader?.read();
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);

    client.abort();
    await reader?.cancel().catch(() => undefined);

    for (let i = 0; i < 50 && !signal.aborted; i++) await Bun.sleep(10);
    expect(signal.aborted).toBe(true);
  });

  test('ends an open stream when the server drains', async () => {
    const draining = new AbortController();
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('first');
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const request = serveCogitator({
      cogitator,
      agents: { chat: chatAgent() },
      until: () => draining.signal,
    });

    const res = await request('/cogitator/agents/chat/stream', json({ input: 'hi' }));
    setTimeout(() => draining.abort(), 50);
    const { events, done } = await readStream(res);

    expect(done).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['start', 'text-start', 'text-delta']);
  });
});
