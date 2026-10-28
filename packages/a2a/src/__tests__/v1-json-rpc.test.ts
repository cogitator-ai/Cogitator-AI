import { describe, it, expect, afterEach } from 'vitest';
import { A2AServer } from '../server';
import { A2A_ERROR_CODES } from '../errors';
import { InMemoryTaskStore } from '../task-store';
import { TASK_AGENT_KEY } from '../ownership';
import { DATA_VALUE_KEY } from '../v1/translate';
import type { A2ATask, AgentCard } from '../types';
import type { V1ErrorDetail, V1StreamResponse, V1Task } from '../v1/types';
import { collect, expectResponse, userMessage } from './helpers';
import {
  echoCogitator,
  mockAgent,
  rpc,
  serveExpress,
  sseData,
  v1UserMessage,
  type Served,
} from './v1-helpers';

const V1 = { protocolVersion: '1.0' } as const;

function request(method: string, params?: unknown, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) };
}

function newServer(overrides: Partial<ConstructorParameters<typeof A2AServer>[0]> = {}) {
  const cogitator = echoCogitator();
  const server = new A2AServer({
    agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
    cogitator,
    allowPrivateUrls: true,
    ...overrides,
  });
  return { server, cogitator };
}

async function send(server: A2AServer, text: string, options = {}): Promise<V1Task> {
  const response = expectResponse(
    await server.handleJsonRpc(
      request('SendMessage', { message: v1UserMessage(text) }),
      undefined,
      { ...V1, ...options }
    )
  );
  expect(response.error).toBeUndefined();
  return (response.result as { task: V1Task }).task;
}

function errorInfo(data: unknown): Extract<V1ErrorDetail, { reason: string }> | undefined {
  return (data as V1ErrorDetail[]).find(
    (detail): detail is Extract<V1ErrorDetail, { reason: string }> =>
      detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
  );
}

describe('A2A 1.0 JSON-RPC methods', () => {
  it('SendMessage answers { task } in ProtoJSON form, without kind or final', async () => {
    const { server } = newServer();
    const task = await send(server, 'ping');
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts?.[0].parts).toEqual([{ text: 'helper heard: ping' }]);
    expect(task.history?.map((message) => message.role)).toEqual(['ROLE_USER', 'ROLE_AGENT']);
    expect(JSON.stringify(task)).not.toMatch(/"kind"|"final"/);
  });

  it('reads camelCase and snake_case fields, enums by name or number', async () => {
    const { server } = newServer();
    const response = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', {
          message: { message_id: 'm-1', role: 1, parts: [{ text: 'snake' }], context_id: 'ctx-s' },
          configuration: { history_length: 1, return_immediately: false },
        }),
        undefined,
        V1
      )
    );
    const task = (response.result as { task: V1Task }).task;
    expect(task.contextId).toBe('ctx-s');
    expect(task.history).toHaveLength(1);
  });

  it('keeps scalar data parts and bytes through the 0.3-shaped store', async () => {
    const { server } = newServer();
    const task = await send(server, 'x');
    const response = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', {
          message: {
            messageId: 'm-data',
            role: 'ROLE_USER',
            parts: [
              { data: 42 },
              { data: ['a', 'b'] },
              { raw: 'aGk_-w', mediaType: 'application/octet-stream', filename: 'b.bin' },
            ],
            contextId: task.contextId,
          },
        }),
        undefined,
        V1
      )
    );
    const created = (response.result as { task: V1Task }).task;
    expect(created.history?.[0].parts).toEqual([
      { data: 42 },
      { data: ['a', 'b'] },
      { raw: 'aGk/+w==', mediaType: 'application/octet-stream', filename: 'b.bin' },
    ]);

    const legacy = expectResponse(
      await server.handleJsonRpc(request('tasks/get', { id: created.id }))
    ).result as A2ATask;
    expect(legacy.history?.[0].parts[0]).toEqual({
      kind: 'data',
      data: { value: 42 },
      metadata: { [DATA_VALUE_KEY]: true },
    });
    expect(legacy.history?.[0].parts[2]).toEqual({
      kind: 'file',
      file: { bytes: 'aGk/+w==', mimeType: 'application/octet-stream', name: 'b.bin' },
    });
  });

  it('GetTask omits the history for historyLength 0 and trims it otherwise', async () => {
    const { server } = newServer();
    const task = await send(server, 'ping');
    const none = expectResponse(
      await server.handleJsonRpc(
        request('GetTask', { id: task.id, historyLength: 0 }),
        undefined,
        V1
      )
    ).result as V1Task;
    expect(none).not.toHaveProperty('history');
    const last = expectResponse(
      await server.handleJsonRpc(
        request('GetTask', { id: task.id, historyLength: 1 }),
        undefined,
        V1
      )
    ).result as V1Task;
    expect(last.history?.map((message) => message.role)).toEqual(['ROLE_AGENT']);
  });

  it('reports errors with google.rpc details in data', async () => {
    const { server } = newServer();
    const missing = expectResponse(
      await server.handleJsonRpc(request('GetTask', { id: 'nope' }), undefined, V1)
    );
    expect(missing.error?.code).toBe(A2A_ERROR_CODES.taskNotFound);
    expect(errorInfo(missing.error?.data)).toEqual({
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'TASK_NOT_FOUND',
      domain: 'a2a-protocol.org',
      metadata: { taskId: 'nope' },
    });

    const invalid = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [] } }),
        undefined,
        V1
      )
    );
    expect(invalid.error?.code).toBe(A2A_ERROR_CODES.invalidParams);
    expect(invalid.error?.data).toContainEqual({
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'message.parts', description: 'at least one part is required' }],
    });

    const unknown = expectResponse(
      await server.handleJsonRpc(request('message/send', {}), undefined, V1)
    );
    expect(unknown.error?.code).toBe(A2A_ERROR_CODES.methodNotFound);
    expect(errorInfo(unknown.error?.data)?.reason).toBe('METHOD_NOT_FOUND');
  });

  it('refuses a message to a task that ended with UnsupportedOperationError', async () => {
    const { server } = newServer();
    const task = await send(server, 'ping');
    const response = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', { message: v1UserMessage('again', { taskId: task.id }) }),
        undefined,
        V1
      )
    );
    expect(response.error?.code).toBe(A2A_ERROR_CODES.unsupportedOperation);
    expect(errorInfo(response.error?.data)?.reason).toBe('UNSUPPORTED_OPERATION');

    const legacy = expectResponse(
      await server.handleJsonRpc(
        request('message/send', { message: userMessage('again', { taskId: task.id }) })
      )
    );
    expect(legacy.error?.code).toBe(A2A_ERROR_CODES.invalidRequest);
    expect(legacy.error?.data).toEqual({ taskId: task.id, state: 'completed' });
  });

  it('CancelTask cancels a running task and refuses an ended one', async () => {
    const { server, cogitator } = newServer();
    const running = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', {
          message: v1UserMessage('slow'),
          configuration: { returnImmediately: true },
        }),
        undefined,
        V1
      )
    ).result as { task: V1Task };
    expect(running.task.status.state).toBe('TASK_STATE_SUBMITTED');
    const canceled = expectResponse(
      await server.handleJsonRpc(request('CancelTask', { id: running.task.id }), undefined, V1)
    ).result as V1Task;
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');
    cogitator.release();

    const again = expectResponse(
      await server.handleJsonRpc(request('CancelTask', { id: running.task.id }), undefined, V1)
    );
    expect(again.error?.code).toBe(A2A_ERROR_CODES.taskNotCancelable);
  });

  it('SendStreamingMessage streams StreamResponse objects and ends on the final state', async () => {
    const { server } = newServer();
    const responses = await collect(
      server.handleJsonRpcStream(
        request('SendStreamingMessage', { message: v1UserMessage('stream it') }),
        undefined,
        undefined,
        V1
      )
    );
    const events = responses.map((response) => response.result as V1StreamResponse);
    expect(Object.keys(events[0])).toEqual(['task']);
    expect(events.some((event) => 'artifactUpdate' in event)).toBe(true);
    const last = events.at(-1)!;
    expect('statusUpdate' in last && last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    expect(JSON.stringify(events)).not.toMatch(/"final"|"kind"/);
  });

  it('SubscribeToTask follows a running task and refuses one that ended', async () => {
    const { server, cogitator } = newServer();
    const started = (
      expectResponse(
        await server.handleJsonRpc(
          request('SendMessage', {
            message: v1UserMessage('slow'),
            configuration: { returnImmediately: true },
          }),
          undefined,
          V1
        )
      ).result as { task: V1Task }
    ).task;
    const subscription = collect(
      server.handleJsonRpcStream(
        request('SubscribeToTask', { id: started.id }),
        undefined,
        undefined,
        V1
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    cogitator.release();
    const events = (await subscription).map((response) => response.result as V1StreamResponse);
    expect(Object.keys(events[0])).toEqual(['task']);
    const last = events.at(-1)!;
    expect('statusUpdate' in last && last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');

    const ended = await collect(
      server.handleJsonRpcStream(
        request('SubscribeToTask', { id: started.id }),
        undefined,
        undefined,
        V1
      )
    );
    expect(ended).toHaveLength(1);
    expect(ended[0].error?.code).toBe(A2A_ERROR_CODES.unsupportedOperation);
  });

  it('ListTasks answers a page with the 1.0 fields, artifacts only when asked for', async () => {
    const { server } = newServer();
    await send(server, 'one');
    await send(server, 'two');
    const page = expectResponse(
      await server.handleJsonRpc(request('ListTasks', { pageSize: 1 }), undefined, V1)
    ).result as { tasks: V1Task[]; nextPageToken: string; pageSize: number; totalSize: number };
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).not.toHaveProperty('artifacts');
    expect(page.pageSize).toBe(1);
    expect(page.totalSize).toBe(2);
    expect(page.nextPageToken).not.toBe('');

    const rest = expectResponse(
      await server.handleJsonRpc(
        request('ListTasks', { pageToken: page.nextPageToken, includeArtifacts: true }),
        undefined,
        V1
      )
    ).result as { tasks: V1Task[]; nextPageToken: string; pageSize: number };
    expect(rest.tasks).toHaveLength(1);
    expect(rest.tasks[0].artifacts).toHaveLength(1);
    expect(rest.nextPageToken).toBe('');
    expect(rest.pageSize).toBe(50);
  });

  it('manages push notification configs and keeps their protocol version to itself', async () => {
    const { server } = newServer();
    const task = await send(server, 'ping');
    const created = expectResponse(
      await server.handleJsonRpc(
        request('CreateTaskPushNotificationConfig', {
          taskId: task.id,
          url: 'https://hooks.example.com/a2a',
          token: 'tok',
          authentication: { scheme: 'Bearer', credentials: 'secret' },
        }),
        undefined,
        V1
      )
    ).result as Record<string, unknown>;
    expect(created).toMatchObject({
      taskId: task.id,
      url: 'https://hooks.example.com/a2a',
      token: 'tok',
      authentication: { scheme: 'Bearer', credentials: 'secret' },
    });
    expect(created).not.toHaveProperty('protocolVersion');
    const id = created.id as string;

    const fetched = expectResponse(
      await server.handleJsonRpc(
        request('GetTaskPushNotificationConfig', { taskId: task.id, id }),
        undefined,
        V1
      )
    ).result;
    expect(fetched).toEqual(created);

    const listed = expectResponse(
      await server.handleJsonRpc(
        request('ListTaskPushNotificationConfigs', { taskId: task.id }),
        undefined,
        V1
      )
    ).result;
    expect(listed).toEqual({ configs: [created] });

    const legacy = expectResponse(
      await server.handleJsonRpc(request('tasks/pushNotificationConfig/list', { id: task.id }))
    ).result as { pushNotificationConfig: Record<string, unknown> }[];
    expect(legacy[0].pushNotificationConfig).not.toHaveProperty('protocolVersion');

    const deleted = expectResponse(
      await server.handleJsonRpc(
        request('DeleteTaskPushNotificationConfig', { taskId: task.id, id }),
        undefined,
        V1
      )
    );
    expect(deleted.result).toBeNull();

    const gone = expectResponse(
      await server.handleJsonRpc(
        request('GetTaskPushNotificationConfig', { taskId: task.id, id }),
        undefined,
        V1
      )
    );
    expect(gone.error?.code).toBe(A2A_ERROR_CODES.taskNotFound);
  });

  it('GetExtendedAgentCard is unsupported without a generator and a 1.0 card with one', async () => {
    const without = newServer().server;
    const refused = expectResponse(
      await without.handleJsonRpc(request('GetExtendedAgentCard'), undefined, V1)
    );
    expect(refused.error?.code).toBe(A2A_ERROR_CODES.unsupportedOperation);

    const { server } = newServer({
      extendedCardGenerator: (name): AgentCard => ({
        ...without.getAgentCard(name === 'helper' ? undefined : name),
        name,
        description: `extended ${name}`,
        supportedInterfaces: undefined,
      }),
    });
    const card = expectResponse(
      await server.handleJsonRpc(request('GetExtendedAgentCard', { tenant: 'writer' }), undefined, {
        ...V1,
        baseUrl: 'https://agents.example.com',
      })
    ).result as Record<string, unknown>;
    expect(card).toMatchObject({
      name: 'writer',
      description: 'extended writer',
      capabilities: { extendedAgentCard: true },
    });
    expect(card.supportedInterfaces).toContainEqual({
      url: 'https://agents.example.com/a2a/writer',
      protocolBinding: 'JSONRPC',
      tenant: 'writer',
      protocolVersion: '1.0',
    });
    expect(card).not.toHaveProperty('url');
  });

  it('answers a 0.3 request exactly as before', async () => {
    const { server } = newServer();
    const response = expectResponse(
      await server.handleJsonRpc(request('message/send', { message: userMessage('ping') }))
    );
    const task = response.result as A2ATask;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.metadata).toBeUndefined();
    const missing = expectResponse(
      await server.handleJsonRpc(request('tasks/get', { id: 'nope' }))
    );
    expect(missing.error).toEqual({
      code: -32001,
      message: 'Task not found: nope',
      data: { taskId: 'nope' },
    });
    const pascal = expectResponse(await server.handleJsonRpc(request('SendMessage', {})));
    expect(pascal.error).toEqual({
      code: -32601,
      message: 'Method not found: SendMessage',
      data: { method: 'SendMessage' },
    });
  });
});

describe('A2A 1.0 tenants', () => {
  it('addresses an agent by its tenant on the shared endpoint', async () => {
    const { server } = newServer();
    const response = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', { tenant: 'writer', message: v1UserMessage('hi') }),
        undefined,
        V1
      )
    );
    const task = (response.result as { task: V1Task }).task;
    expect(task.artifacts?.[0].parts).toEqual([{ text: 'writer heard: hi' }]);
  });

  it('refuses a tenant that is not the agent of the endpoint, and an unknown one', async () => {
    const { server } = newServer();
    const mismatch = expectResponse(
      await server.handleJsonRpc(
        request('SendMessage', { tenant: 'writer', message: v1UserMessage('hi') }),
        undefined,
        { ...V1, agentName: 'helper' }
      )
    );
    expect(mismatch.error?.code).toBe(A2A_ERROR_CODES.invalidParams);
    expect(mismatch.error?.data).toContainEqual({
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [
        { field: 'tenant', description: 'is "writer", but this endpoint serves agent "helper"' },
      ],
    });

    const unknown = expectResponse(
      await server.handleJsonRpc(request('GetTask', { tenant: 'ghost', id: 'x' }), undefined, V1)
    );
    expect(unknown.error?.code).toBe(A2A_ERROR_CODES.invalidParams);
  });

  it("keeps an agent's tasks to its own tenant over 1.0, as 0.3 always did not", async () => {
    const { server } = newServer();
    const writerTask = await send(server, 'mine', { agentName: 'writer' });

    const fromHelper = expectResponse(
      await server.handleJsonRpc(request('GetTask', { id: writerTask.id }), undefined, V1)
    );
    expect(fromHelper.error?.code).toBe(A2A_ERROR_CODES.taskNotFound);

    const continued = expectResponse(
      await server.handleJsonRpc(request('ListTasks', {}), undefined, V1)
    ).result as { tasks: V1Task[] };
    expect(continued.tasks.map((task) => task.id)).not.toContain(writerTask.id);

    const fromWriter = expectResponse(
      await server.handleJsonRpc(
        request('GetTask', { id: writerTask.id, tenant: 'writer' }),
        undefined,
        V1
      )
    );
    expect(fromWriter.error).toBeUndefined();

    const legacy = expectResponse(
      await server.handleJsonRpc(request('tasks/get', { id: writerTask.id }))
    );
    expect(legacy.error).toBeUndefined();
  });

  it('shows tasks stored before tasks recorded their agent to every tenant', async () => {
    const store = new InMemoryTaskStore();
    const { server } = newServer({ taskStore: store });
    await store.create({
      kind: 'task',
      id: 'task_old',
      contextId: 'ctx_old',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });
    for (const tenant of ['helper', 'writer']) {
      const response = expectResponse(
        await server.handleJsonRpc(request('GetTask', { id: 'task_old', tenant }), undefined, V1)
      );
      expect(response.error).toBeUndefined();
    }
    const created = await send(server, 'new');
    const stored = await store.get(created.id);
    expect(stored?.metadata?.[TASK_AGENT_KEY]).toBe('helper');
    expect(created.metadata).toBeUndefined();
  });
});

describe('A2A 1.0 JSON-RPC over HTTP', () => {
  let served: Served | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it('streams SSE frames of JSON-RPC responses for SendStreamingMessage', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const response = await fetch(`${served.url}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify(
        request('SendStreamingMessage', { message: v1UserMessage('over http') }, 'req-1')
      ),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await sseData(response)) as { id: unknown; result: V1StreamResponse }[];
    expect(frames.every((frame) => frame.id === 'req-1')).toBe(true);
    expect(Object.keys(frames[0].result)).toEqual(['task']);
    expect('statusUpdate' in frames.at(-1)!.result).toBe(true);
  });

  it('answers SubscribeToTask on an ended task with a JSON error, not a stream', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const sent = await rpc(`${served.url}/a2a`, 'SendMessage', { message: v1UserMessage('x') });
    const taskId = (sent.body.result as { task: V1Task }).task.id;
    const reply = await rpc(`${served.url}/a2a`, 'SubscribeToTask', { id: taskId });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('application/json');
    expect(reply.body.error?.code).toBe(-32004);
  });

  it('authenticates 1.0 requests with 401 and an UNAUTHENTICATED ErrorInfo', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      auth: { type: 'bearer', validate: async (token) => token === 'good' },
    });
    const refused = await rpc(`${served.url}/a2a`, 'GetTask', { id: 'x' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="a2a"');
    expect(refused.body.error?.code).toBe(-32000);
    expect(errorInfo(refused.body.error?.data)).toMatchObject({
      reason: 'UNAUTHENTICATED',
      domain: 'cogitator.app',
    });
    const admitted = await rpc(
      `${served.url}/a2a`,
      'GetTask',
      { id: 'x' },
      {
        'A2A-Version': '1.0',
        Authorization: 'Bearer good',
      }
    );
    expect(admitted.body.error?.code).toBe(-32001);
  });
});
