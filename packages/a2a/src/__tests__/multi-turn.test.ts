import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager } from '../task-manager';
import type { CogitatorLike, AgentRunResult } from '../types';
import { A2AServer } from '../server';
import { A2AError } from '../errors';
import type { A2AMessage, A2AStreamEvent } from '../types';
import type { Agent, AgentConfig } from '@cogitator-ai/types';

function createUserMessage(text: string, extra?: Partial<A2AMessage>): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }], ...extra };
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

describe('Multi-turn conversations', () => {
  describe('TaskManager', () => {
    let manager: TaskManager;

    beforeEach(() => {
      manager = new TaskManager();
    });

    it('should continue a task with new message', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);
      const cogitator = createMockCogitator('First response');
      await manager.executeTask(task, cogitator, {}, msg);

      const followUp = createUserMessage('Tell me more');
      const continued = await manager.continueTask(task.id, followUp);
      expect(continued.status.state).toBe('working');
      expect(continued.history).toHaveLength(3);
    });

    it('should preserve history across turns', async () => {
      const msg1 = createUserMessage('First question');
      const task = await manager.createTask(msg1);
      const cogitator = createMockCogitator('Answer 1');
      await manager.executeTask(task, cogitator, {}, msg1);

      const msg2 = createUserMessage('Follow-up');
      const continued = await manager.continueTask(task.id, msg2);

      expect(continued.history).toHaveLength(3);
      expect(continued.history[0].parts[0]).toEqual({ type: 'text', text: 'First question' });
      expect(continued.history[1].role).toBe('agent');
      expect(continued.history[2].parts[0]).toEqual({ type: 'text', text: 'Follow-up' });
    });

    it('should use same contextId for continued tasks', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg, 'my_ctx');
      const cogitator = createMockCogitator('Response');
      await manager.executeTask(task, cogitator, {}, msg);

      const followUp = createUserMessage('More');
      const continued = await manager.continueTask(task.id, followUp);
      expect(continued.contextId).toBe('my_ctx');
    });

    it('should reject continuing a canceled task', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);
      await manager.cancelTask(task.id);

      const followUp = createUserMessage('Continue?');
      await expect(manager.continueTask(task.id, followUp)).rejects.toThrow(A2AError);
    });

    it('should reject continuing a failed task', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);
      await manager.failTask(task.id, 'Something went wrong');

      const followUp = createUserMessage('Retry?');
      await expect(manager.continueTask(task.id, followUp)).rejects.toThrow(A2AError);
    });

    it('should reject continuing a working task', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);

      const followUp = createUserMessage('While working?');
      await expect(manager.continueTask(task.id, followUp)).rejects.toThrow(A2AError);
    });

    it('should throw for unknown taskId', async () => {
      const msg = createUserMessage('Hello');
      await expect(manager.continueTask('nonexistent', msg)).rejects.toThrow(A2AError);
    });

    it('should continue a task in input-required state', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);

      const store = (
        manager as unknown as { store: { update: (id: string, data: unknown) => Promise<void> } }
      ).store;
      await store.update(task.id, {
        status: { state: 'input-required', timestamp: new Date().toISOString() },
      });

      const followUp = createUserMessage('Here is the input you requested');
      const continued = await manager.continueTask(task.id, followUp);
      expect(continued.status.state).toBe('working');
      expect(continued.history).toHaveLength(2);
    });

    it('should create task with provided contextId', async () => {
      const task = await manager.createTask(createUserMessage('Hi'), 'shared_ctx');
      expect(task.contextId).toBe('shared_ctx');
    });

    it('should link tasks via contextId', async () => {
      const contextId = 'shared_conversation';
      await manager.createTask(createUserMessage('First'), contextId);
      await manager.createTask(createUserMessage('Second'), contextId);

      const tasks = await manager.listTasks({ contextId });
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.contextId === contextId)).toBe(true);
    });

    it('should emit status-update on continue', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);
      const cogitator = createMockCogitator('Response');
      await manager.executeTask(task, cogitator, {}, msg);

      const events: A2AStreamEvent[] = [];
      manager.on('event', (e) => events.push(e));

      const followUp = createUserMessage('More');
      await manager.continueTask(task.id, followUp);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const statusEvent = events.find((e) => e.type === 'status-update');
      expect(statusEvent).toBeDefined();
      if (statusEvent?.type === 'status-update') {
        expect(statusEvent.status.state).toBe('working');
      }
    });
  });

  describe('A2AServer', () => {
    let server: A2AServer;
    let cogitator: CogitatorLike;

    beforeEach(() => {
      cogitator = createMockCogitator('Agent says hi');
      server = new A2AServer({
        agents: { helper: createMockAgent('helper') },
        cogitator,
      });
    });

    it('should handle message/send with taskId (continuation)', async () => {
      const firstResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('Hello') },
        id: 1,
      });
      const firstTask = firstResponse.result as { id: string; contextId: string };

      const secondResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: createUserMessage('Follow-up', { taskId: firstTask.id }),
        },
        id: 2,
      });
      expect(secondResponse.error).toBeUndefined();
      const secondTask = secondResponse.result as {
        id: string;
        contextId: string;
        history: A2AMessage[];
      };
      expect(secondTask.id).toBe(firstTask.id);
      expect(secondTask.contextId).toBe(firstTask.contextId);
      expect(secondTask.history.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle message/send with contextId (new task in same context)', async () => {
      const ctx = 'my_context';

      const firstResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('Hello', { contextId: ctx }) },
        id: 1,
      });
      const firstTask = firstResponse.result as { id: string; contextId: string };
      expect(firstTask.contextId).toBe(ctx);

      const secondResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('New task, same context', { contextId: ctx }) },
        id: 2,
      });
      const secondTask = secondResponse.result as { id: string; contextId: string };
      expect(secondTask.contextId).toBe(ctx);
      expect(secondTask.id).not.toBe(firstTask.id);
    });

    it('should handle multi-turn streaming', async () => {
      const firstResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: createUserMessage('Hello') },
        id: 1,
      });
      const firstTask = firstResponse.result as { id: string };

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: {
          message: createUserMessage('Stream follow-up', { taskId: firstTask.id }),
        },
        id: 2,
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const statusEvents = events.filter((e) => e.type === 'status-update');
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.taskId === firstTask.id)).toBe(true);
    });

    it('should return error for continuing non-existent task', async () => {
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: createUserMessage('Follow-up', { taskId: 'nonexistent' }),
        },
        id: 1,
      });
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });
  });
});
