import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager, type CogitatorLike, type AgentRunResult } from '../task-manager';
import { A2AError } from '../errors';
import type { A2AMessage, A2AStreamEvent } from '../types';

function createUserMessage(text: string): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

function createMockRunResult(output: string, structured?: unknown): AgentRunResult {
  return {
    output,
    structured,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
    toolCalls: [],
  };
}

function createMockCogitator(result: AgentRunResult): CogitatorLike {
  return { run: vi.fn().mockResolvedValue(result) };
}

describe('TaskManager', () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager();
  });

  describe('createTask', () => {
    it('should create a task with working state', async () => {
      const msg = createUserMessage('Hello');
      const task = await manager.createTask(msg);
      expect(task.id).toMatch(/^task_/);
      expect(task.contextId).toMatch(/^ctx_/);
      expect(task.status.state).toBe('working');
      expect(task.history).toHaveLength(1);
      expect(task.history[0]).toEqual(msg);
    });

    it('should use provided contextId', async () => {
      const task = await manager.createTask(createUserMessage('Hi'), 'my_ctx');
      expect(task.contextId).toBe('my_ctx');
    });

    it('should emit status-update event on create', async () => {
      const events: A2AStreamEvent[] = [];
      manager.on('event', (e) => events.push(e));
      await manager.createTask(createUserMessage('Hi'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('status-update');
    });
  });

  describe('executeTask', () => {
    it('should complete task on successful run', async () => {
      const msg = createUserMessage('Research AI');
      const task = await manager.createTask(msg);
      const result = createMockRunResult('AI is interesting');
      const cogitator = createMockCogitator(result);

      const completed = await manager.executeTask(task, cogitator, {}, msg);
      expect(completed.status.state).toBe('completed');
      expect(completed.artifacts.length).toBeGreaterThan(0);
    });

    it('should call cogitator.run with correct input', async () => {
      const msg = createUserMessage('Do something');
      const task = await manager.createTask(msg);
      const result = createMockRunResult('Done');
      const cogitator = createMockCogitator(result);

      await manager.executeTask(task, cogitator, { name: 'test' }, msg);
      expect(cogitator.run).toHaveBeenCalledWith(
        { name: 'test' },
        expect.objectContaining({ input: 'Do something' })
      );
    });

    it('should fail task on error', async () => {
      const msg = createUserMessage('Crash');
      const task = await manager.createTask(msg);
      const cogitator: CogitatorLike = {
        run: vi.fn().mockRejectedValue(new Error('LLM failure')),
      };

      const failed = await manager.executeTask(task, cogitator, {}, msg);
      expect(failed.status.state).toBe('failed');
      expect(failed.status.message).toContain('LLM failure');
    });

    it('should include structured data as artifact', async () => {
      const msg = createUserMessage('Get data');
      const task = await manager.createTask(msg);
      const result = createMockRunResult('Here is data', { total: 42, items: [] });
      const cogitator = createMockCogitator(result);

      const completed = await manager.executeTask(task, cogitator, {}, msg);
      const jsonArtifact = completed.artifacts.find((a) => a.mimeType === 'application/json');
      expect(jsonArtifact).toBeDefined();
    });
  });

  describe('cancelTask', () => {
    it('should cancel a working task', async () => {
      const msg = createUserMessage('Long task');
      const task = await manager.createTask(msg);

      const canceled = await manager.cancelTask(task.id);
      expect(canceled.status.state).toBe('canceled');
    });

    it('should throw on canceling a completed task', async () => {
      const msg = createUserMessage('Quick');
      const task = await manager.createTask(msg);
      const cogitator = createMockCogitator(createMockRunResult('Done'));
      await manager.executeTask(task, cogitator, {}, msg);

      await expect(manager.cancelTask(task.id)).rejects.toThrow(A2AError);
    });

    it('should throw taskNotFound for unknown task', async () => {
      await expect(manager.cancelTask('nonexistent')).rejects.toThrow(A2AError);
    });
  });

  describe('getTask', () => {
    it('should return task by id', async () => {
      const msg = createUserMessage('Hi');
      const task = await manager.createTask(msg);
      const retrieved = await manager.getTask(task.id);
      expect(retrieved.id).toBe(task.id);
    });

    it('should throw for unknown task', async () => {
      await expect(manager.getTask('nonexistent')).rejects.toThrow(A2AError);
    });
  });

  describe('events', () => {
    it('should emit events during task lifecycle', async () => {
      const events: A2AStreamEvent[] = [];
      manager.on('event', (e) => events.push(e));

      const msg = createUserMessage('Work');
      const task = await manager.createTask(msg);
      const cogitator = createMockCogitator(createMockRunResult('Result'));
      await manager.executeTask(task, cogitator, {}, msg);

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe('status-update');
      const statusEvents = events.filter((e) => e.type === 'status-update');
      expect(statusEvents[0]).toHaveProperty('status.state', 'working');
    });
  });
});
