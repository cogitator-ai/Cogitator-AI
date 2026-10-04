import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { A2AError, taskNotFound } from '../errors';
import { InMemoryTaskStore } from '../task-store';
import { InMemoryPushNotificationStore } from '../push-notifications';
import { buildSseErrorEvent } from '../adapters/sse-error-event';
import { a2aHono } from '../adapters/hono';
import { expectResponse } from './helpers';
import type { A2AMessage, A2AStreamEvent, AgentRunResult, TaskStore } from '../types';

const SECRET = 'connect ECONNREFUSED 10.0.0.5:6379';

function mockAgent(name = 'helper'): Agent {
  const config: AgentConfig = { name, model: 'test', instructions: 'test', description: name };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function runResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

function userMessage(text: string): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

function rpc(method: string, params: unknown) {
  return { jsonrpc: '2.0' as const, method, params, id: 1 };
}

async function collect(stream: AsyncGenerator<A2AStreamEvent>): Promise<A2AStreamEvent[]> {
  const events: A2AStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function failingStore(method: keyof TaskStore): TaskStore {
  const inner = new InMemoryTaskStore();
  return {
    create: (task) => inner.create(task),
    get: (id) => inner.get(id),
    update: (id, update) => inner.update(id, update),
    list: (filter) => inner.list(filter),
    delete: (id) => inner.delete(id),
    [method]: async () => {
      throw new Error(SECRET);
    },
  };
}

function lastStatusMessage(events: A2AStreamEvent[]): string | undefined {
  const last = events.at(-1);
  return last?.type === 'status-update' ? last.status.message : undefined;
}

let consoleError: MockInstance<typeof console.error>;

function silenceConsole(): MockInstance<typeof console.error> {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  return consoleError;
}

afterEach(() => {
  consoleError?.mockRestore();
});

describe('JSON-RPC error masking', () => {
  it('answers a failing task store with a bare internal error and logs it', async () => {
    const logged = silenceConsole();
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      taskStore: failingStore('get'),
    });

    const response = expectResponse(await server.handleJsonRpc(rpc('tasks/get', { id: 't1' })));

    expect(response.error).toEqual({ code: -32603, message: 'Internal error' });
    expect(JSON.stringify(response)).not.toContain('10.0.0.5');
    expect(String(logged.mock.calls[0]?.[2])).toContain(SECRET);
  });

  it('keeps A2A errors as they are', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });

    const response = expectResponse(await server.handleJsonRpc(rpc('tasks/get', { id: 'nope' })));

    expect(response.error).toEqual(taskNotFound('nope'));
  });

  it('masks an auth validator that throws, on requests and on streams', async () => {
    silenceConsole();
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      auth: {
        type: 'bearer',
        validate: async () => {
          throw new Error(SECRET);
        },
      },
    });

    const response = expectResponse(await server.handleJsonRpc(rpc('tasks/list', {}), 'token'));
    const events = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('hi') }), 'token')
    );

    expect(response.error).toEqual({ code: -32603, message: 'Internal error' });
    expect(lastStatusMessage(events)).toBe('Internal error');
  });

  it('passes the message of a CogitatorError through', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      taskStore: {
        ...failingStore('get'),
        get: async () => {
          throw new CogitatorError({ message: 'store busy', code: ErrorCode.MEMORY_UNAVAILABLE });
        },
      },
    });

    const response = expectResponse(await server.handleJsonRpc(rpc('tasks/get', { id: 't1' })));

    expect(response.error).toEqual({ code: -32603, message: 'Internal error: store busy' });
  });
});

describe('stream error masking', () => {
  it('reports a task that cannot be created as an internal error', async () => {
    silenceConsole();
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      taskStore: failingStore('create'),
    });

    const events = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('hi') }))
    );

    expect(lastStatusMessage(events)).toBe('Internal error');
  });

  it('reports a failed agent run without the text of the error', async () => {
    silenceConsole();
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: {
        run: async () => {
          throw new Error(SECRET);
        },
      },
    });

    const events = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('hi') }))
    );

    expect(lastStatusMessage(events)).toBe('Internal error');
    expect(JSON.stringify(events)).not.toContain('10.0.0.5');
  });

  it('fails the task without the text of a push store error', async () => {
    silenceConsole();
    const pushNotificationStore = new InMemoryPushNotificationStore();
    vi.spyOn(pushNotificationStore, 'create').mockRejectedValue(new Error(SECRET));
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      pushNotificationStore,
      allowPrivateUrls: true,
    });

    const response = expectResponse(
      await server.handleJsonRpc(
        rpc('message/send', {
          message: userMessage('hi'),
          configuration: { pushNotificationConfig: { webhookUrl: 'http://127.0.0.1/hook' } },
        })
      )
    );
    const tasks = expectResponse(await server.handleJsonRpc(rpc('tasks/list', {})));

    expect(response.error).toEqual({ code: -32603, message: 'Internal error' });
    expect(JSON.stringify(tasks)).toContain('"message":"Failed to register push notification"');
    expect(JSON.stringify(tasks)).not.toContain('10.0.0.5');
  });

  it('builds adapter SSE error events without the text of internal errors', () => {
    silenceConsole();
    const internal = buildSseErrorEvent(new Error(SECRET));
    const deliberate = buildSseErrorEvent(new A2AError(taskNotFound('t1')));

    expect(internal.type === 'status-update' && internal.status.message).toBe('Internal error');
    expect(deliberate.type === 'status-update' && deliberate.status.message).toBe(
      'Task not found: t1'
    );
  });

  it('answers an adapter-level failure with a bare internal error', async () => {
    silenceConsole();
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });
    vi.spyOn(server, 'handleJsonRpc').mockRejectedValue(new Error(SECRET));

    const response = await a2aHono(server).request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpc('tasks/list', {})),
    });

    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  });
});
