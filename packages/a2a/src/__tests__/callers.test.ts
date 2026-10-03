import { describe, it, expect, vi } from 'vitest';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { InMemoryPushNotificationStore } from '../push-notifications';
import type { A2AMessage, A2ATask, AgentRunResult, CogitatorLike } from '../types';
import { expectResponse } from './helpers';

const TOKENS: Record<string, string> = { 'token-ada': 'ada', 'token-bob': 'bob' };

function message(text: string, extra: Partial<A2AMessage> = {}): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }], ...extra };
}

function runResult(): AgentRunResult {
  return {
    output: 'done',
    runId: 'run_1',
    agentId: 'agent_helper',
    threadId: 'thread_1',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

function agent(): Agent {
  const config: AgentConfig = { name: 'helper', model: 'test-model', instructions: 'help' };
  return {
    id: 'agent_helper',
    name: 'helper',
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function setup(validate: (token: string) => Promise<boolean | { userId: string }>) {
  const run = vi.fn<CogitatorLike['run']>().mockResolvedValue(runResult());
  const server = new A2AServer({
    agents: { helper: agent() },
    cogitator: { run },
    auth: { type: 'bearer', validate },
    pushNotificationStore: new InMemoryPushNotificationStore(),
  });
  let id = 0;
  const call = async (token: string, method: string, params: unknown) =>
    expectResponse(await server.handleJsonRpc({ jsonrpc: '2.0', method, params, id: ++id }, token));
  return { server, run, call };
}

const byUser = async (token: string) => {
  const userId = TOKENS[token];
  return userId ? { userId } : false;
};

async function sendAs(
  call: ReturnType<typeof setup>['call'],
  token: string,
  extra: Partial<A2AMessage> = {}
): Promise<A2ATask> {
  const response = await call(token, 'message/send', { message: message('hello', extra) });
  if (response.error) throw new Error(response.error.message);
  return response.result as A2ATask;
}

describe('A2A callers', () => {
  it('runs as the caller and keeps the owner out of the task it returns', async () => {
    const { run, call } = setup(byUser);

    const task = await sendAs(call, 'token-ada');

    expect(run.mock.calls[0][1]).toMatchObject({ userId: 'ada', threadId: task.contextId });
    expect(task.metadata).toBeUndefined();
  });

  it("hides one user's tasks from another", async () => {
    const { call } = setup(byUser);
    const task = await sendAs(call, 'token-ada');

    const get = await call('token-bob', 'tasks/get', { id: task.id });
    const cancel = await call('token-bob', 'tasks/cancel', { id: task.id });
    const push = await call('token-bob', 'tasks/pushNotification/list', { taskId: task.id });
    const bobList = await call('token-bob', 'tasks/list', {});
    const adaList = await call('token-ada', 'tasks/list', {});

    expect(get.error?.code).toBe(-32001);
    expect(cancel.error?.code).toBe(-32001);
    expect(push.error?.code).toBe(-32001);
    expect((bobList.result as { tasks: A2ATask[] }).tasks).toEqual([]);
    expect((adaList.result as { tasks: A2ATask[] }).tasks.map((t) => t.id)).toEqual([task.id]);
    expect((await call('token-ada', 'tasks/get', { id: task.id })).error).toBeUndefined();
  });

  it("refuses to continue another user's task or join their context", async () => {
    const { run, call } = setup(byUser);
    const task = await sendAs(call, 'token-ada');

    const continued = await call('token-bob', 'message/send', {
      message: message('mine now', { taskId: task.id }),
    });
    const joined = await call('token-bob', 'message/send', {
      message: message('hi', { contextId: task.contextId }),
    });

    expect(continued.error?.code).toBe(-32001);
    expect(joined.error?.message).toContain('Unknown contextId');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps every caller in one shared space when validate returns true', async () => {
    const { run, call } = setup(async (token) => token in TOKENS);
    const task = await sendAs(call, 'token-ada');

    const get = await call('token-bob', 'tasks/get', { id: task.id });

    expect(get.error).toBeUndefined();
    expect(run.mock.calls[0][1]).not.toHaveProperty('userId');
  });

  it('rejects credentials validate refuses', async () => {
    const { call } = setup(byUser);

    const response = await call('token-eve', 'tasks/list', {});

    expect(response.error?.message).toBe('Unauthorized: Invalid credentials');
  });

  it('scopes streamed runs to the caller', async () => {
    const { server, run, call } = setup(byUser);
    const task = await sendAs(call, 'token-ada');

    const events = [];
    for await (const event of server.handleJsonRpcStream(
      {
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: message('again', { taskId: task.id }) },
        id: 9,
      },
      'token-bob'
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'status-update', status: { state: 'failed' } });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
