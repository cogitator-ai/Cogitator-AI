import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import Koa from 'koa';
import Router from '@koa/router';
import request from 'supertest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { cogitatorApp } from '../app.js';
import { createAuthMiddleware, createErrorHandler } from '../middleware/index.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';

const workflowExecute = vi.fn();
const swarmRun = vi.fn();
const swarmAbort = vi.fn();
const swarmClose = vi.fn(async () => undefined);

vi.mock('@cogitator-ai/workflows', () => ({
  WorkflowExecutor: class {
    execute = workflowExecute;
  },
}));

vi.mock('@cogitator-ai/swarms', () => ({
  Swarm: class {
    id = 'swarm_1';
    name = 'team';
    strategyType = 'round-robin';
    run = swarmRun;
    abort = swarmAbort;
    close = swarmClose;
    getResourceUsage = () => ({
      totalTokens: 7,
      totalCost: 0.5,
      elapsedTime: 10,
      agentUsage: new Map([['a1', { tokens: 7, cost: 0.5, runs: 1, duration: 10 }]]),
    });
  },
}));

function runResult() {
  return {
    output: 'done',
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    toolCalls: [],
    trace: { traceId: 'trace-1', spans: [] },
  };
}

function workflowResult(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf_1',
    workflowName: 'pipeline',
    state: { value: 1 },
    nodeResults: new Map([['start', { output: 'ok', duration: 3 }]]),
    duration: 4,
    ...overrides,
  };
}

function buildApp(overrides: Partial<CogitatorAppOptions> = {}, runtime?: Record<string, unknown>) {
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({
    cogitator: (runtime ?? {
      run: vi.fn().mockResolvedValue(runResult()),
    }) as unknown as CogitatorAppOptions['cogitator'],
    agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    workflows: { pipeline: { entryPoint: 'start', nodes: new Map() } as never },
    swarms: { team: { strategy: 'round-robin' } as never },
    ...overrides,
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
}

function postJson(app: Koa<CogitatorState>, path: string, body: unknown) {
  return request(app.callback())
    .post(path)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  workflowExecute.mockResolvedValue(workflowResult());
  swarmRun.mockResolvedValue({ output: 'swarm-out', agentResults: new Map() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth middleware', () => {
  it('does not mask downstream route errors as 401', async () => {
    const app = new Koa();
    app.use(createErrorHandler());
    app.use(createAuthMiddleware(() => ({ userId: 'u1' })));
    app.use(() => {
      throw new Error('route exploded');
    });

    const res = await request(app.callback()).get('/');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('still answers 401 when the auth function throws', async () => {
    const app = new Koa();
    app.use(createErrorHandler());
    app.use(
      createAuthMiddleware(() => {
        throw new Error('bad token');
      })
    );
    app.use((ctx) => {
      ctx.body = 'secret';
    });

    const res = await request(app.callback()).get('/');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('prototype-chain names', () => {
  it.each([
    ['/agents/constructor/run'],
    ['/agents/toString/stream'],
    ['/workflows/hasOwnProperty/run'],
    ['/swarms/constructor/run'],
  ])('POST %s returns 404', async (path) => {
    const res = await postJson(buildApp(), path, { input: 'hi' });
    expect(res.status).toBe(404);
  });

  it('GET /swarms/constructor/blackboard returns 404', async () => {
    const res = await request(buildApp().callback()).get('/swarms/constructor/blackboard');
    expect(res.status).toBe(404);
  });
});

describe('tools route', () => {
  it('serializes tool parameters through toJSON()', async () => {
    const tool = {
      name: 'search',
      description: 'Search',
      parameters: { _def: 'zod internals' },
      toJSON: () => ({
        name: 'search',
        description: 'Search',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      }),
    };
    const app = buildApp({ agents: { bot: { config: { tools: [tool] } } as never } });
    const res = await request(app.callback()).get('/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools[0].parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
  });
});

describe('request validation', () => {
  it.each([
    [{ input: 42 }, 'Field "input" must be a string'],
    [{ input: 'hi', context: ['x'] }, 'Field "context" must be an object'],
    [{ input: 'hi', threadId: 7 }, 'Field "threadId" must be a non-empty string'],
  ])('rejects invalid agent body %j', async (body, message) => {
    const res = await postJson(buildApp(), '/agents/bot/run', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ message, code: 'INVALID_INPUT' });
  });

  it('rejects a non-positive swarm timeout', async () => {
    const res = await postJson(buildApp(), '/swarms/team/run', { input: 'go', timeout: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Field "timeout" must be a positive number');
    expect(swarmRun).not.toHaveBeenCalled();
  });

  it('rejects invalid workflow options and input', async () => {
    const app = buildApp();
    const badOptions = await postJson(app, '/workflows/pipeline/run', {
      options: { maxConcurrency: 0 },
    });
    expect(badOptions.status).toBe(400);
    expect(badOptions.body.error.message).toBe(
      'Field "options.maxConcurrency" must be a positive integer'
    );

    const badInput = await postJson(app, '/workflows/pipeline/run', { input: 'text' });
    expect(badInput.status).toBe(400);
    expect(workflowExecute).not.toHaveBeenCalled();
  });

  it('strips unsupported workflow options instead of forwarding them', async () => {
    const res = await postJson(buildApp(), '/workflows/pipeline/run', {
      input: { a: 1 },
      options: { maxIterations: 3, skipNodes: ['start'], workflowId: 'forged' },
    });
    expect(res.status).toBe(200);
    const [, input, options] = workflowExecute.mock.calls[0];
    expect(input).toEqual({ a: 1 });
    expect(options).toMatchObject({ maxIterations: 3 });
    expect(options).not.toHaveProperty('skipNodes');
    expect(options).not.toHaveProperty('workflowId');
  });

  it('runs a workflow when the request has no body', async () => {
    const res = await request(buildApp().callback()).post('/workflows/pipeline/run');
    expect(res.status).toBe(200);
    expect(res.body.nodeResults).toEqual({ start: { output: 'ok', duration: 3 } });
  });

  it('rejects unknown message roles and forwards metadata with a token estimate', async () => {
    const memory = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: null }),
      createThread: vi.fn().mockResolvedValue({ success: true, data: {} }),
      getEntries: vi.fn(),
      clearThread: vi.fn(),
      addEntry: vi.fn().mockResolvedValue({ success: true, data: {} }),
    };
    const app = buildApp(
      {},
      {
        run: vi.fn(),
        memory,
        getMemory() {
          return Promise.resolve(this.memory);
        },
      }
    );

    const bad = await postJson(app, '/threads/t1/messages', { role: 'tool', content: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Field "role" must be one of: user, assistant');

    const ok = await postJson(app, '/threads/t1/messages', {
      role: 'user',
      content: 'hello there',
      metadata: { source: 'api' },
    });
    expect(ok.status).toBe(201);
    const entry = memory.addEntry.mock.calls[0][0];
    expect(entry.metadata).toEqual({ source: 'api' });
    expect(entry.tokenCount).toBeGreaterThan(0);
  });
});

describe('error mapping', () => {
  it('maps CogitatorError codes to their HTTP status', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(
        new CogitatorError({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED })
      );
    const res = await postJson(buildApp({}, { run }), '/agents/bot/run', { input: 'hi' });
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED });
  });

  it('reports a failed workflow instead of a successful result', async () => {
    workflowExecute.mockResolvedValue(workflowResult({ error: new Error('node blew up') }));
    const res = await postJson(buildApp(), '/workflows/pipeline/run', {});
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ message: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  it('streams an error instead of workflow_completed when the workflow fails', async () => {
    workflowExecute.mockResolvedValue(
      workflowResult({
        error: new CogitatorError({
          message: 'node failed',
          code: ErrorCode.TOOL_EXECUTION_FAILED,
        }),
      })
    );
    const res = await postJson(buildApp(), '/workflows/pipeline/stream', {});
    const events = parseSSE(res.text);
    expect(events.some((e) => e.type === 'error' && e.message === 'node failed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('workflow_completed');
    expect(res.text).not.toContain('[DONE]');
  });
});

describe('agent SSE stream', () => {
  it('correlates tool-call events with tool results by call id', async () => {
    const run = vi.fn(async (_agent: unknown, opts: Record<string, (arg: unknown) => void>) => {
      opts.onToolCall({ id: 'call_1', name: 'search', arguments: { q: 'x' } });
      opts.onToolResult({ callId: 'call_1', name: 'search', result: { hits: 1 } });
      opts.onToken('answer');
      return runResult();
    });
    const res = await postJson(buildApp({}, { run }), '/agents/bot/stream', { input: 'hi' });
    const events = parseSSE(res.text);

    const start = events.find((e) => e.type === 'tool-call-start');
    const delta = events.find((e) => e.type === 'tool-call-delta');
    const result = events.find((e) => e.type === 'tool-result');
    expect(start?.id).toBe('call_1');
    expect(delta).toMatchObject({ id: 'call_1', argsTextDelta: '{"q":"x"}' });
    expect(result?.toolCallId).toBe('call_1');
  });

  it('streams reasoning as its own part closed before text starts', async () => {
    const run = vi.fn(async (_agent: unknown, opts: Record<string, (arg: unknown) => void>) => {
      opts.onReasoning('a');
      opts.onReasoning('b');
      opts.onToken('x');
      return runResult();
    });
    const events = parseSSE(
      (await postJson(buildApp({}, { run }), '/agents/bot/stream', { input: 'hi' })).text
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
      events.filter((e) => String(e.type).startsWith('reasoning-')).map((e) => e.id)
    );
    expect(reasoningIds.size).toBe(1);
    expect([...reasoningIds][0]).toMatch(/^rsn_/);
  });

  it('closes text before reasoning and reasoning before a tool call', async () => {
    const run = vi.fn(async (_agent: unknown, opts: Record<string, (arg: unknown) => void>) => {
      opts.onToken('x');
      opts.onReasoning('thinking');
      opts.onToolCall({ id: 'call_1', name: 'search', arguments: { q: 'x' } });
      return runResult();
    });
    const events = parseSSE(
      (await postJson(buildApp({}, { run }), '/agents/bot/stream', { input: 'hi' })).text
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
    const run = vi.fn(async (_agent: unknown, opts: Record<string, (arg: unknown) => void>) => {
      opts.onReasoning('partial');
      throw new Error('provider down');
    });
    const events = parseSSE(
      (await postJson(buildApp({}, { run }), '/agents/bot/stream', { input: 'hi' })).text
    );

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'error',
    ]);
  });

  it('sends the final output as text when no tokens were streamed', async () => {
    const res = await postJson(buildApp(), '/agents/bot/stream', { input: 'hi' });
    const events = parseSSE(res.text);

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(events.find((e) => e.type === 'text-delta')?.delta).toBe('done');
  });

  it('serializes swarm agent usage maps in swarm_completed', async () => {
    const res = await postJson(buildApp(), '/swarms/team/stream', { input: 'go' });
    const completed = parseSSE(res.text).find(
      (e) => (e as { type?: string; event?: string }).event === 'swarm_completed'
    );
    expect(completed).toBeDefined();
    expect(JSON.stringify(completed)).toContain('"agentUsage":{"a1"');
  });
});

describe('client disconnect', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(app: Koa<CogitatorState>): Promise<string> {
    server = createServer(app.callback());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('aborts the agent run when the SSE client disconnects', async () => {
    let capturedSignal: AbortSignal | undefined;
    const run = vi.fn(
      (_agent: unknown, opts: { signal: AbortSignal; onToken: (t: string) => void }) =>
        new Promise((_resolve, reject) => {
          capturedSignal = opts.signal;
          opts.onToken('partial');
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const base = await listen(buildApp({}, { run }));

    const controller = new AbortController();
    const res = await fetch(`${base}/agents/bot/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
  });

  it('aborts the swarm when the client disconnects from a non-streaming run', async () => {
    swarmRun.mockImplementation(() => new Promise(() => {}));
    const base = await listen(buildApp());

    const controller = new AbortController();
    const pending = fetch(`${base}/swarms/team/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
      signal: controller.signal,
    }).catch(() => undefined);

    await vi.waitFor(() => expect(swarmRun).toHaveBeenCalled());
    controller.abort();
    await pending;

    await vi.waitFor(() => expect(swarmAbort).toHaveBeenCalled());
  });
});

describe('body parser', () => {
  it('reuses a body parsed by upstream middleware instead of hanging', async () => {
    const run = vi.fn().mockResolvedValue(runResult());
    const app = new Koa<CogitatorState>();
    app.use(async (ctx, next) => {
      const chunks: Buffer[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
      (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(
        Buffer.concat(chunks).toString()
      );
      await next();
    });
    const router = cogitatorApp({
      cogitator: { run } as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: { config: { tools: [] } } as never },
    });
    app.use(router.routes());

    const res = await postJson(app, '/agents/bot/run', { input: 'from upstream' });
    expect(res.status).toBe(200);
    expect(run.mock.calls[0][1]).toMatchObject({ input: 'from upstream' });
  });

  it('honors a custom bodyLimit', async () => {
    const app = buildApp({ bodyLimit: 64 });
    const res = await postJson(app, '/agents/bot/run', { input: 'x'.repeat(200) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const small = await postJson(app, '/agents/bot/run', { input: 'tiny' });
    expect(small.status).toBe(200);
  });
});

describe('server contract', () => {
  function threadMemory(count: number) {
    const entries = Array.from({ length: count }, (_, at) => ({
      id: `entry_${at + 1}`,
      threadId: 'thread-1',
      message: { role: 'user', content: `message ${at + 1}` },
      tokenCount: 1,
      createdAt: new Date(at + 1),
    }));
    return {
      getThread: vi.fn(async () => ({ success: true, data: null })),
      getEntries: vi.fn(async (query: { before?: Date; limit?: number }) => {
        let data = entries;
        if (query.before) data = data.filter((entry) => entry.createdAt < query.before!);
        if (query.limit) data = data.slice(-query.limit);
        return { success: true, data };
      }),
      addEntry: vi.fn(),
      clearThread: vi.fn(),
    };
  }

  function contents(body: { messages: Array<{ content: string }> }): string[] {
    return body.messages.map((message) => message.content);
  }

  it('refuses limits that are not positive integers when the router is built', () => {
    expect(() => buildApp({ limits: { swarmTimeout: 0 } })).toThrow(/limits\.swarmTimeout/);
    expect(() => buildApp({ limits: { workflowMaxConcurrency: 2.5 } })).toThrow(
      /limits\.workflowMaxConcurrency/
    );
  });

  it('holds swarm runs and streams to the swarm timeout limit', async () => {
    const app = buildApp({ limits: { swarmTimeout: 1000 } });

    await postJson(app, '/swarms/team/run', { input: 'go', timeout: 60_000 });
    await postJson(app, '/swarms/team/run', { input: 'go', timeout: 500 });
    await postJson(app, '/swarms/team/run', { input: 'go' });
    await postJson(app, '/swarms/team/stream', { input: 'go', timeout: 60_000 });

    expect(swarmRun.mock.calls.map(([options]) => options.timeout)).toEqual([
      1000, 500, 1000, 1000,
    ]);
  });

  it('holds workflow runs and streams to the workflow limits', async () => {
    const app = buildApp({ limits: { workflowMaxIterations: 10, workflowMaxConcurrency: 2 } });

    await postJson(app, '/workflows/pipeline/run', { options: { maxIterations: 50 } });
    await postJson(app, '/workflows/pipeline/run', { options: { maxConcurrency: 1 } });
    await postJson(app, '/workflows/pipeline/stream', {});

    expect(workflowExecute.mock.calls.map(([, , options]) => options)).toMatchObject([
      { maxIterations: 10, maxConcurrency: 2 },
      { maxIterations: 10, maxConcurrency: 1 },
      { maxIterations: 10, maxConcurrency: 2 },
    ]);
  });

  it('shows the limits in the OpenAPI spec', async () => {
    const app = buildApp({ enableSwagger: true, limits: { swarmTimeout: 1000 } });
    const res = await request(app.callback()).get('/openapi.json');
    expect(res.text).toContain("Held to 1000 ms, the server's limit");
  });

  it('turns away anonymous callers under anonymous deny, leaving health and docs open', async () => {
    const app = buildApp({
      enableSwagger: true,
      anonymous: 'deny',
      auth: (ctx) => {
        const user = ctx.get('x-user');
        return user ? { userId: user } : undefined;
      },
    });

    for (const path of ['/health', '/ready', '/openapi.json', '/docs']) {
      expect((await request(app.callback()).get(path)).status).toBe(200);
    }
    const refused = await postJson(app, '/agents/bot/run', { input: 'hi' });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({
      error: { message: 'Authentication required', code: 'UNAUTHORIZED' },
    });
    expect((await request(app.callback()).get('/agents')).status).toBe(401);

    const allowed = await request(app.callback()).get('/agents').set('x-user', 'alice');
    expect(allowed.status).toBe(200);
  });

  it('refuses the thread routes on threads authorizeThread keeps the caller from', async () => {
    const memory = threadMemory(2);
    const app = buildApp(
      { authorizeThread: (_auth, id) => id !== 'thread-1' },
      { getMemory: async () => memory }
    );

    const answers = [
      await request(app.callback()).get('/threads/thread-1'),
      await request(app.callback()).delete('/threads/thread-1'),
      await postJson(app, '/threads/thread-1/messages', { role: 'user', content: 'hi' }),
    ];

    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('THREAD_FORBIDDEN');
    }
    expect(memory.getThread).not.toHaveBeenCalled();
    expect(memory.clearThread).not.toHaveBeenCalled();
    expect(memory.addEntry).not.toHaveBeenCalled();
  });

  it('refuses swarm runs on threads authorizeThread keeps the caller from', async () => {
    const app = buildApp({ authorizeThread: () => false });
    const res = await postJson(app, '/swarms/team/stream', { input: 'go', threadId: 't' });
    expect(res.status).toBe(403);
    expect(swarmRun).not.toHaveBeenCalled();
  });

  it('reads a thread page by page, newest first', async () => {
    const app = buildApp({}, { getMemory: async () => threadMemory(5) });
    const page = (query: string) => request(app.callback()).get(`/threads/thread-1?${query}`);

    const first = (await page('limit=2')).body;
    expect(contents(first)).toEqual(['message 4', 'message 5']);
    expect(typeof first.nextCursor).toBe('string');

    const second = (await page(`limit=2&cursor=${first.nextCursor}`)).body;
    expect(contents(second)).toEqual(['message 2', 'message 3']);

    const last = (await page(`limit=2&cursor=${second.nextCursor}`)).body;
    expect(contents(last)).toEqual(['message 1']);
    expect(last).not.toHaveProperty('nextCursor');
  });

  it('refuses a thread page query it cannot read', async () => {
    const app = buildApp({}, { getMemory: async () => threadMemory(1) });
    for (const query of ['limit=0', 'limit=abc', 'cursor=bogus']) {
      const res = await request(app.callback()).get(`/threads/thread-1?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('answers a run error with Retry-After and streams its code', async () => {
    const run = vi.fn().mockRejectedValue(
      new CogitatorError({
        message: 'slow down',
        code: ErrorCode.LLM_RATE_LIMITED,
        retryAfter: 1500,
      })
    );
    const app = buildApp({}, { run });

    const res = await postJson(app, '/agents/bot/run', { input: 'hi' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.body).toEqual({
      error: { message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED },
    });

    const stream = await postJson(app, '/agents/bot/stream', { input: 'hi' });
    expect(parseSSE(stream.text).at(-1)).toEqual({
      type: 'error',
      message: 'slow down',
      code: ErrorCode.LLM_RATE_LIMITED,
    });
  });

  it('answers an error outside the routes with the envelope and Retry-After', async () => {
    const app = buildApp({
      deps: () => {
        throw new CogitatorError({
          message: 'provider down',
          code: ErrorCode.LLM_UNAVAILABLE,
          retryAfter: 30_000,
        });
      },
    });
    const res = await postJson(app, '/agents/bot/run', { input: 'hi' });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error.code).toBe(ErrorCode.LLM_UNAVAILABLE);
  });

  it('answers a swarm that ran out of time with 504 RUN_TIMEOUT', async () => {
    swarmRun.mockRejectedValue(
      Object.assign(new Error('Swarm timed out after 1000ms'), { name: 'SwarmTimeoutError' })
    );
    const res = await postJson(buildApp(), '/swarms/team/run', { input: 'go' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('RUN_TIMEOUT');
  });

  it('hands agent runs, streams and resumes the deps the server builds, never the body', async () => {
    const run = vi.fn().mockResolvedValue(runResult());
    const resume = vi.fn().mockResolvedValue(runResult());
    const app = buildApp(
      { deps: async (ctx) => ({ tenant: ctx.get('x-tenant') }) },
      { run, resume }
    );
    const send = (path: string, body: unknown) =>
      request(app.callback())
        .post(path)
        .set('Content-Type', 'application/json')
        .set('x-tenant', 'acme')
        .send(JSON.stringify(body));

    await send('/agents/bot/run', { input: 'hi', deps: { tenant: 'evil' } });
    await send('/agents/bot/stream', { input: 'hi' });
    await send('/agents/bot/resume', { threadId: 't', decisions: {} });

    expect(run.mock.calls.map(([, options]) => options.deps)).toEqual([
      { tenant: 'acme' },
      { tenant: 'acme' },
    ]);
    expect(resume.mock.calls[0][2]).toMatchObject({ deps: { tenant: 'acme' } });
  });
});

describe('unmatched paths', () => {
  const auth: CogitatorAppOptions['auth'] = (ctx) => {
    const user = ctx.get('x-user');
    return user ? { userId: user } : undefined;
  };

  function buildRouter(overrides: Partial<CogitatorAppOptions> = {}) {
    return cogitatorApp({
      cogitator: { run: vi.fn() } as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
      ...overrides,
    });
  }

  it('answers an unknown path and a method no route takes with 404 in the envelope', async () => {
    const app = buildApp();

    const unknown = await postJson(app, '/nowhere', { input: 'hi' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { message: 'Not found', code: 'NOT_FOUND' } });

    const wrongMethod = await request(app.callback()).get('/agents/bot/run');
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.body.error.code).toBe('NOT_FOUND');
  });

  it('answers OPTIONS on a path it serves with the methods it serves, with or without allowedMethods', async () => {
    const plain = new Koa<CogitatorState>();
    plain.use(buildRouter().routes());
    const withAllowed = new Koa<CogitatorState>();
    const router = buildRouter();
    withAllowed.use(router.routes());
    withAllowed.use(router.allowedMethods());

    for (const app of [plain, withAllowed]) {
      const agents = await request(app.callback()).options('/agents');
      expect(agents.status).toBe(204);
      expect(agents.headers.allow).toBe('GET, HEAD, OPTIONS');
      const run = await request(app.callback()).options('/agents/bot/run');
      expect(run.headers.allow).toBe('OPTIONS, POST');
    }
    const unknown = await request(plain.callback()).options('/nowhere');
    expect(unknown.status).toBe(404);
  });

  it('answers 401 on any path but the public ones under anonymous deny', async () => {
    const app = buildApp({ anonymous: 'deny', auth });

    for (const path of ['/nowhere', '/agents/bot/run', '/docs']) {
      const res = await request(app.callback()).get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { message: 'Authentication required', code: 'UNAUTHORIZED' },
      });
    }
    expect((await request(app.callback()).get('/health')).status).toBe(200);

    const known = await request(app.callback()).get('/nowhere').set('x-user', 'alice');
    expect(known.status).toBe(404);
    expect(known.body.error.code).toBe('NOT_FOUND');
  });

  it('answers 401 when auth throws on an unknown path', async () => {
    const app = buildApp({
      auth: () => {
        throw new Error('bad token');
      },
    });
    const res = await request(app.callback()).get('/nowhere');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('leaves what it does not serve to the middleware after the router, untouched', async () => {
    const authFn = vi.fn(auth);
    const app = new Koa<CogitatorState>();
    const router = buildRouter({ anonymous: 'deny', auth: authFn });
    app.use(router.routes());
    app.use(router.allowedMethods());
    app.use((ctx) => {
      if (ctx.path === '/upload') ctx.body = { type: ctx.get('content-type') };
    });

    const res = await request(app.callback()).post('/upload').type('form').send({ name: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.type).toContain('application/x-www-form-urlencoded');
    expect(authFn).not.toHaveBeenCalled();

    expect((await request(app.callback()).get('/nowhere')).status).toBe(401);
  });

  it('answers only the paths under the prefix it is mounted at', async () => {
    const app = new Koa<CogitatorState>();
    const parent = new Router<CogitatorState>();
    const router = buildRouter({ anonymous: 'deny', auth });
    parent.use('/api/ai', router.routes(), router.allowedMethods());
    app.use(parent.routes());

    const inside = await request(app.callback()).get('/api/ai/nowhere');
    expect(inside.status).toBe(401);
    expect(inside.body.error.code).toBe('UNAUTHORIZED');

    const known = await request(app.callback()).get('/api/ai/nowhere').set('x-user', 'alice');
    expect(known.status).toBe(404);
    expect(known.body.error.code).toBe('NOT_FOUND');

    const outside = await request(app.callback()).get('/elsewhere');
    expect(outside.status).toBe(404);
    expect(outside.text).toBe('Not Found');

    const agents = await request(app.callback()).get('/api/ai/agents').set('x-user', 'alice');
    expect(agents.status).toBe(200);
  });
});
