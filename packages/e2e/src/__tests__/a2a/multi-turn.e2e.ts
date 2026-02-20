import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, type CogitatorLike, type A2ATask } from '@cogitator-ai/a2a';
import type { AgentRunResult } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

let callCount = 0;

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

describe('A2A v2: Multi-turn Conversations + ListTasks', () => {
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const cogitator = createMockCogitator();
    testServer = await startTestA2AServer({
      agents: { 'multi-turn-agent': createMockAgent('multi-turn-agent') },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
  });

  describe('multi-turn', () => {
    it('creates a task and continues it, history accumulates', async () => {
      const task1 = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Hello, who are you?' }],
      });

      expect(task1.id).toBeDefined();
      expect(task1.status.state).toBe('completed');
      expect(task1.history.length).toBeGreaterThanOrEqual(2);

      const task2 = await client.continueTask(task1.id, 'Tell me more about yourself');

      expect(task2.id).toBe(task1.id);
      expect(task2.contextId).toBe(task1.contextId);
      expect(task2.status.state).toBe('completed');
      expect(task2.history.length).toBeGreaterThanOrEqual(4);

      const userMessages = task2.history.filter((m) => m.role === 'user');
      const agentMessages = task2.history.filter((m) => m.role === 'agent');
      expect(userMessages.length).toBe(2);
      expect(agentMessages.length).toBe(2);
    });

    it('preserves contextId across turns', async () => {
      const contextId = 'ctx_shared_e2e';
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Start conversation' }],
        contextId,
      });

      expect(task.contextId).toBe(contextId);

      const continued = await client.continueTask(task.id, 'Continue conversation');
      expect(continued.contextId).toBe(contextId);
    });

    it('supports three turns of conversation', async () => {
      const task1 = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Turn 1' }],
      });
      const task2 = await client.continueTask(task1.id, 'Turn 2');
      const task3 = await client.continueTask(task2.id, 'Turn 3');

      expect(task3.id).toBe(task1.id);
      expect(task3.history.length).toBeGreaterThanOrEqual(6);

      const userMessages = task3.history.filter((m) => m.role === 'user');
      expect(userMessages.length).toBe(3);
    });

    it('returns error when continuing nonexistent task', async () => {
      await expect(client.continueTask('nonexistent_task_xyz', 'Hello')).rejects.toThrow();
    });

    it('retrieved task matches final state after multi-turn', async () => {
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'First message' }],
      });
      await client.continueTask(task.id, 'Second message');

      const retrieved = await client.getTask(task.id);
      expect(retrieved.id).toBe(task.id);
      expect(retrieved.history.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('listTasks', () => {
    let testServer2: TestA2AServer;
    let client2: A2AClient;

    beforeAll(async () => {
      testServer2 = await startTestA2AServer({
        agents: { 'list-agent': createMockAgent('list-agent') },
        cogitator: createMockCogitator(),
      });
      client2 = new A2AClient(testServer2.url);
    });

    afterAll(async () => {
      await testServer2?.close();
    });

    it('lists all created tasks', async () => {
      await client2.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'Task A' }] });
      await client2.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'Task B' }] });
      await client2.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'Task C' }] });

      const tasks = await client2.listTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(3);
    });

    it('filters tasks by contextId', async () => {
      const ctx = 'e2e_filter_ctx';
      await client2.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Filtered task 1' }],
        contextId: ctx,
      });
      await client2.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Filtered task 2' }],
        contextId: ctx,
      });
      await client2.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Other context' }],
        contextId: 'other_ctx',
      });

      const filtered = await client2.listTasks({ contextId: ctx });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((t: A2ATask) => t.contextId === ctx)).toBe(true);
    });

    it('supports pagination with limit', async () => {
      const paginated = await client2.listTasks({ limit: 2 });
      expect(paginated.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array for unknown contextId', async () => {
      const tasks = await client2.listTasks({ contextId: 'completely_unknown_ctx' });
      expect(tasks).toEqual([]);
    });
  });
});
