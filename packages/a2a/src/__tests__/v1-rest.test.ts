import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import Fastify, { type FastifyInstance } from 'fastify';
import Koa from 'koa';
import { A2AServer } from '../server';
import { a2aExpress } from '../adapters/express';
import { a2aFastify } from '../adapters/fastify';
import { a2aHono } from '../adapters/hono';
import { a2aKoa } from '../adapters/koa';
import { a2aNext } from '../adapters/next';
import { matchRestRoute } from '../rest';
import type { V1RestErrorBody, V1StreamResponse, V1Task } from '../v1/types';
import { echoCogitator, listen, mockAgent, sseData, v1UserMessage } from './v1-helpers';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

interface Mounted {
  request: Fetcher;
  close(): Promise<void>;
}

function newServer(): A2AServer {
  return new A2AServer({
    agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
    cogitator: echoCogitator(),
    allowPrivateUrls: true,
  });
}

const adapters: Record<string, (server: A2AServer) => Promise<Mounted>> = {
  express: async (server) => {
    const app = express();
    app.use(a2aExpress(server));
    const { url, close } = await listen(app);
    return { request: (path, init) => fetch(`${url}${path}`, init), close };
  },
  koa: async (server) => {
    const app = new Koa();
    app.use(a2aKoa(server));
    const { url, close } = await listen(app.callback());
    return { request: (path, init) => fetch(`${url}${path}`, init), close };
  },
  fastify: async (server) => {
    const app: FastifyInstance = Fastify();
    await app.register(a2aFastify(server));
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    return { request: (path, init) => fetch(`${url}${path}`, init), close: () => app.close() };
  },
  hono: async (server) => {
    const app = a2aHono(server);
    return { request: async (path, init) => app.request(path, init), close: async () => {} };
  },
  next: async (server) => {
    const handlers = a2aNext(server);
    return {
      request: async (path, init) => {
        const request = new Request(`http://agents.test${path}`, init);
        const method = request.method.toUpperCase();
        if (method === 'POST') return handlers.POST(request);
        if (method === 'DELETE') return handlers.DELETE(request);
        return handlers.GET(request);
      },
      close: async () => {},
    };
  },
};

const V1_HEADERS = { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' };

describe.each(Object.keys(adapters))('A2A 1.0 HTTP+JSON binding on %s', (adapter) => {
  let mounted: Mounted;

  beforeAll(async () => {
    mounted = await adapters[adapter](newServer());
  });

  afterAll(async () => {
    await mounted.close();
  });

  async function sendMessage(text: string, tenant = ''): Promise<V1Task> {
    const response = await mounted.request(`/a2a/rest${tenant ? `/${tenant}` : ''}/message:send`, {
      method: 'POST',
      headers: V1_HEADERS,
      body: JSON.stringify({ message: v1UserMessage(text) }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/a2a+json');
    return ((await response.json()) as { task: V1Task }).task;
  }

  async function errorOf(response: Response): Promise<V1RestErrorBody['error']> {
    return ((await response.json()) as V1RestErrorBody).error;
  }

  it('sends a message and gets the task by id, with historyLength from the query', async () => {
    const task = await sendMessage('ping');
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    const fetched = await mounted.request(`/a2a/rest/tasks/${task.id}?historyLength=0`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as V1Task;
    expect(body.id).toBe(task.id);
    expect(body).not.toHaveProperty('history');
  });

  it('takes the version from the query and refuses a request without one', async () => {
    const task = await sendMessage('versions');
    const byQuery = await mounted.request(`/a2a/rest/tasks/${task.id}?A2A-Version=1.0`);
    expect(byQuery.status).toBe(200);

    const unversioned = await mounted.request(`/a2a/rest/tasks/${task.id}`);
    expect(unversioned.status).toBe(400);
    const error = await errorOf(unversioned);
    expect(error).toMatchObject({ code: 400, status: 'FAILED_PRECONDITION' });
    expect(error.details[0]).toMatchObject({
      reason: 'VERSION_NOT_SUPPORTED',
      metadata: { requestedVersion: '0.3', supportedVersions: '1.0' },
    });
  });

  it('binds tasks to the tenant of the path', async () => {
    const task = await sendMessage('mine', 'writer');
    expect(task.artifacts?.[0].parts).toEqual([{ text: 'writer heard: mine' }]);
    const own = await mounted.request(`/a2a/rest/writer/tasks/${task.id}`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(own.status).toBe(200);
    const other = await mounted.request(`/a2a/rest/tasks/${task.id}`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(other.status).toBe(404);
    expect((await errorOf(other)).details[0]).toMatchObject({ reason: 'TASK_NOT_FOUND' });

    const mismatch = await mounted.request('/a2a/rest/writer/message:send', {
      method: 'POST',
      headers: V1_HEADERS,
      body: JSON.stringify({ tenant: 'helper', message: v1UserMessage('x') }),
    });
    expect(mismatch.status).toBe(400);
    expect((await errorOf(mismatch)).status).toBe('INVALID_ARGUMENT');
  });

  it('lists tasks a page at a time from query parameters', async () => {
    await sendMessage('a');
    await sendMessage('b');
    const first = await mounted.request('/a2a/rest/tasks?pageSize=1&includeArtifacts=true', {
      headers: { 'A2A-Version': '1.0' },
    });
    const page = (await first.json()) as {
      tasks: V1Task[];
      nextPageToken: string;
      pageSize: number;
      totalSize: number;
    };
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0].artifacts).toBeDefined();
    expect(page.pageSize).toBe(1);
    expect(page.nextPageToken).not.toBe('');

    const working = await mounted.request('/a2a/rest/tasks?status=2', {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(((await working.json()) as { totalSize: number }).totalSize).toBe(0);

    const tooLarge = await mounted.request('/a2a/rest/tasks?pageSize=500', {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(tooLarge.status).toBe(400);
    expect((await errorOf(tooLarge)).details).toContainEqual({
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'pageSize', description: 'must be between 1 and 100' }],
    });
  });

  it('cancels with :cancel and maps the refusal to 400 FAILED_PRECONDITION', async () => {
    const task = await sendMessage('done');
    const response = await mounted.request(`/a2a/rest/tasks/${task.id}:cancel`, {
      method: 'POST',
      headers: { 'A2A-Version': '1.0', 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.status).toBe('FAILED_PRECONDITION');
    expect(error.details[0]).toMatchObject({ reason: 'TASK_NOT_CANCELABLE' });
  });

  it('creates push configs with 201 and deletes them with 204', async () => {
    const task = await sendMessage('push');
    const base = `/a2a/rest/tasks/${task.id}/pushNotificationConfigs`;
    const created = await mounted.request(base, {
      method: 'POST',
      headers: V1_HEADERS,
      body: JSON.stringify({ url: 'https://hooks.example.com/a2a', token: 't' }),
    });
    expect(created.status).toBe(201);
    const config = (await created.json()) as { id: string; taskId: string };
    expect(config.taskId).toBe(task.id);

    const listed = await mounted.request(base, { headers: { 'A2A-Version': '1.0' } });
    expect(((await listed.json()) as { configs: unknown[] }).configs).toEqual([config]);

    const fetched = await mounted.request(`${base}/${config.id}`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(await fetched.json()).toEqual(config);

    const deleted = await mounted.request(`${base}/${config.id}`, {
      method: 'DELETE',
      headers: { 'A2A-Version': '1.0' },
    });
    expect(deleted.status).toBe(204);

    const gone = await mounted.request(`${base}/${config.id}`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(gone.status).toBe(404);
  });

  it('streams StreamResponse objects as SSE', async () => {
    const response = await mounted.request('/a2a/rest/message:stream', {
      method: 'POST',
      headers: V1_HEADERS,
      body: JSON.stringify({ message: v1UserMessage('stream it') }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await sseData(response)) as V1StreamResponse[];
    expect(Object.keys(events[0])).toEqual(['task']);
    const last = events.at(-1)!;
    expect('statusUpdate' in last && last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses :subscribe on an ended task with a JSON error', async () => {
    const task = await sendMessage('ended');
    const response = await mounted.request(`/a2a/rest/tasks/${task.id}:subscribe`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details[0]).toMatchObject({
      reason: 'UNSUPPORTED_OPERATION',
    });
  });

  it('answers unknown routes, wrong content types and bad JSON with REST errors', async () => {
    const unknown = await mounted.request('/a2a/rest/tasks/a/b/c/d', {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).details[0]).toMatchObject({ reason: 'METHOD_NOT_FOUND' });

    const text = await mounted.request('/a2a/rest/message:send', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'A2A-Version': '1.0' },
      body: 'hello',
    });
    expect(text.status).toBe(415);

    const broken = await mounted.request('/a2a/rest/message:send', {
      method: 'POST',
      headers: V1_HEADERS,
      body: '{not json',
    });
    expect(broken.status).toBe(400);
    expect((await errorOf(broken)).status).toBe('INVALID_ARGUMENT');

    const card = await mounted.request('/a2a/rest/extendedAgentCard', {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(card.status).toBe(400);
  });
});

describe('REST routes from the proto http bindings', () => {
  it.each([
    ['POST', '/message:send', { method: 'SendMessage' }],
    ['POST', '/acme/message:stream', { method: 'SendStreamingMessage', tenant: 'acme' }],
    ['GET', '/tasks/t1', { method: 'GetTask', taskId: 't1' }],
    ['GET', '/tasks', { method: 'ListTasks' }],
    ['GET', '/acme/tasks', { method: 'ListTasks', tenant: 'acme' }],
    ['POST', '/tasks/t%3A1:cancel', { method: 'CancelTask', taskId: 't:1' }],
    ['GET', '/tasks/t1:subscribe', { method: 'SubscribeToTask', taskId: 't1' }],
    ['POST', '/tasks/t1:subscribe', { method: 'SubscribeToTask', taskId: 't1' }],
    [
      'POST',
      '/tasks/t1/pushNotificationConfigs',
      { method: 'CreateTaskPushNotificationConfig', taskId: 't1' },
    ],
    [
      'GET',
      '/acme/tasks/t1/pushNotificationConfigs/c1',
      { method: 'GetTaskPushNotificationConfig', taskId: 't1', configId: 'c1', tenant: 'acme' },
    ],
    [
      'DELETE',
      '/tasks/t1/pushNotificationConfigs/c1',
      { method: 'DeleteTaskPushNotificationConfig', taskId: 't1', configId: 'c1' },
    ],
    ['GET', '/extendedAgentCard', { method: 'GetExtendedAgentCard' }],
    [
      'GET',
      '/my%20agent/extendedAgentCard',
      { method: 'GetExtendedAgentCard', tenant: 'my agent' },
    ],
  ])('%s %s', (method, path, route) => {
    expect(matchRestRoute(method, path)).toEqual(route);
  });

  it.each([
    ['GET', '/message:send'],
    ['DELETE', '/tasks/t1'],
    ['POST', '/tasks/t1'],
    ['GET', '/tasks/t1:cancel'],
    ['GET', '//tasks'],
    ['GET', '/a/b/tasks'],
  ])('%s %s names no method', (method, path) => {
    expect(matchRestRoute(method, path)).toBeNull();
  });
});

describe('restPath', () => {
  it('can move and be turned off', async () => {
    const moved = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      restPath: '/v1',
    });
    expect(moved.restPath).toBe('/v1');
    const app = a2aHono(moved);
    const response = await app.request('/v1/message:send', {
      method: 'POST',
      headers: V1_HEADERS,
      body: JSON.stringify({ message: v1UserMessage('moved') }),
    });
    expect(response.status).toBe(200);

    const off = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      restPath: false,
    });
    expect(off.restPath).toBeNull();
    const card = off.getV1AgentCard();
    expect(
      card.supportedInterfaces.map((entry) => `${entry.protocolBinding} ${entry.protocolVersion}`)
    ).toEqual(['JSONRPC 1.0', 'JSONRPC 0.3']);
    expect((await a2aHono(off).request('/a2a/rest/message:send', { method: 'POST' })).status).toBe(
      404
    );
  });

  it('refuses a restPath that is an agent endpoint', () => {
    expect(
      () =>
        new A2AServer({
          agents: { helper: mockAgent('helper'), rest: mockAgent('rest') },
          cogitator: echoCogitator(),
        })
    ).toThrow(/endpoint of agent "rest"/);
  });
});
