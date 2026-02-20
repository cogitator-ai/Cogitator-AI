import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { InMemoryPushNotificationStore, PushNotificationSender } from '../push-notifications';
import { A2AServer } from '../server';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type { A2AMessage, A2AStreamEvent, PushNotificationConfig } from '../types';
import type { CogitatorLike, AgentRunResult } from '../task-manager';

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'test-model',
    instructions: 'test',
    description: `${name} agent`,
  };
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

function createMockCogitator(output: string = 'test output'): CogitatorLike {
  const result: AgentRunResult = {
    output,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
    toolCalls: [],
  };
  return { run: vi.fn().mockResolvedValue(result) };
}

function userMessage(text: string): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

describe('InMemoryPushNotificationStore', () => {
  let store: InMemoryPushNotificationStore;

  beforeEach(() => {
    store = new InMemoryPushNotificationStore();
  });

  it('should create a push notification config with generated id', async () => {
    const config: PushNotificationConfig = { webhookUrl: 'https://example.com/webhook' };
    const created = await store.create('task_1', config);
    expect(created.id).toMatch(/^pnc_/);
    expect(created.webhookUrl).toBe('https://example.com/webhook');
    expect(created.createdAt).toBeDefined();
  });

  it('should preserve provided id', async () => {
    const config: PushNotificationConfig = {
      webhookUrl: 'https://example.com/webhook',
      id: 'custom_id',
    };
    const created = await store.create('task_1', config);
    expect(created.id).toBe('custom_id');
  });

  it('should get a config by taskId and configId', async () => {
    const config: PushNotificationConfig = { webhookUrl: 'https://example.com/hook' };
    const created = await store.create('task_1', config);
    const retrieved = await store.get('task_1', created.id!);
    expect(retrieved).toEqual(created);
  });

  it('should return null for non-existent config', async () => {
    const result = await store.get('task_1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('should return null for non-existent task', async () => {
    const result = await store.get('nonexistent_task', 'nonexistent');
    expect(result).toBeNull();
  });

  it('should list all configs for a task', async () => {
    await store.create('task_1', { webhookUrl: 'https://example.com/hook1' });
    await store.create('task_1', { webhookUrl: 'https://example.com/hook2' });
    await store.create('task_2', { webhookUrl: 'https://example.com/hook3' });

    const configs = await store.list('task_1');
    expect(configs).toHaveLength(2);
  });

  it('should return empty array for task with no configs', async () => {
    const configs = await store.list('nonexistent_task');
    expect(configs).toEqual([]);
  });

  it('should delete a config', async () => {
    const created = await store.create('task_1', { webhookUrl: 'https://example.com/hook' });
    await store.delete('task_1', created.id!);
    const result = await store.get('task_1', created.id!);
    expect(result).toBeNull();
  });

  it('should silently handle deleting non-existent config', async () => {
    await expect(store.delete('task_1', 'nonexistent')).resolves.not.toThrow();
  });

  it('should store authentication info', async () => {
    const config: PushNotificationConfig = {
      webhookUrl: 'https://example.com/hook',
      authenticationInfo: {
        scheme: 'bearer',
        credentials: { token: 'secret-token' },
      },
    };
    const created = await store.create('task_1', config);
    const retrieved = await store.get('task_1', created.id!);
    expect(retrieved?.authenticationInfo?.scheme).toBe('bearer');
    expect(retrieved?.authenticationInfo?.credentials.token).toBe('secret-token');
  });
});

describe('PushNotificationSender', () => {
  let webhookServer: http.Server;
  let webhookUrl: string;
  let receivedRequests: { body: string; headers: http.IncomingHttpHeaders }[];

  beforeAll(async () => {
    receivedRequests = [];
    webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedRequests.push({ body, headers: req.headers });
        res.writeHead(200);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      webhookServer.listen(0, () => {
        const addr = webhookServer.address() as { port: number };
        webhookUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    webhookServer.close();
  });

  beforeEach(() => {
    receivedRequests = [];
  });

  it('should send webhook POST to registered urls', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { webhookUrl });
    const sender = new PushNotificationSender(store);

    const event: A2AStreamEvent = {
      type: 'status-update',
      taskId: 'task_1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    };

    await sender.notify('task_1', event);
    expect(receivedRequests).toHaveLength(1);

    const parsed = JSON.parse(receivedRequests[0].body);
    expect(parsed.type).toBe('status-update');
    expect(parsed.taskId).toBe('task_1');
  });

  it('should send to multiple webhooks', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { webhookUrl: `${webhookUrl}/hook1` });
    await store.create('task_1', { webhookUrl: `${webhookUrl}/hook2` });
    const sender = new PushNotificationSender(store);

    const event: A2AStreamEvent = {
      type: 'status-update',
      taskId: 'task_1',
      status: { state: 'working', timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    };

    await sender.notify('task_1', event);
    expect(receivedRequests).toHaveLength(2);
  });

  it('should include bearer auth header', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', {
      webhookUrl,
      authenticationInfo: {
        scheme: 'bearer',
        credentials: { token: 'my-secret-token' },
      },
    });
    const sender = new PushNotificationSender(store);

    await sender.notify('task_1', {
      type: 'status-update',
      taskId: 'task_1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].headers.authorization).toBe('Bearer my-secret-token');
  });

  it('should include apiKey auth header', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', {
      webhookUrl,
      authenticationInfo: {
        scheme: 'apiKey',
        credentials: { key: 'api-key-value' },
      },
    });
    const sender = new PushNotificationSender(store);

    await sender.notify('task_1', {
      type: 'status-update',
      taskId: 'task_1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].headers['x-api-key']).toBe('api-key-value');
  });

  it('should not throw when webhook fails', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { webhookUrl: 'http://localhost:1' });
    const sender = new PushNotificationSender(store);

    await expect(
      sender.notify('task_1', {
        type: 'status-update',
        taskId: 'task_1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        timestamp: new Date().toISOString(),
      })
    ).resolves.not.toThrow();
  });

  it('should do nothing when no configs exist', async () => {
    const store = new InMemoryPushNotificationStore();
    const sender = new PushNotificationSender(store);

    await expect(
      sender.notify('task_1', {
        type: 'status-update',
        taskId: 'task_1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        timestamp: new Date().toISOString(),
      })
    ).resolves.not.toThrow();
    expect(receivedRequests).toHaveLength(0);
  });
});

describe('A2AServer push notification methods', () => {
  let server: A2AServer;
  let pushStore: InMemoryPushNotificationStore;

  beforeEach(() => {
    pushStore = new InMemoryPushNotificationStore();
    server = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator: createMockCogitator(),
      pushNotificationStore: pushStore,
    });
  });

  it('should create a push notification config via JSON-RPC', async () => {
    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/pushNotification/create',
      params: {
        taskId: 'task_1',
        config: { webhookUrl: 'https://example.com/webhook' },
      },
      id: 1,
    });

    expect(response.error).toBeUndefined();
    const result = response.result as PushNotificationConfig;
    expect(result.id).toMatch(/^pnc_/);
    expect(result.webhookUrl).toBe('https://example.com/webhook');
  });

  it('should get a push notification config via JSON-RPC', async () => {
    const created = await pushStore.create('task_1', {
      webhookUrl: 'https://example.com/webhook',
    });

    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/pushNotification/get',
      params: { taskId: 'task_1', configId: created.id },
      id: 1,
    });

    expect(response.error).toBeUndefined();
    const result = response.result as PushNotificationConfig;
    expect(result.webhookUrl).toBe('https://example.com/webhook');
  });

  it('should list push notification configs via JSON-RPC', async () => {
    await pushStore.create('task_1', { webhookUrl: 'https://example.com/hook1' });
    await pushStore.create('task_1', { webhookUrl: 'https://example.com/hook2' });

    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/pushNotification/list',
      params: { taskId: 'task_1' },
      id: 1,
    });

    expect(response.error).toBeUndefined();
    const result = response.result as PushNotificationConfig[];
    expect(result).toHaveLength(2);
  });

  it('should delete a push notification config via JSON-RPC', async () => {
    const created = await pushStore.create('task_1', {
      webhookUrl: 'https://example.com/hook',
    });

    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/pushNotification/delete',
      params: { taskId: 'task_1', configId: created.id },
      id: 1,
    });

    expect(response.error).toBeUndefined();
    const remaining = await pushStore.list('task_1');
    expect(remaining).toHaveLength(0);
  });

  it('should return error when taskId is missing for create', async () => {
    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/pushNotification/create',
      params: { config: { webhookUrl: 'https://example.com' } },
      id: 1,
    });
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  it('should return error when webhookUrl is missing for create', async () => {
    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/pushNotification/create',
      params: { taskId: 'task_1', config: {} },
      id: 1,
    });
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  it('should set pushNotifications capability to true when store provided', () => {
    const card = server.getAgentCard();
    expect(card.capabilities.pushNotifications).toBe(true);
  });
});

describe('Webhook receives events on task completion', () => {
  let webhookServer: http.Server;
  let webhookUrl: string;
  let receivedEvents: A2AStreamEvent[];

  beforeAll(async () => {
    receivedEvents = [];
    webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedEvents.push(JSON.parse(body));
        res.writeHead(200);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      webhookServer.listen(0, () => {
        const addr = webhookServer.address() as { port: number };
        webhookUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    webhookServer.close();
  });

  beforeEach(() => {
    receivedEvents = [];
  });

  it('should deliver webhook when task completes', async () => {
    const pushStore = new InMemoryPushNotificationStore();
    const server = new A2AServer({
      agents: { helper: createMockAgent('helper') },
      cogitator: createMockCogitator('done'),
      pushNotificationStore: pushStore,
    });

    const sendResponse = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'message/send',
      params: { message: userMessage('Hello') },
      id: 1,
    });
    const taskId = (sendResponse.result as { id: string }).id;

    await pushStore.create(taskId, { webhookUrl });

    const secondResponse = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'message/send',
      params: { message: { ...userMessage('Continue'), taskId } },
      id: 2,
    });
    expect(secondResponse.error).toBeUndefined();

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedEvents.length).toBeGreaterThan(0);
    const statusUpdates = receivedEvents.filter((e) => e.type === 'status-update');
    expect(statusUpdates.length).toBeGreaterThan(0);
  });
});
