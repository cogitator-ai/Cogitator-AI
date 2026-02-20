import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { A2AClient, InMemoryPushNotificationStore } from '@cogitator-ai/a2a';
import type { AgentRunResult, A2AStreamEvent, CogitatorLike } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
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
    clone: (() => {}) as Agent['clone'],
    serialize: (() => {}) as Agent['serialize'],
  };
}

let callCount = 0;

function createMockRunResult(output: string): AgentRunResult {
  return {
    output,
    runId: `run_${++callCount}`,
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0, duration: 50 },
    toolCalls: [],
  };
}

function createMockCogitator(): CogitatorLike {
  return {
    run: async (_agent, options) => {
      return createMockRunResult(`Response to: ${options.input}`);
    },
  };
}

describe('A2A: Push Notifications', () => {
  let testServer: TestA2AServer;
  let client: A2AClient;
  let pushStore: InMemoryPushNotificationStore;

  beforeAll(async () => {
    pushStore = new InMemoryPushNotificationStore();
    testServer = await startTestA2AServer({
      agents: { 'test-agent': createMockAgent('test-agent') },
      cogitator: createMockCogitator(),
      pushNotificationStore: pushStore,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
  });

  describe('CRUD', () => {
    it('creates push notification config for a task', async () => {
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      });

      const config = await client.createPushNotification(task.id, {
        webhookUrl: 'https://example.com/webhook',
      });

      expect(config.id).toBeDefined();
      expect(config.id).toMatch(/^pnc_/);
      expect(config.webhookUrl).toBe('https://example.com/webhook');
      expect(config.createdAt).toBeDefined();
    });

    it('gets push notification by id', async () => {
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      });

      const created = await client.createPushNotification(task.id, {
        webhookUrl: 'https://example.com/hook-get',
        authenticationInfo: {
          scheme: 'bearer',
          credentials: { token: 'secret' },
        },
      });

      const retrieved = await client.getPushNotification(task.id, created.id!);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.webhookUrl).toBe('https://example.com/hook-get');
      expect(retrieved!.authenticationInfo?.scheme).toBe('bearer');
    });

    it('lists push notifications for a task', async () => {
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      });

      await client.createPushNotification(task.id, {
        webhookUrl: 'https://example.com/hook-a',
      });
      await client.createPushNotification(task.id, {
        webhookUrl: 'https://example.com/hook-b',
      });

      const configs = await client.listPushNotifications(task.id);
      expect(configs).toHaveLength(2);

      const urls = configs.map((c) => c.webhookUrl);
      expect(urls).toContain('https://example.com/hook-a');
      expect(urls).toContain('https://example.com/hook-b');
    });

    it('deletes push notification', async () => {
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      });

      const created = await client.createPushNotification(task.id, {
        webhookUrl: 'https://example.com/hook-del',
      });

      await client.deletePushNotification(task.id, created.id!);

      const remaining = await client.listPushNotifications(task.id);
      expect(remaining).toHaveLength(0);
    });

    it('accepts push notification for any task id', async () => {
      const config = await client.createPushNotification('nonexistent_task_xyz', {
        webhookUrl: 'https://example.com/hook',
      });
      expect(config.id).toBeDefined();
      expect(config.webhookUrl).toBe('https://example.com/hook');
    });
  });

  describe('webhook delivery', () => {
    let webhookServer: http.Server;
    let webhookUrl: string;
    let receivedEvents: A2AStreamEvent[];

    beforeAll(async () => {
      receivedEvents = [];
      webhookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
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

    it('webhook receives events when task completes', async () => {
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'First message' }],
      });

      await client.createPushNotification(task.id, { webhookUrl });

      await client.continueTask(task.id, 'Follow-up message');

      await new Promise((r) => setTimeout(r, 200));

      expect(receivedEvents.length).toBeGreaterThan(0);
      const statusUpdates = receivedEvents.filter((e) => e.type === 'status-update');
      expect(statusUpdates.length).toBeGreaterThan(0);
      expect(statusUpdates.some((e) => e.taskId === task.id)).toBe(true);
    });
  });
});
