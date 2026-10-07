import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, messageText, type CogitatorLike, type A2ATask } from '@cogitator-ai/a2a';
import type { AgentRunResult } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import {
  asTask,
  createStubAgent,
  startTestA2AServer,
  type TestA2AServer,
} from '../../helpers/a2a-server';

let callCount = 0;

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
    instructions: 'test',
    description: `${name} agent`,
  };
  return createStubAgent(config);
}

function createMockRunResult(output: string, requiresInput = false): AgentRunResult {
  return {
    output,
    requiresInput,
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
      const latest = options.input.split('User: ').at(-1) ?? options.input;
      if (latest.includes('[ask]')) {
        return createMockRunResult('How many guests?', true);
      }
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
    async function send(text: string, contextId?: string): Promise<A2ATask> {
      return asTask(
        await client.sendMessage({
          role: 'user',
          parts: [{ kind: 'text', text }],
          ...(contextId && { contextId }),
        })
      );
    }

    it('answers an input-required task in the same task, history accumulates', async () => {
      const task1 = await send('Book a table [ask]');

      expect(task1.id).toBeDefined();
      expect(task1.status.state).toBe('input-required');
      expect(messageText(task1.status.message)).toBe('How many guests?');

      const task2 = asTask(await client.continueTask(task1.id, 'Four guests'));

      expect(task2.id).toBe(task1.id);
      expect(task2.contextId).toBe(task1.contextId);
      expect(task2.status.state).toBe('completed');
      expect(messageText(task2.status.message)).toContain('Book a table');
      expect(messageText(task2.status.message)).toContain('Four guests');

      const history = task2.history ?? [];
      expect(history.filter((m) => m.role === 'user')).toHaveLength(2);
      expect(history.filter((m) => m.role === 'agent')).toHaveLength(2);
    });

    it('continues a conversation with a new task in the same context', async () => {
      const task1 = await send('Hello, who are you?');
      expect(task1.status.state).toBe('completed');
      expect(task1.history?.length).toBeGreaterThanOrEqual(2);

      const task2 = await send('Tell me more about yourself', task1.contextId);

      expect(task2.id).not.toBe(task1.id);
      expect(task2.contextId).toBe(task1.contextId);
      expect(task2.status.state).toBe('completed');
      expect(messageText(task2.status.message)).toContain('Hello, who are you?');
      expect(messageText(task2.status.message)).toContain('Tell me more about yourself');
    });

    it('preserves a client-chosen contextId across turns', async () => {
      const contextId = 'ctx_shared_e2e';
      const task = await send('Start conversation', contextId);
      expect(task.contextId).toBe(contextId);

      const continued = await send('Continue conversation', contextId);
      expect(continued.contextId).toBe(contextId);

      const tasks = await client.listTasks({ contextId });
      expect(tasks.map((t) => t.id).sort()).toEqual([task.id, continued.id].sort());
    });

    it('supports three turns of conversation', async () => {
      const task1 = await send('Turn 1');
      const task2 = await send('Turn 2', task1.contextId);
      const task3 = await send('Turn 3', task2.contextId);

      expect(task3.contextId).toBe(task1.contextId);
      const reply = messageText(task3.status.message);
      expect(reply).toContain('Turn 1');
      expect(reply).toContain('Turn 2');
      expect(reply).toContain('Turn 3');

      const tasks = await client.listTasks({ contextId: task1.contextId });
      expect(tasks).toHaveLength(3);
    });

    it('refuses to continue a completed task', async () => {
      const task = await send('Finish right away');
      expect(task.status.state).toBe('completed');

      await expect(client.continueTask(task.id, 'One more thing')).rejects.toMatchObject({
        code: -32600,
      });
    });

    it('returns error when continuing nonexistent task', async () => {
      await expect(client.continueTask('nonexistent_task_xyz', 'Hello')).rejects.toMatchObject({
        code: -32001,
      });
    });

    it('retrieved task matches final state after multi-turn', async () => {
      const task = await send('First message [ask]');
      await client.continueTask(task.id, 'Second message');

      const retrieved = await client.getTask(task.id);
      expect(retrieved.id).toBe(task.id);
      expect(retrieved.status.state).toBe('completed');
      expect(retrieved.history?.length).toBeGreaterThanOrEqual(4);
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
      await client2.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Task A' }] });
      await client2.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Task B' }] });
      await client2.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Task C' }] });

      const tasks = await client2.listTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(3);
    });

    it('filters tasks by contextId', async () => {
      const ctx = 'e2e_filter_ctx';
      await client2.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'Filtered task 1' }],
        contextId: ctx,
      });
      await client2.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'Filtered task 2' }],
        contextId: ctx,
      });
      await client2.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'Other context' }],
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
