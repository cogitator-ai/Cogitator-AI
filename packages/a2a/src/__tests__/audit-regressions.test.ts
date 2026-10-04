import { describe, it, expect, vi } from 'vitest';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { TaskManager } from '../task-manager';
import { InMemoryTaskStore } from '../task-store';
import { RedisTaskStore, type RedisClientLike } from '../redis-task-store';
import type {
  A2AMessage,
  A2AStreamEvent,
  A2ATask,
  AgentRunResult,
  CogitatorLike,
  TaskStore,
} from '../types';

type RunOptions = Parameters<CogitatorLike['run']>[1];

function userMessage(text: string, extra?: Partial<A2AMessage>): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }], ...extra };
}

function runResult(output: string, extra?: Partial<AgentRunResult>): AgentRunResult {
  return {
    output,
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
    ...extra,
  };
}

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

function rpc(method: string, params: unknown, id = 1) {
  return { jsonrpc: '2.0' as const, method, params, id };
}

async function collect(stream: AsyncGenerator<A2AStreamEvent>): Promise<A2AStreamEvent[]> {
  const events: A2AStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function taskManagerOf(server: A2AServer): TaskManager {
  return Reflect.get(server, 'taskManager') as TaskManager;
}

describe('streaming', () => {
  it('delivers artifact updates before the final completed status', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('answer', { structured: { ok: true } }) },
    });

    const events = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('hi') }))
    );

    const types = events.map((e) => (e.type === 'status-update' ? e.status.state : e.type));
    expect(types).toEqual(['working', 'artifact-update', 'artifact-update', 'completed']);
  });

  it('closes the stream on input-required without a spurious failure', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('Which city?', { requiresInput: true }) },
    });

    const events = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('weather') }))
    );
    const statuses = events.flatMap((e) => (e.type === 'status-update' ? [e.status.state] : []));

    expect(statuses).toEqual(['working', 'input-required']);
  });

  it('reports continuation errors as a failed event and leaks no listeners', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });
    const manager = taskManagerOf(server);
    const baseline = manager.listenerCount('event');

    const events = await collect(
      server.handleJsonRpcStream(
        rpc('message/stream', { message: userMessage('more', { taskId: 'task_missing' }) })
      )
    );

    expect(events).toHaveLength(1);
    expect(events[0].type === 'status-update' && events[0].status.state).toBe('failed');
    expect(manager.listenerCount('event')).toBe(baseline);
  });

  it('fails instead of hanging when execution rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = new InMemoryTaskStore();
    let updates = 0;
    const flakyStore: TaskStore = {
      create: (task) => inner.create(task),
      get: (id) => inner.get(id),
      list: (filter) => inner.list(filter),
      delete: (id) => inner.delete(id),
      update: async () => {
        updates++;
        throw new Error(`store unavailable (${updates})`);
      },
    };
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('done') },
      taskStore: flakyStore,
    });

    const events = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('hi') }))
    );
    const last = events.at(-1);

    expect(last?.type === 'status-update' && last.status.state).toBe('failed');
    expect(last?.type === 'status-update' && last.status.message).toBe('Internal error');
    expect(String(consoleError.mock.calls.at(-1)?.[2])).toContain('store unavailable');
    consoleError.mockRestore();
  });

  it('aborts the agent run when the client signal aborts', async () => {
    let runSignal: AbortSignal | undefined;
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: {
        run: (_agent, options) =>
          new Promise<AgentRunResult>((_resolve, reject) => {
            runSignal = options.signal;
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
    });
    const controller = new AbortController();
    const stream = server.handleJsonRpcStream(
      rpc('message/stream', { message: userMessage('slow') }),
      undefined,
      controller.signal
    );

    const first = await stream.next();
    expect(first.done).toBe(false);

    const pending = stream.next();
    controller.abort();
    const result = await pending;

    expect(result.done).toBe(true);
    expect(runSignal?.aborted).toBe(true);
  });

  it('does not abort a running task when a concurrent continuation is rejected', async () => {
    let release: (() => void) | undefined;
    const runs: AbortSignal[] = [];
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: {
        run: (_agent, options) => {
          if (options.signal) runs.push(options.signal);
          if (runs.length === 1) return Promise.resolve(runResult('first'));
          return new Promise<AgentRunResult>((resolve) => {
            release = () => resolve(runResult('second'));
          });
        },
      },
    });

    const sent = await server.handleJsonRpc(rpc('message/send', { message: userMessage('a') }));
    const taskId = (sent!.result as A2ATask).id;

    const running = server.handleJsonRpcStream(
      rpc('message/stream', { message: userMessage('b', { taskId }) })
    );
    await running.next();
    await vi.waitFor(() => expect(release).toBeDefined());

    const rejected = await collect(
      server.handleJsonRpcStream(rpc('message/stream', { message: userMessage('c', { taskId }) }))
    );
    expect(rejected[0].type === 'status-update' && rejected[0].status.state).toBe('failed');
    expect(runs[1].aborted).toBe(false);

    release!();
    const rest = await collect(running);
    const last = rest.at(-1);
    expect(last?.type === 'status-update' && last.status.state).toBe('completed');
  });
});

describe('multi-turn execution', () => {
  it('replays the task transcript and threads runs by contextId', async () => {
    const calls: RunOptions[] = [];
    const cogitator: CogitatorLike = {
      run: async (_agent, options) => {
        calls.push(options);
        return runResult(calls.length === 1 ? 'Paris is the capital.' : 'About 2 million.');
      },
    };
    const server = new A2AServer({ agents: { helper: mockAgent() }, cogitator });

    const first = await server.handleJsonRpc(
      rpc('message/send', { message: userMessage('Capital of France?') })
    );
    const task = first!.result as A2ATask;
    await server.handleJsonRpc(
      rpc('message/send', { message: userMessage('Its population?', { taskId: task.id }) })
    );

    expect(calls[0].input).toBe('Capital of France?');
    expect(calls[0].threadId).toBe(task.contextId);
    expect(calls[0].loadHistory).toBeUndefined();

    expect(calls[1].input).toContain('User: Capital of France?');
    expect(calls[1].input).toContain('Agent: Paris is the capital.');
    expect(calls[1].input).toContain('User: Its population?');
    expect(calls[1].threadId).toBe(task.contextId);
    expect(calls[1].loadHistory).toBe(false);
  });

  it('accumulates artifacts across turns', async () => {
    let turn = 0;
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult(`answer ${++turn}`) },
    });

    const first = await server.handleJsonRpc(rpc('message/send', { message: userMessage('1') }));
    const taskId = (first!.result as A2ATask).id;
    const second = await server.handleJsonRpc(
      rpc('message/send', { message: userMessage('2', { taskId }) })
    );
    const task = second!.result as A2ATask;

    expect(task.artifacts.map((a) => a.parts[0])).toEqual([
      { type: 'text', text: 'answer 1' },
      { type: 'text', text: 'answer 2' },
    ]);
  });

  it('passes data and file parts to the agent', async () => {
    const inputs: string[] = [];
    const manager = new TaskManager();
    const message: A2AMessage = {
      role: 'user',
      parts: [
        { type: 'text', text: 'Summarize' },
        { type: 'data', mimeType: 'application/json', data: { total: 3 } },
        { type: 'file', uri: 'https://x.test/a.pdf', mimeType: 'application/pdf', name: 'a.pdf' },
      ],
    };
    const task = await manager.createTask(message);

    await manager.executeTask(
      task,
      {
        run: async (_agent, options) => {
          inputs.push(options.input);
          return runResult('ok');
        },
      },
      {},
      message
    );

    expect(inputs[0]).toContain('Summarize');
    expect(inputs[0]).toContain('"total": 3');
    expect(inputs[0]).toContain('[file a.pdf (application/pdf): https://x.test/a.pdf]');
  });

  it('rejects a second concurrent continuation of the same task', async () => {
    const manager = new TaskManager();
    const msg = userMessage('start');
    const task = await manager.createTask(msg);
    await manager.executeTask(task, { run: async () => runResult('done') }, {}, msg);

    const results = await Promise.allSettled([
      manager.continueTask(task.id, userMessage('a')),
      manager.continueTask(task.id, userMessage('b')),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('forwards the configured timeout to the agent run', async () => {
    const run = vi.fn(async (_agent: unknown, _options: RunOptions) => runResult('ok'));
    const server = new A2AServer({ agents: { helper: mockAgent() }, cogitator: { run } });

    await server.handleJsonRpc(
      rpc('message/send', { message: userMessage('hi'), configuration: { timeout: 1234 } })
    );

    expect(run.mock.calls[0][1].timeout).toBe(1234);
  });
});

describe('message/send configuration', () => {
  it('returns immediately for blocking: false and finishes in the background', async () => {
    let release: (() => void) | undefined;
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: {
        run: () =>
          new Promise<AgentRunResult>((resolve) => {
            release = () => resolve(runResult('later'));
          }),
      },
    });

    const response = await server.handleJsonRpc(
      rpc('message/send', { message: userMessage('go'), configuration: { blocking: false } })
    );
    const task = response!.result as A2ATask;
    expect(task.status.state).toBe('working');

    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await vi.waitFor(async () => {
      const current = await server.handleJsonRpc(rpc('tasks/get', { id: task.id }));
      expect((current!.result as A2ATask).status.state).toBe('completed');
    });
  });

  it('applies historyLength and acceptedOutputModes', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('text', { structured: { a: 1 } }) },
    });

    const response = await server.handleJsonRpc(
      rpc('message/send', {
        message: userMessage('q'),
        configuration: { historyLength: 1, acceptedOutputModes: ['application/json'] },
      })
    );
    const task = response!.result as A2ATask;

    expect(task.history).toHaveLength(1);
    expect(task.history[0].role).toBe('agent');
    expect(task.artifacts.map((a) => a.mimeType)).toEqual(['application/json']);

    const fetched = await server.handleJsonRpc(rpc('tasks/get', { id: task.id, historyLength: 0 }));
    expect((fetched!.result as A2ATask).history).toEqual([]);
    expect((fetched!.result as A2ATask).artifacts).toHaveLength(2);
  });

  it('rejects invalid historyLength values', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });
    const response = await server.handleJsonRpc(
      rpc('message/send', { message: userMessage('q'), configuration: { historyLength: -1 } })
    );
    expect(response!.error!.code).toBe(-32602);
  });

  it('registers pushNotificationConfig before execution', async () => {
    const created: string[] = [];
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      pushNotificationStore: {
        create: async (taskId, config) => {
          created.push(taskId);
          return { ...config, id: 'pnc_1' };
        },
        get: async () => null,
        list: async () => [],
        delete: async () => {},
      },
    });

    const response = await server.handleJsonRpc(
      rpc('message/send', {
        message: userMessage('q'),
        configuration: { pushNotificationConfig: { webhookUrl: 'https://hooks.example.com/a' } },
      })
    );

    expect(created).toEqual([(response!.result as A2ATask).id]);
  });

  it('rejects a private pushNotificationConfig without creating a task', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });

    const response = await server.handleJsonRpc(
      rpc('message/send', {
        message: userMessage('q'),
        configuration: { pushNotificationConfig: { webhookUrl: 'http://127.0.0.2/hook' } },
      })
    );
    const listed = await server.handleJsonRpc(rpc('tasks/list', {}));

    expect(response!.error!.code).toBe(-32602);
    expect((listed!.result as { tasks: A2ATask[] }).tasks).toEqual([]);
  });

  it('validates and caps tasks/list paging', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });

    const bad = await server.handleJsonRpc(rpc('tasks/list', { limit: -5 }));
    expect(bad!.error!.code).toBe(-32602);

    const ok = await server.handleJsonRpc(rpc('tasks/list', { limit: 10, offset: 0 }));
    expect(ok!.error).toBeUndefined();
  });

  it('returns no response for JSON-RPC notifications', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
    });
    expect(
      await server.handleJsonRpc({ jsonrpc: '2.0', method: 'tasks/list', params: {} })
    ).toBeNull();
  });
});

describe('authentication', () => {
  const bearerServer = () =>
    new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      auth: { type: 'bearer', validate: async (token) => token === 'secret' },
    });

  it('extracts bearer tokens from the Authorization header', () => {
    const server = bearerServer();
    const headers: Record<string, string> = { authorization: 'Bearer secret' };
    expect(server.getAuthToken((name) => headers[name])).toBe('secret');
    expect(server.getAuthToken(() => 'Basic abc')).toBeUndefined();
    expect(server.getAuthToken(() => undefined)).toBeUndefined();
  });

  it('extracts API keys from the configured header', () => {
    const server = new A2AServer({
      agents: { helper: mockAgent() },
      cogitator: { run: async () => runResult('x') },
      auth: { type: 'apiKey', headerName: 'x-agent-key', validate: async (k) => k === 'k1' },
    });
    const headers: Record<string, string> = { 'x-agent-key': 'k1' };
    expect(server.getAuthToken((name) => headers[name])).toBe('k1');
  });

  it('advertises the security scheme on the agent card', () => {
    const card = bearerServer().getAgentCard();
    expect(card.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } });
    expect(card.security).toEqual([{ bearer: [] }]);
  });

  it('rejects missing or invalid credentials and accepts valid ones', async () => {
    const server = bearerServer();
    const request = rpc('tasks/list', {});

    expect((await server.handleJsonRpc(request))!.error!.code).toBe(-32000);
    expect((await server.handleJsonRpc(request, 'wrong'))!.error!.code).toBe(-32000);
    expect((await server.handleJsonRpc(request, 'secret'))!.error).toBeUndefined();
  });
});

describe('task stores', () => {
  it('restores empty arrays that Redis Lua cjson encodes as objects', async () => {
    const data = new Map<string, string>();
    const client: RedisClientLike = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => data.set(key, value),
      del: async (key) => data.delete(key),
      keys: async () => Array.from(data.keys()),
      eval: async (_script, _numKeys, key, update) => {
        const existing = JSON.parse(data.get(key) ?? '{}') as Record<string, unknown>;
        const merged = { ...existing, ...(JSON.parse(update) as Record<string, unknown>) };
        data.set(key, JSON.stringify(merged).replaceAll('[]', '{}'));
        return 1;
      },
    };
    const store = new RedisTaskStore({ client });
    const task: A2ATask = {
      id: 't1',
      contextId: 'c1',
      status: { state: 'working', timestamp: new Date().toISOString() },
      history: [userMessage('hi')],
      artifacts: [],
    };
    await store.create(task);
    await store.update('t1', { status: { state: 'completed', timestamp: task.status.timestamp } });

    const loaded = await store.get('t1');
    expect(loaded?.artifacts).toEqual([]);
    expect(Array.isArray(loaded?.artifacts)).toBe(true);
    expect((await store.list())[0].artifacts).toEqual([]);
  });

  it('evicts finished tasks before active ones', async () => {
    const store = new InMemoryTaskStore({ maxSize: 2 });
    const at = (iso: string, state: A2ATask['status']['state'], id: string): A2ATask => ({
      id,
      contextId: 'c',
      status: { state, timestamp: iso },
      history: [],
      artifacts: [],
    });

    await store.create(at('2026-01-01T00:00:00Z', 'working', 'active-old'));
    await store.create(at('2026-01-02T00:00:00Z', 'completed', 'done'));
    await store.create(at('2026-01-03T00:00:00Z', 'working', 'active-new'));

    expect(await store.get('active-old')).not.toBeNull();
    expect(await store.get('done')).toBeNull();
    expect(await store.get('active-new')).not.toBeNull();
  });
});
