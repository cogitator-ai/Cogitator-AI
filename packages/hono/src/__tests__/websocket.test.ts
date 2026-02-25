import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleWebSocketMessage,
  createClientState,
  createWebSocketRoutes,
} from '../websocket/handler.js';
import type { CogitatorContext } from '../types.js';

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

function mockSocket() {
  const messages: string[] = [];
  return {
    socket: {
      send: vi.fn((data: string) => messages.push(data)),
      readyState: 1,
    },
    messages,
    getResponses: () => messages.map((m) => JSON.parse(m)),
  };
}

function mockContext(overrides: Partial<CogitatorContext> = {}): CogitatorContext {
  return {
    runtime: {
      run: vi.fn().mockResolvedValue({ output: 'agent-result', usage: { totalTokens: 10 } }),
    } as unknown as CogitatorContext['runtime'],
    agents: {},
    workflows: {},
    swarms: {},
    ...overrides,
  };
}

describe('createClientState', () => {
  it('returns object with id starting with ws_', () => {
    const state = createClientState();
    expect(state.id).toMatch(/^ws_/);
  });

  it('has no abortController initially', () => {
    const state = createClientState();
    expect(state).not.toHaveProperty('abortController');
  });
});

describe('handleWebSocketMessage', () => {
  let ctx: CogitatorContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = mockContext();
  });

  it('responds with pong on ping', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(socket, JSON.stringify({ type: 'ping' }), ctx, state);

    expect(getResponses()).toEqual([{ type: 'pong' }]);
  });

  it('responds with error on invalid JSON', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(socket, 'not{json', ctx, state);

    expect(getResponses()).toEqual([{ type: 'error', error: 'Invalid JSON message' }]);
  });

  it('responds with error when run payload is missing fields', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({ type: 'run', id: 'r1', payload: { type: 'agent' } }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('error');
    expect(responses[0].id).toBe('r1');
    expect(responses[0].error).toBe('Invalid run payload');
  });

  it('responds with error when agent not found', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'r2',
        payload: { type: 'agent', name: 'ghost', input: 'hello' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('error');
    expect(responses[0].error).toBe("Agent 'ghost' not found");
  });

  it('streams token events and completes on successful agent run', async () => {
    const run = vi.fn().mockImplementation((_agent: unknown, opts: Record<string, unknown>) => {
      const onToken = opts.onToken as (t: string) => void;
      onToken('Hello');
      onToken(' world');
      return Promise.resolve({ output: 'Hello world', usage: { totalTokens: 5 } });
    });

    ctx = mockContext({
      runtime: { run } as unknown as CogitatorContext['runtime'],
      agents: { writer: { name: 'writer' } as never },
    });

    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'r3',
        payload: { type: 'agent', name: 'writer', input: 'write something' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(3);
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
      payload: { type: 'complete', result: { output: 'Hello world', usage: { totalTokens: 5 } } },
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

    ctx = mockContext({
      runtime: { run } as unknown as CogitatorContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'r4',
        payload: { type: 'agent', name: 'bot', input: 'search' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses[0].payload).toEqual({
      type: 'tool-call',
      id: 'tc1',
      name: 'search',
      arguments: { q: 'test' },
    });
    expect(responses[1].payload).toEqual({
      type: 'tool-result',
      callId: 'tc1',
      result: 'found it',
    });
  });

  it('responds with error when workflow not found', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'w1',
        payload: { type: 'workflow', name: 'missing', input: 'go' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('error');
    expect(responses[0].error).toBe("Workflow 'missing' not found");
  });

  it('runs workflow successfully', async () => {
    ctx = mockContext({
      workflows: { pipeline: { entryPoint: 'start' } as never },
    });

    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'w2',
        payload: { type: 'workflow', name: 'pipeline', input: 'data' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('event');
    expect(responses[0].payload.type).toBe('complete');
    expect(responses[0].payload.result).toEqual({ output: 'workflow-done' });
  });

  it('responds with error when swarm not found', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 's1',
        payload: { type: 'swarm', name: 'nope', input: 'go' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('error');
    expect(responses[0].error).toBe("Swarm 'nope' not found");
  });

  it('runs swarm successfully', async () => {
    ctx = mockContext({
      swarms: { team: { strategy: 'round-robin' } as never },
    });

    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 's2',
        payload: { type: 'swarm', name: 'team', input: 'collaborate' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('event');
    expect(responses[0].payload.type).toBe('complete');
    expect(responses[0].payload.result).toEqual({ output: 'swarm-done' });
  });

  it('rejects concurrent runs', async () => {
    const { socket, getResponses } = mockSocket();
    const state = createClientState();
    state.abortController = new AbortController();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'dup',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      }),
      ctx,
      state
    );

    const responses = getResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe('error');
    expect(responses[0].error).toBe('A run is already in progress');
  });

  it('stop aborts the controller', async () => {
    const { socket } = mockSocket();
    const state = createClientState();
    const controller = new AbortController();
    state.abortController = controller;

    await handleWebSocketMessage(socket, JSON.stringify({ type: 'stop' }), ctx, state);

    expect(controller.signal.aborted).toBe(true);
    expect(state.abortController).toBeUndefined();
  });

  it('clears abortController after run completes', async () => {
    ctx = mockContext({
      agents: { bot: { name: 'bot' } as never },
    });

    const { socket } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'fin',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      }),
      ctx,
      state
    );

    expect(state.abortController).toBeUndefined();
  });

  it('clears abortController after run fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    ctx = mockContext({
      runtime: { run } as unknown as CogitatorContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { socket } = mockSocket();
    const state = createClientState();

    await handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'err',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      }),
      ctx,
      state
    );

    expect(state.abortController).toBeUndefined();
  });

  it('does not send when socket is closed', async () => {
    const { socket } = mockSocket();
    socket.readyState = 3;
    const state = createClientState();

    await handleWebSocketMessage(socket, JSON.stringify({ type: 'ping' }), ctx, state);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('sends cancelled event when aborted during run', async () => {
    const run = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    ctx = mockContext({
      runtime: { run } as unknown as CogitatorContext['runtime'],
      agents: { bot: { name: 'bot' } as never },
    });

    const { socket, getResponses } = mockSocket();
    const state = createClientState();

    const runPromise = handleWebSocketMessage(
      socket,
      JSON.stringify({
        type: 'run',
        id: 'abort1',
        payload: { type: 'agent', name: 'bot', input: 'hi' },
      }),
      ctx,
      state
    );

    state.abortController?.abort();
    await runPromise;

    const responses = getResponses();
    const cancelled = responses.find((r) => r.type === 'event' && r.payload?.type === 'cancelled');
    expect(cancelled).toBeTruthy();
    expect(cancelled!.id).toBe('abort1');
  });
});

describe('createWebSocketRoutes', () => {
  it('GET /ws returns 501', async () => {
    const app = createWebSocketRoutes();
    const res = await app.request('/ws');
    expect(res.status).toBe(501);
    const body = await res.text();
    expect(body).toContain('WebSocket');
  });
});
