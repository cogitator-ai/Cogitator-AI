import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { defineWebSocketHelper, WSContext, type WSEvents } from 'hono/ws';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, HonoEnv } from '../types.js';

const workflowExecute = vi.fn();
const swarmRun = vi.fn();
const swarmAbort = vi.fn();

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
    close = vi.fn(async () => undefined);
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
  return cogitatorApp({
    cogitator: (runtime ?? {
      run: vi.fn().mockResolvedValue(runResult()),
    }) as unknown as CogitatorAppOptions['cogitator'],
    agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    workflows: { pipeline: { entryPoint: 'start', nodes: new Map() } as never },
    swarms: { team: { strategy: 'round-robin' } as never },
    ...overrides,
  });
}

function post(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    ...init,
  };
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
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

describe('request validation', () => {
  it.each([
    [{ input: 42 }, 'Field "input" must be a string'],
    [{ input: 'hi', context: ['x'] }, 'Field "context" must be an object'],
    [{ input: 'hi', threadId: 7 }, 'Field "threadId" must be a non-empty string'],
  ])('rejects invalid agent body %j', async (body, message) => {
    const res = await buildApp().request('/agents/bot/run', post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message, code: 'INVALID_INPUT' } });
  });

  it('reports a missing input for an empty agent body', async () => {
    const res = await buildApp().request('/agents/bot/run', { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Missing required field: input');
  });

  it('rejects a non-positive swarm timeout', async () => {
    const res = await buildApp().request('/swarms/team/run', post({ input: 'go', timeout: 0 }));
    expect(res.status).toBe(400);
    expect(swarmRun).not.toHaveBeenCalled();
  });

  it('runs a workflow when the request has no body', async () => {
    const res = await buildApp().request('/workflows/pipeline/run', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).nodeResults).toEqual({ start: { output: 'ok', duration: 3 } });
  });

  it('strips unsupported workflow options instead of forwarding them', async () => {
    const res = await buildApp().request(
      '/workflows/pipeline/run',
      post({ options: { maxConcurrency: 2, skipNodes: ['start'], workflowId: 'forged' } })
    );
    expect(res.status).toBe(200);
    const options = workflowExecute.mock.calls[0][2];
    expect(options).toMatchObject({ maxConcurrency: 2 });
    expect(options).not.toHaveProperty('skipNodes');
    expect(options).not.toHaveProperty('workflowId');
  });

  it('rejects invalid workflow option types', async () => {
    const res = await buildApp().request(
      '/workflows/pipeline/run',
      post({ options: { checkpoint: true } })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(
      'Field "options.checkpoint" is not supported: the server keeps no checkpoint store'
    );
  });

  it('rejects unknown roles and forwards metadata with a token estimate', async () => {
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

    const bad = await app.request('/threads/t1/messages', post({ role: 'tool', content: 'x' }));
    expect(bad.status).toBe(400);

    const ok = await app.request(
      '/threads/t1/messages',
      post({ role: 'assistant', content: 'stored reply', metadata: { source: 'api' } })
    );
    expect(ok.status).toBe(201);
    const entry = memory.addEntry.mock.calls[0][0];
    expect(entry.metadata).toEqual({ source: 'api' });
    expect(entry.tokenCount).toBeGreaterThan(0);
  });
});

describe('body limit', () => {
  it('rejects bodies above the default 1 MB limit with 413', async () => {
    const res = await buildApp().request(
      '/agents/bot/run',
      post({ input: 'x'.repeat(1024 * 1024 + 10) })
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('honors a custom bodyLimit', async () => {
    const app = buildApp({ bodyLimit: 64 });
    expect((await app.request('/agents/bot/run', post({ input: 'x'.repeat(200) }))).status).toBe(
      413
    );
    expect((await app.request('/agents/bot/run', post({ input: 'tiny' }))).status).toBe(200);
  });
});

describe('error mapping', () => {
  it('maps CogitatorError codes to their HTTP status on run routes', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(
        new CogitatorError({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED })
      );
    const res = await buildApp({}, { run }).request('/agents/bot/run', post({ input: 'hi' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED },
    });
  });

  it('passes HTTPException responses through the app error handler', async () => {
    const app = buildApp();
    app.get('/guarded', () => {
      throw new HTTPException(403, { message: 'forbidden' });
    });
    const res = await app.request('/guarded');
    expect(res.status).toBe(403);
  });

  it('reports a failed workflow instead of a successful result', async () => {
    workflowExecute.mockResolvedValue(workflowResult({ error: new Error('node blew up') }));
    const res = await buildApp().request('/workflows/pipeline/run', post({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
    });
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
    const res = await buildApp().request('/workflows/pipeline/stream', post({}));
    const text = await res.text();
    const events = parseSSE(text);
    expect(events.some((e) => e.type === 'error' && e.message === 'node failed')).toBe(true);
    expect(text).not.toContain('workflow_completed');
    expect(text).not.toContain('[DONE]');
  });

  it('delivers the error event when an agent stream fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('provider down'));
    const res = await buildApp({}, { run }).request('/agents/bot/stream', post({ input: 'hi' }));
    const events = parseSSE(await res.text());
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('streams', () => {
  it('correlates tool-call events with tool results by call id', async () => {
    const run = vi.fn(async (_agent: unknown, opts: Record<string, (arg: unknown) => void>) => {
      opts.onToolCall({ id: 'call_1', name: 'search', arguments: { q: 'x' } });
      opts.onToolResult({ callId: 'call_1', name: 'search', result: { hits: 1 } });
      return runResult();
    });
    const res = await buildApp({}, { run }).request('/agents/bot/stream', post({ input: 'hi' }));
    const events = parseSSE(await res.text());

    expect(events.find((e) => e.type === 'tool-call-start')?.id).toBe('call_1');
    expect(events.find((e) => e.type === 'tool-call-delta')).toMatchObject({
      id: 'call_1',
      argsTextDelta: '{"q":"x"}',
    });
    expect(events.find((e) => e.type === 'tool-result')?.toolCallId).toBe('call_1');
  });

  it('streams reasoning as its own part closed before text starts', async () => {
    const run = vi.fn(async (_agent: unknown, opts: Record<string, (arg: unknown) => void>) => {
      opts.onReasoning('a');
      opts.onReasoning('b');
      opts.onToken('x');
      return runResult();
    });
    const events = parseSSE(
      await (
        await buildApp({}, { run }).request('/agents/bot/stream', post({ input: 'hi' }))
      ).text()
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
      await (
        await buildApp({}, { run }).request('/agents/bot/stream', post({ input: 'hi' }))
      ).text()
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
      await (
        await buildApp({}, { run }).request('/agents/bot/stream', post({ input: 'hi' }))
      ).text()
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
    const res = await buildApp().request('/agents/bot/stream', post({ input: 'hi' }));
    const events = parseSSE(await res.text());

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
    const res = await buildApp().request('/swarms/team/stream', post({ input: 'go' }));
    expect(await res.text()).toContain('"agentUsage":{"a1"');
  });

  it('passes an abort signal tied to the request to agent runs', async () => {
    const run = vi.fn().mockResolvedValue(runResult());
    const controller = new AbortController();
    await buildApp({}, { run }).request(
      '/agents/bot/run',
      post({ input: 'hi' }, { signal: controller.signal })
    );
    const signal = (run.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('aborts the swarm when the request is aborted', async () => {
    const controller = new AbortController();
    swarmRun.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ output: 'late', agentResults: new Map() });
    });
    const res = await buildApp().request(
      '/swarms/team/run',
      post({ input: 'go' }, { signal: controller.signal })
    );
    expect(swarmAbort).toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});

describe('websocket route', () => {
  interface CapturedSocket {
    events: WSEvents;
    ws: WSContext;
    sent: Array<Record<string, unknown>>;
    closed: Array<{ code?: number; reason?: string }>;
  }

  function createUpgradeHelper() {
    const sockets: CapturedSocket[] = [];
    const upgradeWebSocket = defineWebSocketHelper((c, events) => {
      const sent: Array<Record<string, unknown>> = [];
      const closed: Array<{ code?: number; reason?: string }> = [];
      const ws = new WSContext({
        send: (data) => sent.push(JSON.parse(String(data)) as Record<string, unknown>),
        close: (code, reason) => closed.push({ code, reason }),
        readyState: 1,
      });
      sockets.push({ events, ws, sent, closed });
      return c.text('upgraded', 200);
    });
    return { upgradeWebSocket, sockets };
  }

  async function connect(app: Hono<HonoEnv>, sockets: CapturedSocket[], headers = {}) {
    const res = await app.request('/ws', { headers });
    return { res, socket: sockets.at(-1) };
  }

  async function send(socket: CapturedSocket, message: unknown) {
    socket.events.onMessage?.(
      new MessageEvent('message', { data: JSON.stringify(message) }),
      socket.ws
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('returns 501 with guidance when no upgradeWebSocket helper is configured', async () => {
    const app = buildApp({ enableWebSocket: true });
    const res = await app.request('/ws');
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('UNIMPLEMENTED');
  });

  it('runs agents over the upgraded socket', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const run = vi.fn(async (_agent: unknown, opts: { onToken: (t: string) => void }) => {
      opts.onToken('hel');
      return runResult();
    });
    const app = buildApp({ enableWebSocket: true, websocket: { upgradeWebSocket } }, { run });

    const { res, socket } = await connect(app, sockets);
    expect(res.status).toBe(200);
    await send(socket!, {
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'hi', threadId: 'thread-7' },
    });

    await vi.waitFor(() => expect(socket!.sent).toHaveLength(2));
    expect(socket!.sent[0]).toEqual({
      type: 'event',
      id: 'r1',
      payload: { type: 'token', delta: 'hel' },
    });
    expect(socket!.sent[1]).toMatchObject({
      type: 'event',
      id: 'r1',
      payload: { type: 'complete' },
    });
    expect(run.mock.calls[0][1]).toMatchObject({ threadId: 'thread-7' });
  });

  it('applies the auth middleware to the upgrade request', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const app = buildApp({
      enableWebSocket: true,
      websocket: { upgradeWebSocket },
      auth: (c) => {
        if (c.req.header('authorization') !== 'Bearer ok') throw new Error('nope');
        return { userId: 'u1' };
      },
    });

    const denied = await app.request('/ws');
    expect(denied.status).toBe(401);
    expect(sockets).toHaveLength(0);

    const allowed = await connect(app, sockets, { authorization: 'Bearer ok' });
    expect(allowed.res.status).toBe(200);
    expect(sockets).toHaveLength(1);
  });

  it('runs agents as the user authenticated on the upgrade request', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const run = vi.fn().mockResolvedValue(runResult());
    const app = buildApp(
      {
        enableWebSocket: true,
        websocket: { upgradeWebSocket },
        auth: (c) => ({ userId: c.req.header('x-user') }),
      },
      { run }
    );

    const alice = (await connect(app, sockets, { 'x-user': 'alice' })).socket!;
    const bob = (await connect(app, sockets, { 'x-user': 'bob' })).socket!;
    await send(alice, {
      type: 'run',
      id: 'a',
      payload: { type: 'agent', name: 'bot', input: 'hi', threadId: 'thread-a' },
    });
    await send(bob, {
      type: 'run',
      id: 'b',
      payload: { type: 'agent', name: 'bot', input: 'hi', threadId: 'thread-b' },
    });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[0][1]).toMatchObject({ threadId: 'thread-a', userId: 'alice' });
    expect(run.mock.calls[1][1]).toMatchObject({ threadId: 'thread-b', userId: 'bob' });
  });

  it('aborts the active run when the socket closes', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    let signal: AbortSignal | undefined;
    const run = vi.fn((_agent: unknown, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise(() => {});
    });
    const app = buildApp({ enableWebSocket: true, websocket: { upgradeWebSocket } }, { run });
    const { socket } = await connect(app, sockets);

    await send(socket!, {
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: 'hi' },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    socket!.events.onClose?.(new Event('close') as CloseEvent, socket!.ws);

    expect(signal?.aborted).toBe(true);
  });

  it('rejects messages above maxPayloadSize and closes with 1009', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const app = buildApp({
      enableWebSocket: true,
      websocket: { upgradeWebSocket, maxPayloadSize: 16 },
    });
    const { socket } = await connect(app, sockets);

    await send(socket!, { type: 'ping', id: 'a-very-long-identifier' });
    expect(socket!.sent).toEqual([{ type: 'error', error: 'Message too large' }]);
    expect(socket!.closed).toEqual([{ code: 1009, reason: 'Message too large' }]);
  });

  it('decodes binary frames', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const app = buildApp({ enableWebSocket: true, websocket: { upgradeWebSocket } });
    const { socket } = await connect(app, sockets);

    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'ping', id: 'b1' }));
    socket!.events.onMessage?.(new MessageEvent('message', { data: bytes.buffer }), socket!.ws);
    await vi.waitFor(() => expect(socket!.sent).toEqual([{ type: 'pong', id: 'b1' }]));
  });

  it('answers unsupported message and run types', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const app = buildApp({ enableWebSocket: true, websocket: { upgradeWebSocket } });
    const { socket } = await connect(app, sockets);

    await send(socket!, { type: 'dance' });
    await send(socket!, { type: 'run', id: 'x', payload: { type: 'job', name: 'a', input: 'b' } });
    await send(socket!, {
      type: 'run',
      id: 'y',
      payload: { type: 'agent', name: 'constructor', input: 'b' },
    });

    await vi.waitFor(() => expect(socket!.sent).toHaveLength(3));
    expect(socket!.sent).toEqual([
      { type: 'error', error: 'Unsupported message type: dance' },
      { type: 'error', id: 'x', error: 'Unsupported run type: job' },
      { type: 'error', id: 'y', error: "Agent 'constructor' not found" },
    ]);
  });

  it('reports cancelled after stop and accepts the next run', async () => {
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    let calls = 0;
    const run = vi.fn((_agent: unknown, opts: { signal: AbortSignal }) => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(runResult());
    });
    const app = buildApp({ enableWebSocket: true, websocket: { upgradeWebSocket } }, { run });
    const { socket } = await connect(app, sockets);

    await send(socket!, {
      type: 'run',
      id: 'a',
      payload: { type: 'agent', name: 'bot', input: 'x' },
    });
    await send(socket!, { type: 'stop' });
    await vi.waitFor(() =>
      expect(socket!.sent).toContainEqual({
        type: 'event',
        id: 'a',
        payload: { type: 'cancelled' },
      })
    );

    await send(socket!, {
      type: 'run',
      id: 'b',
      payload: { type: 'agent', name: 'bot', input: 'y' },
    });
    await vi.waitFor(() =>
      expect(socket!.sent.at(-1)).toMatchObject({ id: 'b', payload: { type: 'complete' } })
    );
  });

  it('reports a failed workflow as an error', async () => {
    workflowExecute.mockResolvedValue(workflowResult({ error: new Error('node failed') }));
    const { upgradeWebSocket, sockets } = createUpgradeHelper();
    const app = buildApp({ enableWebSocket: true, websocket: { upgradeWebSocket } });
    const { socket } = await connect(app, sockets);

    await send(socket!, {
      type: 'run',
      id: 'w',
      payload: { type: 'workflow', name: 'pipeline', input: 'x' },
    });
    await vi.waitFor(() =>
      expect(socket!.sent).toEqual([{ type: 'error', id: 'w', error: 'Internal server error' }])
    );
  });

  it('keeps accepting a path string for backwards compatibility', async () => {
    const app = new Hono<HonoEnv>();
    const { createWebSocketRoutes } = await import('../websocket/handler.js');
    app.route('/', createWebSocketRoutes('/socket'));
    expect((await app.request('/socket')).status).toBe(501);
  });
});
