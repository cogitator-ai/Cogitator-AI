import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  A2AClient,
  A2AError,
  InMemoryPushNotificationStore,
  NOTIFICATION_TOKEN_HEADER,
} from '@cogitator-ai/a2a';
import type { AgentRunResult, A2ATask, CogitatorLike } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import {
  asTask,
  createStubAgent,
  startTestA2AServer,
  type TestA2AServer,
} from '../../helpers/a2a-server';

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
    instructions: 'test',
    description: `${name} agent`,
  };
  return createStubAgent(config);
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
      allowPrivateUrls: true,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
  });

  async function send(text: string): Promise<A2ATask> {
    return asTask(await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text }] }));
  }

  describe('CRUD', () => {
    it('sets a push notification config for a task', async () => {
      const task = await send('Hello');

      const result = await client.setPushNotificationConfig(task.id, {
        url: 'https://example.com/webhook',
      });

      expect(result.taskId).toBe(task.id);
      expect(result.pushNotificationConfig.id).toBeDefined();
      expect(result.pushNotificationConfig.id).toMatch(/^pnc_/);
      expect(result.pushNotificationConfig.url).toBe('https://example.com/webhook');
    });

    it('gets a push notification config by id', async () => {
      const task = await send('Hello');

      const created = await client.setPushNotificationConfig(task.id, {
        url: 'https://example.com/hook-get',
        token: 'verify-me',
        authentication: { schemes: ['Bearer'], credentials: 'secret' },
      });
      const configId = created.pushNotificationConfig.id;
      expect(configId).toBeDefined();

      const retrieved = await client.getPushNotificationConfig(task.id, configId);
      expect(retrieved.taskId).toBe(task.id);
      expect(retrieved.pushNotificationConfig.id).toBe(configId);
      expect(retrieved.pushNotificationConfig.url).toBe('https://example.com/hook-get');
      expect(retrieved.pushNotificationConfig.token).toBe('verify-me');
      expect(retrieved.pushNotificationConfig.authentication?.schemes).toEqual(['Bearer']);
    });

    it('lists push notification configs for a task', async () => {
      const task = await send('Hello');

      await client.setPushNotificationConfig(task.id, { url: 'https://example.com/hook-a' });
      await client.setPushNotificationConfig(task.id, { url: 'https://example.com/hook-b' });

      const configs = await client.listPushNotificationConfigs(task.id);
      expect(configs).toHaveLength(2);

      const urls = configs.map((c) => c.pushNotificationConfig.url);
      expect(urls).toContain('https://example.com/hook-a');
      expect(urls).toContain('https://example.com/hook-b');
    });

    it('deletes a push notification config', async () => {
      const task = await send('Hello');

      const created = await client.setPushNotificationConfig(task.id, {
        url: 'https://example.com/hook-del',
      });

      await client.deletePushNotificationConfig(task.id, created.pushNotificationConfig.id ?? '');

      const remaining = await client.listPushNotificationConfigs(task.id);
      expect(remaining).toHaveLength(0);
    });

    it('rejects push notification configs for unknown tasks (TaskNotFound)', async () => {
      const error = await client
        .setPushNotificationConfig('nonexistent_task_xyz', { url: 'https://example.com/hook' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(A2AError);
      expect((error as A2AError).code).toBe(-32001);
    });
  });

  describe('webhook delivery', () => {
    let webhookServer: http.Server;
    let webhookUrl: string;
    let received: { task: A2ATask; token: string | undefined }[];

    beforeAll(async () => {
      received = [];
      webhookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          const token = req.headers[NOTIFICATION_TOKEN_HEADER.toLowerCase()];
          received.push({
            task: JSON.parse(body) as A2ATask,
            token: Array.isArray(token) ? token[0] : token,
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

    it('webhook receives the task as it changes until it completes', async () => {
      const task = asTask(
        await client.sendMessage(
          { role: 'user', parts: [{ kind: 'text', text: 'First message' }] },
          { pushNotificationConfig: { url: webhookUrl, token: 'webhook-token' } }
        )
      );
      expect(task.status.state).toBe('completed');

      for (let i = 0; i < 50; i++) {
        if (received.some((e) => e.task.id === task.id && e.task.status.state === 'completed')) {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const forTask = received.filter((e) => e.task.id === task.id);
      expect(forTask.length).toBeGreaterThan(0);
      expect(forTask.every((e) => e.task.kind === 'task')).toBe(true);
      expect(forTask.every((e) => e.token === 'webhook-token')).toBe(true);
      expect(forTask.some((e) => e.task.status.state === 'completed')).toBe(true);
    });
  });
});
