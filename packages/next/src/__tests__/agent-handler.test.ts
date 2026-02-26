import { describe, it, expect, vi } from 'vitest';
import { createAgentHandler } from '../handlers/agent.js';
import type { Cogitator, Agent } from '@cogitator-ai/core';

function mockCogitator(result: Record<string, unknown> = {}) {
  return {
    run: vi.fn().mockResolvedValue({
      output: 'Hello!',
      threadId: 'thread_1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [],
      trace: { traceId: 'trace_1', spans: [] },
      ...result,
    }),
  } as unknown as Cogitator;
}

function mockAgent() {
  return { id: 'agent_1' } as unknown as Agent;
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createAgentHandler', () => {
  it('handles valid request', async () => {
    const cog = mockCogitator();
    const handler = createAgentHandler(cog, mockAgent());

    const res = await handler(jsonRequest({ input: 'hi' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.output).toBe('Hello!');
    expect(data.threadId).toBe('thread_1');
    expect(data.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it('returns 400 for invalid JSON', async () => {
    const handler = createAgentHandler(mockCogitator(), mockAgent());
    const req = new Request('http://localhost/api/agent', {
      method: 'POST',
      body: 'not json',
    });

    const res = await handler(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe('Invalid JSON');
  });

  it('uses custom parseInput', async () => {
    const cog = mockCogitator();
    const handler = createAgentHandler(cog, mockAgent(), {
      parseInput: async () => ({ input: 'custom input' }),
    });

    const res = await handler(jsonRequest({ input: 'original' }));
    expect(res.status).toBe(200);
    expect(cog.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input: 'custom input' })
    );
  });

  it('returns 400 on parseInput error', async () => {
    const handler = createAgentHandler(mockCogitator(), mockAgent(), {
      parseInput: async () => {
        throw new Error('bad input');
      },
    });

    const res = await handler(jsonRequest({ input: 'hi' }));
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe('bad input');
  });

  it('calls beforeRun and merges context', async () => {
    const cog = mockCogitator();
    const handler = createAgentHandler(cog, mockAgent(), {
      beforeRun: async () => ({ userId: '123' }),
    });

    await handler(jsonRequest({ input: 'hi' }));
    expect(cog.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: '123', input: 'hi' })
    );
  });

  it('returns 401 on beforeRun error', async () => {
    const handler = createAgentHandler(mockCogitator(), mockAgent(), {
      beforeRun: async () => {
        throw new Error('Unauthorized');
      },
    });

    const res = await handler(jsonRequest({ input: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('calls afterRun', async () => {
    const afterRun = vi.fn();
    const handler = createAgentHandler(mockCogitator(), mockAgent(), { afterRun });

    await handler(jsonRequest({ input: 'hi' }));
    expect(afterRun).toHaveBeenCalledOnce();
  });

  it('returns 500 on runtime error', async () => {
    const cog = {
      run: vi.fn().mockRejectedValue(new Error('LLM failed')),
    } as unknown as Cogitator;

    const handler = createAgentHandler(cog, mockAgent());
    const res = await handler(jsonRequest({ input: 'hi' }));

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('LLM failed');
  });

  it('defaults to empty string when input is not a string', async () => {
    const cog = mockCogitator();
    const handler = createAgentHandler(cog, mockAgent());

    await handler(jsonRequest({ input: 123 }));
    expect(cog.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ input: '' }));
  });
});
