import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { setupWebSocket } from '../websocket/handler.js';
import type { RouteContext } from '../types.js';

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
    getResourceUsage = () => ({
      totalTokens: 42,
      totalCost: 0.01,
      elapsedTime: 100,
      agentUsage: new Map(),
    });
  },
}));

function workflowResult(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf_1',
    workflowName: 'pipeline',
    state: { done: true },
    nodeResults: new Map([['start', { output: 'workflow-done', duration: 5 }]]),
    duration: 12,
    ...overrides,
  };
}

function mockRouteContext(overrides?: Partial<RouteContext>): RouteContext {
  return {
    runtime: {
      run: vi.fn().mockResolvedValue({
        output: 'test output',
        threadId: 'thread-1',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        toolCalls: [],
      }),
    } as unknown as RouteContext['runtime'],
    agents: {},
    workflows: {},
    swarms: {},
    ...overrides,
  };
}

function sendAndWait(ws: WebSocket, message: unknown, timeout = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(message));
  });
}

function collectMessages(ws: WebSocket, count: number, timeout = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const results: unknown[] = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout: got ${results.length}/${count}`)),
      timeout
    );
    const handler = (data: WebSocket.RawData) => {
      results.push(JSON.parse(data.toString()));
      if (results.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(results);
      }
    };
    ws.on('message', handler);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.once('open', resolve);
  });
}

let server: Server;
let clients: WebSocket[] = [];

async function createTestServer(
  ctx: RouteContext,
  config?: Parameters<typeof setupWebSocket>[2]
): Promise<{ port: number; wss: Awaited<ReturnType<typeof setupWebSocket>> }> {
  server = createServer();
  const wss = await setupWebSocket(server, ctx, config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, wss };
}

function createClient(port: number, path = '/ws'): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(ws);
  return ws;
}

describe('setupWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowExecute.mockResolvedValue(workflowResult());
    swarmRun.mockResolvedValue({
      output: 'swarm-done',
      agentResults: new Map([['a1', { output: 'part', usage: { totalTokens: 5 } }]]),
    });
    clients = [];
  });

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    clients = [];
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('creates a WebSocket server and returns it', async () => {
    const ctx = mockRouteContext();
    const { wss } = await createTestServer(ctx);
    expect(wss).not.toBeNull();
  });

  it('accepts connections on the configured path', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx, { path: '/custom' });
    const ws = createClient(port, '/custom');
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('responds with pong on ping message', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, { type: 'ping' });
    expect(response).toEqual({ type: 'pong' });
  });

  it('returns error on invalid JSON', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
      ws.send('not{json');
    });

    expect(response).toEqual(expect.objectContaining({ type: 'error' }));
  });

  it('returns error when run payload is missing fields', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'r1',
      payload: { type: 'agent' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 'r1',
      error: 'Invalid run payload: "name" is required',
    });
  });

  it('refuses a whitespace-only input before the model is called', async () => {
    const ctx = mockRouteContext({
      agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    });
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'r1',
      payload: { type: 'agent', name: 'bot', input: '   ' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 'r1',
      error: 'Invalid run payload: "input" is required',
    });
    expect(ctx.runtime.run).not.toHaveBeenCalled();
  });

  it('returns error when agent not found', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'r2',
      payload: { type: 'agent', name: 'ghost', input: 'hello' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 'r2',
      error: "Agent 'ghost' not found",
    });
  });

  it('streams token events and completes on successful agent run', async () => {
    const run = vi.fn().mockImplementation((_agent: unknown, opts: Record<string, unknown>) => {
      const onToken = opts.onToken as (t: string) => void;
      onToken('Hello');
      onToken(' world');
      return Promise.resolve({ output: 'Hello world', usage: { totalTokens: 5 } });
    });

    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { writer: { name: 'writer' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const collecting = collectMessages(ws, 3);
    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'r3',
        payload: { type: 'agent', name: 'writer', input: 'write something' },
      })
    );

    const responses = await collecting;
    expect(responses[0]).toEqual({
      type: 'event',
      id: 'r3',
      payload: { type: 'token', delta: 'Hello' },
    });
    expect(responses[1]).toEqual({
      type: 'event',
      id: 'r3',
      payload: { type: 'token', delta: ' world' },
    });
    expect(responses[2]).toEqual({
      type: 'event',
      id: 'r3',
      payload: {
        type: 'complete',
        result: { output: 'Hello world', usage: { totalTokens: 5 } },
      },
    });
  });

  it('sends reasoning deltas as reasoning events', async () => {
    const run = vi.fn().mockImplementation((_agent: unknown, opts: Record<string, unknown>) => {
      const onReasoning = opts.onReasoning as (delta: string) => void;
      const onToken = opts.onToken as (token: string) => void;
      onReasoning('thinking');
      onToken('Hi');
      return Promise.resolve({ output: 'Hi' });
    });

    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const collecting = collectMessages(ws, 3);
    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'r5',
        payload: { type: 'agent', name: 'bot', input: 'think' },
      })
    );

    const responses = await collecting;
    expect(responses[0]).toEqual({
      type: 'event',
      id: 'r5',
      payload: { type: 'reasoning', delta: 'thinking' },
    });
    expect(responses[1]).toEqual({
      type: 'event',
      id: 'r5',
      payload: { type: 'token', delta: 'Hi' },
    });
  });

  it('sends tool-call and tool-result events', async () => {
    const run = vi.fn().mockImplementation((_agent: unknown, opts: Record<string, unknown>) => {
      const onToolCall = opts.onToolCall as (tc: unknown) => void;
      const onToolResult = opts.onToolResult as (tr: unknown) => void;
      onToolCall({ id: 'tc1', name: 'search', arguments: { q: 'test' } });
      onToolResult({ callId: 'tc1', result: 'found it' });
      return Promise.resolve({ output: 'done' });
    });

    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const collecting = collectMessages(ws, 3);
    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'r4',
        payload: { type: 'agent', name: 'bot', input: 'search' },
      })
    );

    const responses = await collecting;
    expect(responses[0]).toEqual({
      type: 'event',
      id: 'r4',
      payload: { type: 'tool-call', id: 'tc1', name: 'search', arguments: { q: 'test' } },
    });
    expect(responses[1]).toEqual({
      type: 'event',
      id: 'r4',
      payload: { type: 'tool-result', callId: 'tc1', result: 'found it' },
    });
    expect(responses[2] as Record<string, unknown>).toEqual({
      type: 'event',
      id: 'r4',
      payload: { type: 'complete', result: { output: 'done' } },
    });
  });

  it('rejects concurrent runs', async () => {
    let resolveRun: () => void;
    const runPromise = new Promise<void>((r) => {
      resolveRun = r;
    });

    const run = vi.fn().mockImplementation(() => runPromise.then(() => ({ output: 'ok' })));

    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'first',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      })
    );

    await new Promise((r) => setTimeout(r, 50));

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'second',
      payload: { type: 'agent', name: 'bot', input: 'hi again' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 'second',
      error: 'A run is already in progress',
    });

    resolveRun!();
  });

  it('stop message aborts the run', async () => {
    let resolveRun: () => void;
    const runPromise = new Promise<void>((r) => {
      resolveRun = r;
    });

    const run = vi.fn().mockImplementation((_a: unknown, opts: Record<string, unknown>) => {
      return runPromise.then(() => {
        const signal = opts.stream;
        if (signal) throw new Error('aborted');
        return { output: 'ok' };
      });
    });

    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'run-to-stop',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      })
    );

    await new Promise((r) => setTimeout(r, 50));

    ws.send(JSON.stringify({ type: 'stop' }));

    resolveRun!();

    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 2000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'event' || msg.type === 'error') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    const msg = response as Record<string, unknown>;
    const payload = msg.payload as Record<string, unknown> | undefined;
    expect((msg.type === 'event' && payload?.type === 'cancelled') || msg.type === 'error').toBe(
      true
    );
  });

  it('clears abort state after run completes', async () => {
    const ctx = mockRouteContext({
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const collecting = collectMessages(ws, 1);
    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'run1',
        payload: { type: 'agent', name: 'bot', input: 'first' },
      })
    );
    await collecting;

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'run2',
      payload: { type: 'agent', name: 'bot', input: 'second' },
    });

    const msg = response as Record<string, unknown>;
    const payload = msg.payload as Record<string, unknown> | undefined;
    expect(msg.type).toBe('event');
    expect(payload?.type).toBe('complete');
  });

  it('runs workflow successfully', async () => {
    const ctx = mockRouteContext({
      workflows: { pipeline: { entryPoint: 'start' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'w1',
      payload: { type: 'workflow', name: 'pipeline', input: 'data' },
    });

    expect(response).toEqual({
      type: 'event',
      id: 'w1',
      payload: {
        type: 'complete',
        result: {
          workflowId: 'wf_1',
          workflowName: 'pipeline',
          state: { done: true },
          duration: 12,
          nodeResults: { start: { output: 'workflow-done', duration: 5 } },
        },
      },
    });
  });

  it('returns error when workflow not found', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'w2',
      payload: { type: 'workflow', name: 'missing', input: 'go' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 'w2',
      error: "Workflow 'missing' not found",
    });
  });

  it('runs swarm successfully', async () => {
    const ctx = mockRouteContext({
      swarms: { team: { strategy: 'round-robin' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 's1',
      payload: { type: 'swarm', name: 'team', input: 'collaborate' },
    });

    expect(response).toEqual({
      type: 'event',
      id: 's1',
      payload: {
        type: 'complete',
        result: {
          swarmId: 'swarm_1',
          swarmName: 'team',
          strategy: 'round-robin',
          output: 'swarm-done',
          agentResults: { a1: { output: 'part', usage: { totalTokens: 5 } } },
          usage: { totalTokens: 42, totalCost: 0.01, elapsedTime: 100 },
        },
      },
    });
  });

  it('returns error when swarm not found', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 's2',
      payload: { type: 'swarm', name: 'nope', input: 'go' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 's2',
      error: "Swarm 'nope' not found",
    });
  });

  it('sends masked error event when runtime.run throws a non-Cogitator error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      type: 'run',
      id: 'err1',
      payload: { type: 'agent', name: 'bot', input: 'hi' },
    });

    expect(response).toEqual({
      type: 'error',
      id: 'err1',
      error: 'Internal server error',
    });
  });

  it('uses default /ws path when no config provided', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port, '/ws');
    await waitForOpen(ws);

    const response = await sendAndWait(ws, { type: 'ping' });
    expect(response).toEqual({ type: 'pong' });
  });

  it('connection close aborts in-progress run', async () => {
    let resolveRun: () => void;
    const runPromise = new Promise<void>((r) => {
      resolveRun = r;
    });

    const run = vi.fn().mockImplementation(() => {
      return runPromise.then(() => ({ output: 'ok' }));
    });

    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        type: 'run',
        id: 'close-test',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      })
    );

    await new Promise((r) => setTimeout(r, 50));

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    resolveRun!();

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('setupWebSocket hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowExecute.mockResolvedValue(workflowResult());
    clients = [];
  });

  afterEach(async () => {
    for (const ws of clients) ws.terminate();
    clients = [];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function expectUpgradeStatus(port: number, path: string, status: number): Promise<void> {
    const outcome = await new Promise<number | 'opened'>((resolve) => {
      const ws = createClient(port, path);
      ws.once('open', () => resolve('opened'));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => {});
    });
    expect(outcome).toBe(status);
  }

  it('rejects the upgrade with 401 when auth throws', async () => {
    const { port } = await createTestServer(mockRouteContext(), {
      auth: (req) => {
        if (req.headers.authorization !== 'Bearer ok') throw new Error('nope');
        return { userId: 'u1' };
      },
    });

    await expectUpgradeStatus(port, '/ws', 401);
  });

  it('accepts the upgrade when auth succeeds', async () => {
    const { port } = await createTestServer(mockRouteContext(), {
      auth: (req) => {
        if (req.headers.authorization !== 'Bearer ok') throw new Error('nope');
        return { userId: 'u1' };
      },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: 'Bearer ok' },
    });
    clients.push(ws);
    await waitForOpen(ws);
    expect(await sendAndWait(ws, { type: 'ping', id: 'p1' })).toEqual({ type: 'pong', id: 'p1' });
  });

  it('runs agents as the user returned by auth for each connection', async () => {
    const ctx = mockRouteContext({ agents: { bot: { name: 'bot' } as never } });
    const { port } = await createTestServer(ctx, {
      auth: (req) => ({ userId: String(req.headers['x-user']) }),
    });

    const connectAs = async (userId: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-user': userId } });
      clients.push(ws);
      await waitForOpen(ws);
      return ws;
    };
    const alice = await connectAs('alice');
    const bob = await connectAs('bob');

    await sendAndWait(alice, {
      type: 'run',
      id: 'a',
      payload: { type: 'agent', name: 'bot', input: 'hi', threadId: 'thread-a' },
    });
    await sendAndWait(bob, {
      type: 'run',
      id: 'b',
      payload: { type: 'agent', name: 'bot', input: 'hi', threadId: 'thread-b' },
    });

    expect(ctx.runtime.run).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ threadId: 'thread-a', userId: 'alice' })
    );
    expect(ctx.runtime.run).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ threadId: 'thread-b', userId: 'bob' })
    );
  });

  it('rejects upgrades on other paths when no other upgrade handler exists', async () => {
    const { port } = await createTestServer(mockRouteContext());
    await expectUpgradeStatus(port, '/elsewhere', 404);
  });

  it('leaves upgrades on other paths to other handlers', async () => {
    const { port } = await createTestServer(mockRouteContext());
    const foreign = vi.fn((_req: unknown, socket: { destroy: () => void }) => socket.destroy());
    server.on('upgrade', foreign);

    const ws = createClient(port, '/other');
    await new Promise<void>((resolve) => {
      ws.once('error', () => resolve());
      ws.once('close', () => resolve());
    });
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it('answers unsupported message types and non-object messages with errors', async () => {
    const { port } = await createTestServer(mockRouteContext());
    const ws = createClient(port);
    await waitForOpen(ws);

    expect(await sendAndWait(ws, { type: 'dance' })).toEqual({
      type: 'error',
      error: 'Unsupported message type: dance',
    });
    expect(await sendAndWait(ws, null)).toEqual({
      type: 'error',
      error: 'Message must be a JSON object',
    });
  });

  it('answers unsupported run types with an error', async () => {
    const { port } = await createTestServer(mockRouteContext());
    const ws = createClient(port);
    await waitForOpen(ws);

    expect(
      await sendAndWait(ws, {
        type: 'run',
        id: 'x1',
        payload: { type: 'pipeline', name: 'p', input: 'hi' },
      })
    ).toEqual({ type: 'error', id: 'x1', error: 'Unsupported run type: pipeline' });
  });

  it('does not resolve prototype members as agents', async () => {
    const ctx = mockRouteContext();
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    expect(
      await sendAndWait(ws, {
        type: 'run',
        id: 'p1',
        payload: { type: 'agent', name: 'constructor', input: 'hi' },
      })
    ).toEqual({ type: 'error', id: 'p1', error: "Agent 'constructor' not found" });
    expect(ctx.runtime.run).not.toHaveBeenCalled();
  });

  it('reports cancelled after stop and accepts a new run right away', async () => {
    const signals: AbortSignal[] = [];
    const run = vi.fn((_agent: unknown, opts: { signal: AbortSignal }) => {
      signals.push(opts.signal);
      if (signals.length === 1) {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve({ output: 'second', usage: {}, toolCalls: [] });
    });
    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    const firstEvents = collectMessages(ws, 1);
    ws.send(
      JSON.stringify({ type: 'run', id: 'a', payload: { type: 'agent', name: 'bot', input: 'x' } })
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    ws.send(JSON.stringify({ type: 'stop' }));

    expect(await firstEvents).toEqual([{ type: 'event', id: 'a', payload: { type: 'cancelled' } }]);
    expect(signals[0].aborted).toBe(true);

    const second = await sendAndWait(ws, {
      type: 'run',
      id: 'b',
      payload: { type: 'agent', name: 'bot', input: 'y' },
    });
    expect(second).toMatchObject({ type: 'event', id: 'b', payload: { type: 'complete' } });
  });

  it('aborts the run signal when the connection closes', async () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn((_agent: unknown, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise(() => {});
    });
    const ctx = mockRouteContext({
      runtime: { run } as unknown as RouteContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({ type: 'run', id: 'a', payload: { type: 'agent', name: 'bot', input: 'x' } })
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    ws.close();

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('forwards threadId to agent runs', async () => {
    const ctx = mockRouteContext({ agents: { bot: { name: 'bot' } as never } });
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    await sendAndWait(ws, {
      type: 'run',
      id: 't',
      payload: { type: 'agent', name: 'bot', input: 'hi', threadId: 'thread-9' },
    });
    expect(ctx.runtime.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 'thread-9' })
    );
  });

  it('reports a failed workflow as an error instead of complete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    workflowExecute.mockResolvedValue(workflowResult({ error: new Error('node failed') }));
    const ctx = mockRouteContext({ workflows: { pipeline: { entryPoint: 'start' } as never } });
    const { port } = await createTestServer(ctx);
    const ws = createClient(port);
    await waitForOpen(ws);

    expect(
      await sendAndWait(ws, {
        type: 'run',
        id: 'w',
        payload: { type: 'workflow', name: 'pipeline', input: 'x' },
      })
    ).toEqual({ type: 'error', id: 'w', error: 'Internal server error' });
  });

  it('terminates clients that miss the pong deadline', async () => {
    const { port } = await createTestServer(mockRouteContext(), {
      pingInterval: 20,
      pingTimeout: 20,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
    clients.push(ws);
    await waitForOpen(ws);

    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
