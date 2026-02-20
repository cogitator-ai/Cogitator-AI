import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager, type CogitatorLike, type AgentRunResult } from '../task-manager';
import { A2AServer } from '../server';
import { InMemoryTaskStore } from '../task-store';
import type { A2AMessage, A2ATask, A2AStreamEvent } from '../types';
import type { Agent, AgentConfig } from '@cogitator-ai/types';

function createUserMessage(text: string): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

function createMockRunResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
    toolCalls: [],
  };
}

function createMockCogitator(output: string = 'response'): CogitatorLike {
  return { run: vi.fn().mockResolvedValue(createMockRunResult(output)) };
}

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

describe('ListTasks', () => {
  describe('TaskManager', () => {
    let manager: TaskManager;

    beforeEach(() => {
      manager = new TaskManager();
    });

    it('should list all tasks', async () => {
      await manager.createTask(createUserMessage('Task 1'));
      await manager.createTask(createUserMessage('Task 2'));
      await manager.createTask(createUserMessage('Task 3'));

      const tasks = await manager.listTasks();
      expect(tasks).toHaveLength(3);
    });

    it('should filter by contextId', async () => {
      await manager.createTask(createUserMessage('A1'), 'ctx_a');
      await manager.createTask(createUserMessage('B1'), 'ctx_b');
      await manager.createTask(createUserMessage('A2'), 'ctx_a');

      const tasks = await manager.listTasks({ contextId: 'ctx_a' });
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.contextId === 'ctx_a')).toBe(true);
    });

    it('should filter by state', async () => {
      const msg1 = createUserMessage('Will complete');
      const task1 = await manager.createTask(msg1);
      const cogitator = createMockCogitator('Done');
      await manager.executeTask(task1, cogitator, {}, msg1);

      await manager.createTask(createUserMessage('Still working'));

      const completed = await manager.listTasks({ state: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].status.state).toBe('completed');

      const working = await manager.listTasks({ state: 'working' });
      expect(working).toHaveLength(1);
      expect(working[0].status.state).toBe('working');
    });

    it('should support pagination with limit/offset', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.createTask(createUserMessage(`Task ${i}`));
      }

      const page1 = await manager.listTasks({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await manager.listTasks({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = await manager.listTasks({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    it('should return empty array when no tasks match', async () => {
      const tasks = await manager.listTasks({ contextId: 'nonexistent' });
      expect(tasks).toEqual([]);
    });
  });

  describe('InMemoryTaskStore sorting', () => {
    it('should return tasks sorted by newest first', async () => {
      const store = new InMemoryTaskStore();

      const older: A2ATask = {
        id: 'task_old',
        contextId: 'ctx',
        status: { state: 'completed', timestamp: '2025-01-01T00:00:00.000Z' },
        history: [],
        artifacts: [],
      };
      const newer: A2ATask = {
        id: 'task_new',
        contextId: 'ctx',
        status: { state: 'completed', timestamp: '2025-06-01T00:00:00.000Z' },
        history: [],
        artifacts: [],
      };
      const middle: A2ATask = {
        id: 'task_mid',
        contextId: 'ctx',
        status: { state: 'completed', timestamp: '2025-03-15T00:00:00.000Z' },
        history: [],
        artifacts: [],
      };

      await store.create(older);
      await store.create(newer);
      await store.create(middle);

      const tasks = await store.list();
      expect(tasks[0].id).toBe('task_new');
      expect(tasks[1].id).toBe('task_mid');
      expect(tasks[2].id).toBe('task_old');
    });
  });

  describe('A2AServer', () => {
    let server: A2AServer;
    let cogitator: CogitatorLike;

    beforeEach(() => {
      cogitator = createMockCogitator('Agent response');
      server = new A2AServer({
        agents: { helper: createMockAgent('helper') },
        cogitator,
      });
    });

    it('should handle tasks/list JSON-RPC method', async () => {
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('Task 1') },
        id: 1,
      });
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('Task 2') },
        id: 2,
      });

      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/list',
        params: {},
        id: 3,
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { tasks: A2ATask[] };
      expect(result.tasks).toHaveLength(2);
    });

    it('should filter tasks/list by contextId', async () => {
      const ctx = 'filter_ctx';
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ type: 'text', text: 'A' }], contextId: ctx } },
        id: 1,
      });
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('B') },
        id: 2,
      });

      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/list',
        params: { contextId: ctx },
        id: 3,
      });

      const result = response.result as { tasks: A2ATask[] };
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].contextId).toBe(ctx);
    });

    it('should support pagination in tasks/list', async () => {
      for (let i = 0; i < 5; i++) {
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: createUserMessage(`Task ${i}`) },
          id: i + 1,
        });
      }

      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/list',
        params: { limit: 2 },
        id: 10,
      });

      const result = response.result as { tasks: A2ATask[] };
      expect(result.tasks).toHaveLength(2);
    });

    it('should return empty tasks array when no tasks exist', async () => {
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/list',
        params: {},
        id: 1,
      });

      const result = response.result as { tasks: A2ATask[] };
      expect(result.tasks).toEqual([]);
    });
  });
});
