import { describe, it, expect, vi } from 'vitest';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { RunOptions, ToolCall, ToolResult } from '@cogitator-ai/types';
import { createChatHandler } from '../handlers/chat.js';

type RunImpl = (options: RunOptions) => Promise<unknown> | unknown;

function runResult(overrides: Record<string, unknown> = {}) {
  return {
    output: '',
    threadId: 'thread_srv',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    toolCalls: [],
    trace: { traceId: 't', spans: [] },
    ...overrides,
  };
}

function cogitatorWith(impl: RunImpl) {
  const run = vi.fn(async (_agent: Agent, options: RunOptions) => impl(options));
  return { cogitator: { run } as unknown as Cogitator, run };
}

const agent = { id: 'agent_1' } as unknown as Agent;

function chatRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

const userBody = { messages: [{ role: 'user', content: 'Hi' }] };

interface Event {
  type: string;
  [key: string]: unknown;
}

function parseEvents(raw: string): Event[] {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Event);
}

describe('createChatHandler streaming', () => {
  it('enables streaming and forwards an abort signal to the run', async () => {
    const { cogitator, run } = cogitatorWith(() => runResult({ output: 'ok' }));
    const res = await createChatHandler(cogitator, agent)(chatRequest(userBody));
    await res.text();

    const options = run.mock.calls[0][1];
    expect(options.stream).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(typeof options.onToken).toBe('function');
  });

  it('emits the final output when the backend produced no tokens', async () => {
    const { cogitator } = cogitatorWith(() => runResult({ output: 'Full answer' }));
    const res = await createChatHandler(cogitator, agent)(chatRequest(userBody));
    const events = parseEvents(await res.text());

    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => e.delta);
    expect(deltas).toEqual(['Full answer']);
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
  });

  it('does not duplicate output that was already streamed as tokens', async () => {
    const { cogitator } = cogitatorWith((options) => {
      options.onToken?.('Hel');
      options.onToken?.('lo');
      return runResult({ output: 'Hello' });
    });
    const res = await createChatHandler(cogitator, agent)(chatRequest(userBody));
    const events = parseEvents(await res.text());

    const deltas = events.filter((e) => e.type === 'text-delta').map((e) => e.delta);
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('keeps text blocks balanced and ordered with synchronous multi-tool callbacks', async () => {
    const calls: ToolCall[] = [
      { id: 'tc_1', name: 'a', arguments: { x: 1 } },
      { id: 'tc_2', name: 'b', arguments: { y: 2 } },
    ];
    const results: ToolResult[] = [
      { callId: 'tc_1', name: 'a', result: 1 },
      { callId: 'tc_2', name: 'b', result: 2 },
    ];
    const { cogitator } = cogitatorWith((options) => {
      options.onToken?.('before');
      for (const call of calls) options.onToolCall?.(call);
      for (const result of results) options.onToolResult?.(result);
      options.onToken?.('after');
      return runResult({ output: 'beforeafter' });
    });

    const res = await createChatHandler(cogitator, agent)(chatRequest(userBody));
    const events = parseEvents(await res.text());

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);

    const starts = events.filter((e) => e.type === 'text-start').map((e) => e.id);
    const ends = events.filter((e) => e.type === 'text-end').map((e) => e.id);
    expect(ends).toEqual(starts);
    expect(new Set(starts).size).toBe(2);
  });

  it('includes the server thread id in the finish event', async () => {
    const { cogitator } = cogitatorWith(() => runResult({ output: 'x', threadId: 'thread_42' }));
    const res = await createChatHandler(cogitator, agent)(chatRequest(userBody));
    const finish = parseEvents(await res.text()).find((e) => e.type === 'finish');

    expect(finish?.threadId).toBe('thread_42');
  });

  it('passes request metadata to the run as context', async () => {
    const { cogitator, run } = cogitatorWith(() => runResult({ output: 'x' }));
    const res = await createChatHandler(
      cogitator,
      agent
    )(chatRequest({ ...userBody, metadata: { tenant: 'acme' } }));
    await res.text();

    expect(run.mock.calls[0][1].context).toEqual({ tenant: 'acme' });
  });

  it('reports afterRun failures as an error event instead of finishing', async () => {
    const { cogitator } = cogitatorWith(() => runResult({ output: 'x' }));
    const handler = createChatHandler(cogitator, agent, {
      afterRun: async () => {
        throw new Error('persist failed');
      },
    });
    const raw = await (await handler(chatRequest(userBody))).text();
    const events = parseEvents(raw);

    expect(events.map((e) => e.type)).not.toContain('finish');
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'persist failed' });
    expect(raw).not.toContain('[DONE]');
  });

  it('closes the open text block before emitting a runtime error', async () => {
    const { cogitator } = cogitatorWith((options) => {
      options.onToken?.('partial');
      throw new Error('boom');
    });
    const events = parseEvents(
      await (await createChatHandler(cogitator, agent)(chatRequest(userBody))).text()
    );

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'error',
    ]);
  });

  it('aborts the run when the client disconnects', async () => {
    let runSignal: AbortSignal | undefined;
    const { cogitator } = cogitatorWith(
      (options) =>
        new Promise((_resolve, reject) => {
          runSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('Run aborted')));
          options.onToken?.('tick');
        })
    );

    const res = await createChatHandler(cogitator, agent)(chatRequest(userBody));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(runSignal?.aborted).toBe(true));
  });

  it('aborts the run when the request signal aborts', async () => {
    const controller = new AbortController();
    let runSignal: AbortSignal | undefined;
    const { cogitator } = cogitatorWith(
      (options) =>
        new Promise((_resolve, reject) => {
          runSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('Run aborted')));
        })
    );

    const res = await createChatHandler(
      cogitator,
      agent
    )(chatRequest(userBody, { signal: controller.signal }));
    const text = res.text();
    await vi.waitFor(() => expect(runSignal).toBeDefined());
    controller.abort();

    await vi.waitFor(() => expect(runSignal?.aborted).toBe(true));
    await text.catch(() => '');
  });

  it('does not let beforeRun override the streaming callbacks', async () => {
    const { cogitator, run } = cogitatorWith(() => runResult({ output: 'x' }));
    const handler = createChatHandler(cogitator, agent, {
      beforeRun: async () => ({ stream: false, userId: 'u1', threadId: 'scoped' }),
    });
    await (await handler(chatRequest(userBody))).text();

    const options = run.mock.calls[0][1];
    expect(options.stream).toBe(true);
    expect(options.userId).toBe('u1');
    expect(options.threadId).toBe('scoped');
  });
});

describe('createChatHandler input validation', () => {
  const { cogitator, run } = cogitatorWith(() => runResult({ output: 'x' }));
  const handler = createChatHandler(cogitator, agent);

  it.each([
    ['null body', null, 'Request body must be a JSON object'],
    ['array body', [], 'Request body must be a JSON object'],
    ['missing messages', {}, 'messages must be an array'],
    ['non-string threadId', { ...userBody, threadId: 5 }, 'threadId must be a string'],
    ['non-object metadata', { ...userBody, metadata: 'x' }, 'metadata must be an object'],
  ])('returns 400 for %s', async (_name, body, error) => {
    const res = await handler(chatRequest(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
  });

  it('ignores messages with unknown roles or non-string content', async () => {
    run.mockClear();
    const res = await handler(
      chatRequest({
        messages: [
          { role: 'user', content: 'valid' },
          { role: 'user', content: { text: 'object' } },
          { role: 'tool', content: 'not a chat role' },
        ],
      })
    );
    await res.text();

    expect(run.mock.calls[0][1].input).toBe('valid');
  });

  it('rejects a chunked body larger than the limit with 413', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(chunk);
      },
    });
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);

    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  it('returns the status carried by a beforeRun error', async () => {
    const forbidden = createChatHandler(cogitator, agent, {
      beforeRun: async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      },
    });
    const res = await forbidden(chatRequest(userBody));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('does not advertise the AI SDK UI message stream header', async () => {
    const res = await handler(chatRequest(userBody));
    await res.text();
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBeNull();
  });
});
