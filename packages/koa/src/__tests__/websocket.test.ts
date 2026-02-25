import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { setupWebSocket } from '../websocket/handler.js';
import type { RouteContext } from '../types.js';

vi.mock('@cogitator-ai/workflows', () => ({
  WorkflowExecutor: class {
    execute = vi.fn().mockResolvedValue({ output: 'workflow-done' });
  },
}));

vi.mock('@cogitator-ai/swarms', () => ({
  Swarm: class {
    run = vi.fn().mockResolvedValue({ output: 'swarm-done' });
  },
}));

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
      error: 'Invalid run payload',
    });
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
      payload: { type: 'complete', result: { output: 'workflow-done' } },
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
      payload: { type: 'complete', result: { output: 'swarm-done' } },
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

  it('sends error event when runtime.run throws', async () => {
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
      error: 'boom',
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
