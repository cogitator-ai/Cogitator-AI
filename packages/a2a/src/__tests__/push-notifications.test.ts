import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  InMemoryPushNotificationStore,
  PushNotificationSender,
  validateWebhookUrl,
} from '../push-notifications';
import { A2AServer } from '../server';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type {
  A2ATask,
  PushNotificationConfig,
  TaskPushNotificationConfig,
  CogitatorLike,
  AgentRunResult,
} from '../types';
import { expectResponse, userMessage } from './helpers';

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

function taskOf(id: string, state: A2ATask['status']['state'] = 'completed'): A2ATask {
  return {
    kind: 'task',
    id,
    contextId: 'ctx_1',
    status: { state, timestamp: new Date().toISOString() },
  };
}

describe('InMemoryPushNotificationStore', () => {
  let store: InMemoryPushNotificationStore;

  beforeEach(() => {
    store = new InMemoryPushNotificationStore();
  });

  it('should create a push notification config with generated id', async () => {
    const config: PushNotificationConfig = { url: 'https://example.com/webhook' };
    const created = await store.create('task_1', config);
    expect(created.id).toMatch(/^pnc_/);
    expect(created).toEqual({ url: 'https://example.com/webhook', id: created.id });
  });

  it('should preserve provided id', async () => {
    const created = await store.create('task_1', {
      url: 'https://example.com/webhook',
      id: 'custom_id',
    });
    expect(created.id).toBe('custom_id');
  });

  it('should get a config by taskId and configId', async () => {
    const created = await store.create('task_1', { url: 'https://example.com/hook' });
    const retrieved = await store.get('task_1', created.id!);
    expect(retrieved).toEqual(created);
  });

  it('should return null for non-existent config', async () => {
    expect(await store.get('task_1', 'nonexistent')).toBeNull();
    expect(await store.get('nonexistent_task', 'nonexistent')).toBeNull();
  });

  it('should list all configs for a task', async () => {
    await store.create('task_1', { url: 'https://example.com/hook1' });
    await store.create('task_1', { url: 'https://example.com/hook2' });
    await store.create('task_2', { url: 'https://example.com/hook3' });

    expect(await store.list('task_1')).toHaveLength(2);
    expect(await store.list('nonexistent_task')).toEqual([]);
  });

  it('should delete a config', async () => {
    const created = await store.create('task_1', { url: 'https://example.com/hook' });
    await store.delete('task_1', created.id!);
    expect(await store.get('task_1', created.id!)).toBeNull();
    await expect(store.delete('task_1', 'nonexistent')).resolves.not.toThrow();
  });

  it('should store the token and authentication info', async () => {
    const created = await store.create('task_1', {
      url: 'https://example.com/hook',
      token: 'tok',
      authentication: { schemes: ['Bearer'], credentials: 'secret-token' },
    });
    const retrieved = await store.get('task_1', created.id!);
    expect(retrieved?.token).toBe('tok');
    expect(retrieved?.authentication).toEqual({ schemes: ['Bearer'], credentials: 'secret-token' });
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

  it('should POST the task to the registered url', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { url: webhookUrl });
    const sender = new PushNotificationSender(store, true);

    await sender.notify(taskOf('task_1'));
    expect(receivedRequests).toHaveLength(1);

    const parsed = JSON.parse(receivedRequests[0].body);
    expect(parsed).toMatchObject({ kind: 'task', id: 'task_1', status: { state: 'completed' } });
  });

  it('should send to multiple webhooks', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { url: `${webhookUrl}/hook1` });
    await store.create('task_1', { url: `${webhookUrl}/hook2` });
    const sender = new PushNotificationSender(store, true);

    await sender.notify(taskOf('task_1', 'working'));
    expect(receivedRequests).toHaveLength(2);
  });

  it('should send the token in X-A2A-Notification-Token', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { url: webhookUrl, token: 'client-token' });
    const sender = new PushNotificationSender(store, true);

    await sender.notify(taskOf('task_1'));

    expect(receivedRequests[0].headers['x-a2a-notification-token']).toBe('client-token');
  });

  it('should send bearer credentials', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', {
      url: webhookUrl,
      authentication: { schemes: ['Bearer'], credentials: 'my-secret-token' },
    });
    const sender = new PushNotificationSender(store, true);

    await sender.notify(taskOf('task_1'));

    expect(receivedRequests[0].headers.authorization).toBe('Bearer my-secret-token');
  });

  it('should send basic credentials', async () => {
    const store = new InMemoryPushNotificationStore();
    const credentials = Buffer.from('user:pass').toString('base64');
    await store.create('task_1', {
      url: webhookUrl,
      authentication: { schemes: ['Basic'], credentials },
    });
    const sender = new PushNotificationSender(store, true);

    await sender.notify(taskOf('task_1'));

    expect(receivedRequests[0].headers.authorization).toBe(`Basic ${credentials}`);
  });

  it('should not throw when webhook fails', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { url: 'http://localhost:1' });
    const sender = new PushNotificationSender(store, true);

    await expect(sender.notify(taskOf('task_1'))).resolves.not.toThrow();
  });

  it('should do nothing when no configs exist', async () => {
    const sender = new PushNotificationSender(new InMemoryPushNotificationStore(), true);
    await expect(sender.notify(taskOf('task_1'))).resolves.not.toThrow();
    expect(receivedRequests).toHaveLength(0);
  });
});

describe('A2AServer push notification config methods', () => {
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

  async function sendTask(): Promise<string> {
    const sent = expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('Hello') },
        id: 0,
      })
    );
    return (sent.result as { id: string }).id;
  }

  async function call(method: string, params: unknown) {
    return expectResponse(await server.handleJsonRpc({ jsonrpc: '2.0', method, params, id: 1 }));
  }

  it('should set a config with tasks/pushNotificationConfig/set', async () => {
    const taskId = await sendTask();
    const response = await call('tasks/pushNotificationConfig/set', {
      taskId,
      pushNotificationConfig: { url: 'https://example.com/webhook', token: 't' },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as TaskPushNotificationConfig;
    expect(result.taskId).toBe(taskId);
    expect(result.pushNotificationConfig.id).toMatch(/^pnc_/);
    expect(result.pushNotificationConfig.url).toBe('https://example.com/webhook');
    expect(await pushStore.list(taskId)).toHaveLength(1);
  });

  it('should get a config by id, or the first one without an id', async () => {
    const taskId = await sendTask();
    const created = await pushStore.create(taskId, { url: 'https://example.com/webhook' });

    const byId = await call('tasks/pushNotificationConfig/get', {
      id: taskId,
      pushNotificationConfigId: created.id,
    });
    expect(byId.result).toEqual({ taskId, pushNotificationConfig: created });

    const first = await call('tasks/pushNotificationConfig/get', { id: taskId });
    expect(first.result).toEqual({ taskId, pushNotificationConfig: created });

    const missing = await call('tasks/pushNotificationConfig/get', {
      id: taskId,
      pushNotificationConfigId: 'nope',
    });
    expect(missing.error?.code).toBe(-32602);
  });

  it('should list configs', async () => {
    const taskId = await sendTask();
    await pushStore.create(taskId, { url: 'https://example.com/hook1' });
    await pushStore.create(taskId, { url: 'https://example.com/hook2' });

    const response = await call('tasks/pushNotificationConfig/list', { id: taskId });

    const result = response.result as TaskPushNotificationConfig[];
    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.taskId === taskId)).toBe(true);
  });

  it('should delete a config and answer null', async () => {
    const taskId = await sendTask();
    const created = await pushStore.create(taskId, { url: 'https://example.com/hook' });

    const response = await call('tasks/pushNotificationConfig/delete', {
      id: taskId,
      pushNotificationConfigId: created.id,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toBeNull();
    expect(await pushStore.list(taskId)).toHaveLength(0);
  });

  it('should reject configs for unknown tasks', async () => {
    const response = await call('tasks/pushNotificationConfig/set', {
      taskId: 'task_missing',
      pushNotificationConfig: { url: 'https://example.com/webhook' },
    });
    expect(response.error!.code).toBe(-32001);
  });

  it('should reject a config without taskId or url as invalid params', async () => {
    const noTask = await call('tasks/pushNotificationConfig/set', {
      pushNotificationConfig: { url: 'https://example.com' },
    });
    expect(noTask.error!.code).toBe(-32602);

    const noUrl = await call('tasks/pushNotificationConfig/set', {
      taskId: 'task_1',
      pushNotificationConfig: {},
    });
    expect(noUrl.error!.code).toBe(-32602);
  });

  it('should no longer answer the pre-v0.3 method names', async () => {
    const response = await call('tasks/pushNotification/create', {
      taskId: 'task_1',
      config: { webhookUrl: 'https://example.com' },
    });
    expect(response.error!.code).toBe(-32601);
  });

  it('should announce push notifications on the card', () => {
    expect(server.getAgentCard().capabilities.pushNotifications).toBe(true);
  });
});

describe('validateWebhookUrl', () => {
  it('should reject localhost', () => {
    expect(() => validateWebhookUrl('http://localhost:3000')).toThrow('private/internal');
  });

  it('should reject 127.0.0.1', () => {
    expect(() => validateWebhookUrl('http://127.0.0.1/hook')).toThrow('private/internal');
  });

  it('should reject IPv6 loopback ::1', () => {
    expect(() => validateWebhookUrl('http://[::1]:8080')).toThrow('private/internal');
  });

  it('should reject 10.x.x.x private range', () => {
    expect(() => validateWebhookUrl('http://10.0.0.1/hook')).toThrow('private/internal');
  });

  it('should reject 192.168.x.x private range', () => {
    expect(() => validateWebhookUrl('http://192.168.1.1/hook')).toThrow('private/internal');
  });

  it('should reject 172.16-31.x.x private range', () => {
    expect(() => validateWebhookUrl('http://172.16.0.1/hook')).toThrow('private/internal');
    expect(() => validateWebhookUrl('http://172.31.255.255/hook')).toThrow('private/internal');
  });

  it('should reject 169.254.x.x link-local', () => {
    expect(() => validateWebhookUrl('http://169.254.1.1/hook')).toThrow('private/internal');
  });

  it('should reject .local suffix', () => {
    expect(() => validateWebhookUrl('http://myhost.local/hook')).toThrow('private/internal');
  });

  it('should reject .internal suffix', () => {
    expect(() => validateWebhookUrl('http://service.internal/hook')).toThrow('private/internal');
  });

  it('should reject invalid URLs', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow('private/internal');
  });

  it('should reject non-http protocols', () => {
    expect(() => validateWebhookUrl('ftp://example.com/hook')).toThrow('private/internal');
  });

  it('should accept valid public URLs', () => {
    expect(() => validateWebhookUrl('https://example.com/webhook')).not.toThrow();
    expect(() => validateWebhookUrl('https://hooks.slack.com/services/abc')).not.toThrow();
  });
});

describe('InMemoryPushNotificationStore.cleanup', () => {
  it('should remove all configs for a task', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', { url: 'https://example.com/a' });
    await store.create('task_1', { url: 'https://example.com/b' });
    await store.create('task_2', { url: 'https://example.com/c' });

    store.cleanup('task_1');

    expect(await store.list('task_1')).toEqual([]);
    expect(await store.list('task_2')).toHaveLength(1);
  });

  it('should handle cleanup of non-existent task', () => {
    const store = new InMemoryPushNotificationStore();
    expect(() => store.cleanup('nonexistent')).not.toThrow();
  });
});

describe('Webhook receives the task on every status change', () => {
  let webhookServer: http.Server;
  let webhookUrl: string;
  let received: { task: A2ATask; token: string | undefined }[];

  beforeAll(async () => {
    received = [];
    webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({
          task: JSON.parse(body) as A2ATask,
          token: req.headers['x-a2a-notification-token'] as string | undefined,
        });
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
    received = [];
  });

  it('should deliver the completed task to a webhook registered with the message', async () => {
    const server = new A2AServer({
      agents: { helper: createMockAgent('helper') },
      cogitator: createMockCogitator('done'),
      allowPrivateUrls: true,
    });

    const sendResponse = expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: userMessage('Hello'),
          configuration: { pushNotificationConfig: { url: webhookUrl, token: 'tok' } },
        },
        id: 1,
      })
    );
    const taskId = (sendResponse.result as { id: string }).id;

    await vi.waitFor(
      () => {
        const completed = received.find(
          (r) => r.task.id === taskId && r.task.status.state === 'completed'
        );
        expect(completed?.task.kind).toBe('task');
        expect(completed?.token).toBe('tok');
        expect(completed?.task.metadata).toBeUndefined();
      },
      { timeout: 5000, interval: 20 }
    );
  });
});
