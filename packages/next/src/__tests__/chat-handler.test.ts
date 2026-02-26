import { describe, it, expect, vi } from 'vitest';
import { createChatHandler } from '../handlers/chat.js';
import type { Cogitator, Agent } from '@cogitator-ai/core';

function mockCogitator(overrides: Record<string, unknown> = {}) {
  return {
    run: vi.fn().mockImplementation(async (_agent, options) => {
      if (options.onToken) {
        await options.onToken('Hello');
        await options.onToken(' world');
      }
      return {
        output: 'Hello world',
        threadId: 'thread_1',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        toolCalls: [],
        trace: { traceId: 'trace_1', spans: [] },
        ...overrides,
      };
    }),
  } as unknown as Cogitator;
}

function mockAgent() {
  return { id: 'agent_1' } as unknown as Agent;
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function parseSSEEvents(raw: string): unknown[] {
  const events: unknown[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
      try {
        events.push(JSON.parse(trimmed.slice(6)));
      } catch {}
    }
  }
  return events;
}

describe('createChatHandler', () => {
  it('returns SSE stream response', async () => {
    const handler = createChatHandler(mockCogitator(), mockAgent());
    const res = await handler(jsonRequest({ messages: [{ role: 'user', content: 'Hi' }] }));

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');

    const raw = await readStream(res);
    expect(raw).toContain('[DONE]');

    const events = parseSSEEvents(raw);
    const types = events.map((e) => (e as { type: string }).type);

    expect(types).toContain('start');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');
  });

  it('streams token deltas', async () => {
    const handler = createChatHandler(mockCogitator(), mockAgent());
    const res = await handler(jsonRequest({ messages: [{ role: 'user', content: 'Hi' }] }));

    const raw = await readStream(res);
    const events = parseSSEEvents(raw);
    const deltas = events
      .filter((e) => (e as { type: string }).type === 'text-delta')
      .map((e) => (e as { delta: string }).delta);

    expect(deltas).toContain('Hello');
    expect(deltas).toContain(' world');
  });

  it('returns 400 for invalid JSON', async () => {
    const handler = createChatHandler(mockCogitator(), mockAgent());
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      body: 'not json',
    });

    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 on beforeRun error', async () => {
    const handler = createChatHandler(mockCogitator(), mockAgent(), {
      beforeRun: async () => {
        throw new Error('Unauthorized');
      },
    });

    const res = await handler(jsonRequest({ messages: [{ role: 'user', content: 'Hi' }] }));
    expect(res.status).toBe(401);
  });

  it('uses custom parseInput', async () => {
    const cog = mockCogitator();
    const handler = createChatHandler(cog, mockAgent(), {
      parseInput: async () => ({
        messages: [{ id: 'custom', role: 'user' as const, content: 'custom msg' }],
      }),
    });

    const res = await handler(jsonRequest({}));
    await readStream(res);

    expect(cog.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input: 'custom msg' })
    );
  });

  it('calls afterRun', async () => {
    const afterRun = vi.fn();
    const handler = createChatHandler(mockCogitator(), mockAgent(), { afterRun });

    const res = await handler(jsonRequest({ messages: [{ role: 'user', content: 'Hi' }] }));
    await readStream(res);

    await vi.waitFor(() => expect(afterRun).toHaveBeenCalledOnce());
  });

  it('handles runtime error in stream', async () => {
    const cog = {
      run: vi.fn().mockRejectedValue(new Error('LLM crashed')),
    } as unknown as Cogitator;

    const handler = createChatHandler(cog, mockAgent());
    const res = await handler(jsonRequest({ messages: [{ role: 'user', content: 'Hi' }] }));

    const raw = await readStream(res);
    const events = parseSSEEvents(raw);
    const errorEvents = events.filter((e) => (e as { type: string }).type === 'error');

    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { message: string }).message).toBe('LLM crashed');
  });

  it('extracts last user message as input', async () => {
    const cog = mockCogitator();
    const handler = createChatHandler(cog, mockAgent());

    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'second' },
    ];

    const res = await handler(jsonRequest({ messages }));
    await readStream(res);

    expect(cog.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input: 'second' })
    );
  });

  it('defaults to empty string when no user messages', async () => {
    const cog = mockCogitator();
    const handler = createChatHandler(cog, mockAgent());

    const res = await handler(jsonRequest({ messages: [] }));
    await readStream(res);

    expect(cog.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ input: '' }));
  });

  it('handles tool calls in stream', async () => {
    const cog = {
      run: vi.fn().mockImplementation(async (_agent, options) => {
        await options.onToken?.('thinking...');
        await options.onToolCall?.({
          id: 'tc_1',
          name: 'search',
          arguments: { q: 'test' },
        });
        await options.onToolResult?.({
          callId: 'tc_1',
          result: { found: true },
        });
        await options.onToken?.('done');

        return {
          output: 'thinking...done',
          threadId: 'thread_1',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          toolCalls: [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }],
          trace: { traceId: 'trace_1', spans: [] },
        };
      }),
    } as unknown as Cogitator;

    const handler = createChatHandler(cog, mockAgent());
    const res = await handler(
      jsonRequest({ messages: [{ role: 'user', content: 'search for test' }] })
    );

    const raw = await readStream(res);
    const events = parseSSEEvents(raw);
    const types = events.map((e) => (e as { type: string }).type);

    expect(types).toContain('tool-call-start');
    expect(types).toContain('tool-call-delta');
    expect(types).toContain('tool-call-end');
    expect(types).toContain('tool-result');
  });

  it('includes usage in finish event', async () => {
    const handler = createChatHandler(mockCogitator(), mockAgent());
    const res = await handler(jsonRequest({ messages: [{ role: 'user', content: 'Hi' }] }));

    const raw = await readStream(res);
    const events = parseSSEEvents(raw);
    const finish = events.find((e) => (e as { type: string }).type === 'finish') as
      | { usage: { inputTokens: number } }
      | undefined;

    expect(finish).toBeDefined();
    expect(finish!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });
});
