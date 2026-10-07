import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { CogitatorError, ErrorCode, type RunOptions } from '@cogitator-ai/types';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

type Cogitator = CogitatorServerConfig['cogitator'];
type Agent = NonNullable<CogitatorServerConfig['agents']>[string];
type RunImpl = (options: RunOptions) => Promise<unknown>;

function runResult(output = 'done') {
  return {
    output,
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    toolCalls: [],
    trace: { traceId: 't', spans: [] },
  };
}

const agent = {
  name: 'bot',
  config: { instructions: 'secret system prompt', tools: [] },
} as unknown as Agent;

let server: Server | undefined;

async function start(
  impl: RunImpl,
  overrides: Partial<CogitatorServerConfig> = {},
  memory: unknown = null
) {
  const run = vi.fn((_agent: Agent, options: RunOptions) => impl(options));
  const app = express();
  const srv = new CogitatorServer({
    app,
    cogitator: {
      run,
      memory,
      getMemory: async () => memory,
    } as unknown as Cogitator,
    agents: { bot: agent },
    ...overrides,
    config: { basePath: '/api', enableSwagger: false, ...overrides.config },
  });
  await srv.init();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { run, base: `http://127.0.0.1:${port}/api` };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

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

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('agent streaming', () => {
  it('delivers tokens produced after the request body was consumed', async () => {
    const { base } = await start(async (options) => {
      await tick();
      options.onToken?.('Hello');
      await tick();
      options.onToken?.(' world');
      return runResult('Hello world');
    });

    const raw = await (await post(`${base}/agents/bot/stream`, { input: 'hi' })).text();
    const events = parseEvents(raw);

    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.delta)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(events.at(-1)?.type).toBe('finish');
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('enables streaming and correlates tool call ids with tool results', async () => {
    const { base, run } = await start(async (options) => {
      options.onToken?.('Let me check.');
      options.onToolCall?.({ id: 'call_1', name: 'search', arguments: { q: 'x' } });
      await tick();
      options.onToolResult?.({ callId: 'call_1', name: 'search', result: { hits: 1 } });
      options.onToken?.('Found it.');
      return runResult('Let me check.Found it.');
    });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );

    expect(run.mock.calls[0][1].stream).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    const callStart = events.find((e) => e.type === 'tool-call-start');
    const delta = events.find((e) => e.type === 'tool-call-delta');
    const result = events.find((e) => e.type === 'tool-result');
    expect(callStart?.id).toBe('call_1');
    expect(delta).toMatchObject({ id: 'call_1', argsTextDelta: '{"q":"x"}' });
    expect(result?.toolCallId).toBe('call_1');
  });

  it('streams reasoning as its own part closed before text starts', async () => {
    const { base } = await start(async (options) => {
      options.onReasoning?.('a');
      options.onReasoning?.('b');
      options.onToken?.('x');
      return runResult('x');
    });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(events.filter((e) => e.type === 'reasoning-delta').map((e) => e.delta)).toEqual([
      'a',
      'b',
    ]);
    expect(events.find((e) => e.type === 'text-delta')?.delta).toBe('x');
    const reasoningIds = new Set(
      events.filter((e) => e.type.startsWith('reasoning-')).map((e) => e.id)
    );
    expect(reasoningIds.size).toBe(1);
    expect([...reasoningIds][0]).toMatch(/^rsn_/);
  });

  it('closes text before reasoning and reasoning before a tool call', async () => {
    const { base } = await start(async (options) => {
      options.onToken?.('x');
      options.onReasoning?.('thinking');
      options.onToolCall?.({ id: 'call_1', name: 'search', arguments: { q: 'x' } });
      return runResult('x');
    });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'finish',
    ]);
  });

  it('closes an open reasoning part before the error event', async () => {
    const { base } = await start(async (options) => {
      options.onReasoning?.('partial');
      throw new Error('provider down');
    });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'error',
    ]);
  });

  it('sends the final output when the backend did not stream tokens', async () => {
    const { base } = await start(async () => runResult('complete answer'));
    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );
    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.delta)).toEqual([
      'complete answer',
    ]);
  });

  it('maps CogitatorError codes in the stream and closes the text block', async () => {
    const { base } = await start(async (options) => {
      options.onToken?.('partial');
      throw new CogitatorError({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED });
    });
    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'error',
    ]);
    expect(events.at(-1)).toMatchObject({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED });
  });

  it('aborts the run when the client disconnects', async () => {
    let signal: AbortSignal | undefined;
    const { base } = await start(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          options.onToken?.('tick');
        })
    );

    const url = new URL(`${base}/agents/bot/stream`);
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    req.on('response', (res) => {
      res.once('data', () => req.destroy());
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ input: 'hi' }));

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
});

describe('agent run', () => {
  it('maps CogitatorError codes to their HTTP status', async () => {
    const { base } = await start(async () => {
      throw new CogitatorError({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED });
    });
    const res = await post(`${base}/agents/bot/run`, { input: 'q' });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe(ErrorCode.LLM_RATE_LIMITED);
  });

  it('passes the authenticated user id and an abort signal to the run', async () => {
    const { base, run } = await start(async () => runResult(), {
      config: { auth: () => ({ userId: 'user-7' }) },
    });
    await post(`${base}/agents/bot/run`, { input: 'q' });

    const options = run.mock.calls[0][1];
    expect(options.userId).toBe('user-7');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['numeric input', { input: 42 }, 'Field "input" must be a string'],
    ['empty input', { input: '' }, 'Field "input" must not be blank'],
    ['blank input', { input: '  ' }, 'Field "input" must not be blank'],
    ['array context', { input: 'q', context: [] }, 'Field "context" must be an object'],
    [
      'numeric threadId',
      { input: 'q', threadId: 1 },
      'Field "threadId" must be a non-empty string',
    ],
    ['empty threadId', { input: 'q', threadId: '' }, 'Field "threadId" must be a non-empty string'],
  ])('rejects %s with 400', async (_name, body, message) => {
    const { base, run } = await start(async () => runResult());
    const res = await post(`${base}/agents/bot/run`, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns 400 instead of 500 for malformed JSON', async () => {
    const { base } = await start(async () => runResult());
    const res = await post(`${base}/agents/bot/run`, '{"input": ');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({
      message: 'Invalid JSON body',
      code: 'INVALID_INPUT',
    });
  });

  it('does not expose agent instructions in the agent list', async () => {
    const { base } = await start(async () => runResult());
    const body = await (await fetch(`${base}/agents`)).json();
    expect(JSON.stringify(body)).not.toContain('secret system prompt');
  });
});

describe('workflow routes', () => {
  const failing = new WorkflowBuilder('failing')
    .addNode('boom', async () => {
      throw new Error('node exploded');
    })
    .build();
  const ok = new WorkflowBuilder<{ value: number }>('ok')
    .initialState({ value: 1 })
    .addNode('inc', async (ctx) => ({ state: { value: ctx.state.value + 1 } }))
    .build();

  const refused = new WorkflowBuilder('refused')
    .addNode('check', async () => {
      throw new CogitatorError({ message: 'quota reached', code: ErrorCode.VALIDATION_ERROR });
    })
    .build();

  const workflows = { failing, ok, refused } as unknown as CogitatorServerConfig['workflows'];

  it('returns 500 when the workflow fails, without the text of internal errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { base } = await start(async () => runResult(), { workflows });
    const res = await post(`${base}/workflows/failing/run`, {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toEqual({
      message: 'Workflow failed: Internal server error',
      code: 'WORKFLOW_FAILED',
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps the message of a CogitatorError a workflow fails with', async () => {
    const { base } = await start(async () => runResult(), { workflows });
    const res = await post(`${base}/workflows/refused/run`, {});
    expect((await res.json()).error.message).toBe('Workflow failed: quota reached');
  });

  it('streams an error event instead of workflow_completed when the workflow fails', async () => {
    const { base } = await start(async () => runResult(), { workflows });
    const events = parseEvents(await (await post(`${base}/workflows/failing/stream`, {})).text());
    const types = events.map((e) =>
      e.type === 'workflow' ? `workflow:${String(e.event)}` : e.type
    );
    expect(types).toContain('workflow:node_error');
    expect(types).not.toContain('workflow:workflow_completed');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'WORKFLOW_FAILED' });
  });

  it('runs a workflow and serializes node results', async () => {
    const { base } = await start(async () => runResult(), { workflows });
    const res = await post(`${base}/workflows/ok/run`, { input: { value: 5 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toEqual({ value: 6 });
    expect(Object.keys(body.nodeResults)).toEqual(['inc']);
  });

  it.each([
    ['string input', { input: 'x' }, 'Field "input" must be an object'],
    [
      'negative concurrency',
      { options: { maxConcurrency: -1 } },
      'Field "options.maxConcurrency" must be a positive integer',
    ],
    [
      'a checkpoint the server cannot keep',
      { options: { checkpoint: true } },
      'Field "options.checkpoint" is not supported: the server keeps no checkpoint store',
    ],
  ])('rejects %s with 400', async (_name, body, message) => {
    const { base } = await start(async () => runResult(), { workflows });
    const res = await post(`${base}/workflows/ok/run`, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(message);
  });
});

describe('swarm routes', () => {
  it('rejects a non-positive timeout', async () => {
    const swarms = {
      team: { name: 'team', strategy: 'round-robin', agents: [agent] },
    } as unknown as CogitatorServerConfig['swarms'];
    const { base } = await start(async () => runResult(), { swarms });
    const res = await post(`${base}/swarms/team/run`, { input: 'go', timeout: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Field "timeout" must be a positive number');
  });
});

describe('thread routes', () => {
  function memoryStub() {
    return {
      getThread: vi.fn(async () => ({ success: true, data: null })),
      createThread: vi.fn(
        async (agentId: string, metadata: Record<string, unknown>, id: string) => ({
          success: true,
          data: { id, agentId, metadata, createdAt: new Date(), updatedAt: new Date() },
        })
      ),
      addEntry: vi.fn(async () => ({ success: true, data: {} })),
      getEntries: vi.fn(async () => ({ success: true, data: [] })),
      clearThread: vi.fn(async () => ({ success: true, data: undefined })),
    };
  }

  it('rejects unknown roles and non-string content', async () => {
    const memory = memoryStub();
    const { base } = await start(async () => runResult(), {}, memory);

    const badRole = await post(`${base}/threads/t1/messages`, { role: 'tool', content: 'x' });
    const badContent = await post(`${base}/threads/t1/messages`, {
      role: 'user',
      content: { a: 1 },
    });

    expect(badRole.status).toBe(400);
    expect(badContent.status).toBe(400);
    expect(memory.addEntry).not.toHaveBeenCalled();
  });

  it('stores message metadata on the memory entry', async () => {
    const memory = memoryStub();
    const { base } = await start(async () => runResult(), {}, memory);

    const res = await post(`${base}/threads/t1/messages`, {
      role: 'user',
      content: 'hello',
      metadata: { source: 'import' },
    });

    expect(res.status).toBe(201);
    expect(memory.addEntry).toHaveBeenCalledWith({
      threadId: 't1',
      message: { role: 'user', content: 'hello' },
      tokenCount: 0,
      metadata: { source: 'import' },
    });
  });

  it('logs memory failures and answers the client with a generic 500', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = { success: false, error: 'connect ECONNREFUSED 10.0.0.5:5432' };
    const memory = {
      ...memoryStub(),
      getEntries: vi.fn(async () => failure),
      addEntry: vi.fn(async () => failure),
      clearThread: vi.fn(async () => failure),
    };
    const { base } = await start(async () => runResult(), {}, memory);

    const responses = [
      await fetch(`${base}/threads/t1`),
      await post(`${base}/threads/t1/messages`, { role: 'user', content: 'hi' }),
      await fetch(`${base}/threads/t1`, { method: 'DELETE' }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
      });
    }
    expect(consoleError).toHaveBeenCalledTimes(3);
    expect(String(consoleError.mock.calls[0][1])).toContain('ECONNREFUSED 10.0.0.5:5432');
    consoleError.mockRestore();
  });
});

describe('swagger', () => {
  async function spec(config: Partial<NonNullable<CogitatorServerConfig['config']>>) {
    const { base } = await start(async () => ({}), { config: { enableSwagger: true, ...config } });
    return (await fetch(`${base}/openapi.json`)).json();
  }

  it('points servers at the base path', async () => {
    expect((await spec({})).servers).toEqual([{ url: '/api' }]);
  });

  it('keeps servers set in the swagger config', async () => {
    const servers = [{ url: 'https://api.example.com/api' }];
    expect((await spec({ swagger: { servers } })).servers).toEqual(servers);
  });

  it('declares bearer auth only when the server checks credentials', async () => {
    const open = await spec({});
    expect(open.security).toBeUndefined();
    expect(open.components.securitySchemes).toBeUndefined();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const guarded = await spec({ auth: () => ({ userId: 'u1' }) });
    expect(guarded.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
    });
    expect(guarded.security).toEqual([{ bearerAuth: [] }, {}]);
  });

  it('escapes agent names embedded in the Swagger page', async () => {
    const { base } = await start(async () => ({}), {
      agents: { '</script><script>alert(1)</script>': agent },
      config: { enableSwagger: true },
    });
    const html = await (await fetch(`${base}/docs`)).text();
    expect(html).not.toContain('<script>alert(1)');
  });
});
