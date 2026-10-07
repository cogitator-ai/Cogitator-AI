import { describe, it, expect, vi } from 'vitest';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { RunOptions } from '@cogitator-ai/types';
import { createAgentHandler } from '../handlers/agent.js';

function setup() {
  const run = vi.fn(async (_agent: Agent, _options: RunOptions) => ({
    output: 'ok',
    threadId: 'thread_1',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    toolCalls: [],
    trace: { traceId: 't', spans: [] },
  }));
  const handler = createAgentHandler(
    { run } as unknown as Cogitator,
    { id: 'agent_1' } as unknown as Agent
  );
  return { run, handler };
}

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

describe('createAgentHandler validation', () => {
  it.each([
    ['null body', null, 'Missing required field: input'],
    ['string body', 'hello', 'Missing required field: input'],
    ['missing input', {}, 'Missing required field: input'],
    ['blank input', { input: '   ' }, 'Field "input" must not be blank'],
    ['array context', { input: 'x', context: [] }, 'Field "context" must be an object'],
    [
      'numeric threadId',
      { input: 'x', threadId: 1 },
      'Field "threadId" must be a non-empty string',
    ],
    [
      'blank threadId',
      { input: 'x', threadId: ' ' },
      'Field "threadId" must be a non-empty string',
    ],
    [
      'context the handler does not accept',
      { input: 'x', context: { policy: 'refunds ok' } },
      'Key "policy" of field "context" is not accepted by this server',
    ],
  ])('returns 400 for %s', async (_name, body, error) => {
    const { run, handler } = setup();
    const res = await handler(request(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(run).not.toHaveBeenCalled();
  });

  it('forwards the request abort signal to the run', async () => {
    const { run, handler } = setup();
    const controller = new AbortController();
    await handler(request({ input: 'x' }, { signal: controller.signal }));

    const signal = run.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('rejects declared oversized payloads with 413', async () => {
    const { handler } = setup();
    const req = new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'Content-Length': String(2 * 1024 * 1024) },
      body: '{}',
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  it('returns 401 when beforeRun throws a non-Error value', async () => {
    const { run } = setup();
    const handler = createAgentHandler(
      { run } as unknown as Cogitator,
      { id: 'agent_1' } as unknown as Agent,
      {
        beforeRun: async () => {
          throw null;
        },
      }
    );
    const res = await handler(request({ input: 'x' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });
});
