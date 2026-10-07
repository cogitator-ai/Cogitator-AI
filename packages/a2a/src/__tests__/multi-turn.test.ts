import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager, type TaskEvent } from '../task-manager';
import type { CogitatorLike, AgentRunResult, A2ATask } from '../types';
import { A2AServer } from '../server';
import { A2AError } from '../errors';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { collectEvents, expectResponse, userMessage } from './helpers';

function createMockRunResult(output: string, requiresInput = false): AgentRunResult {
  return {
    output,
    requiresInput,
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

/** Asks for a name first, then answers. */
function askingCogitator(): CogitatorLike {
  return {
    run: vi
      .fn()
      .mockResolvedValueOnce(createMockRunResult('What is your name?', true))
      .mockResolvedValue(createMockRunResult('Nice to meet you')),
  };
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

    async function waitingTask(): Promise<A2ATask> {
      const msg = userMessage('Hello');
      const task = await manager.createTask(msg);
      const asked = await manager.executeTask(task, askingCogitator(), {}, msg);
      expect(asked.status.state).toBe('input-required');
      return asked;
    }

    it('should continue a task waiting for input', async () => {
      const task = await waitingTask();
      const continued = await manager.continueTask(task.id, userMessage('Ada'));
      expect(continued.status.state).toBe('working');
      expect(continued.history).toHaveLength(3);
    });

    it('should preserve history across turns', async () => {
      const task = await waitingTask();
      const continued = await manager.continueTask(task.id, userMessage('Ada'));

      expect(continued.history![0].parts[0]).toEqual({ kind: 'text', text: 'Hello' });
      expect(continued.history![1].role).toBe('agent');
      expect(continued.history![2]).toMatchObject({
        parts: [{ kind: 'text', text: 'Ada' }],
        taskId: task.id,
        contextId: task.contextId,
      });
    });

    it('should replay the earlier turns to the agent', async () => {
      const task = await waitingTask();
      const answer = userMessage('Ada');
      const continued = await manager.continueTask(task.id, answer);
      const cogitator = createMockCogitator('Hi Ada');
      await manager.executeTask(continued, cogitator, {}, answer);

      expect(cogitator.run).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          input: expect.stringContaining('Agent: What is your name?'),
          loadHistory: false,
        })
      );
    });

    it('should refuse a message for a completed task: a terminal task cannot be restarted', async () => {
      const msg = userMessage('Hello');
      const task = await manager.createTask(msg);
      await manager.executeTask(task, createMockCogitator('First response'), {}, msg);

      await expect(manager.continueTask(task.id, userMessage('More'))).rejects.toMatchObject({
        code: -32600,
      });
    });

    it('should reject continuing a canceled task', async () => {
      const task = await manager.createTask(userMessage('Hello'));
      await manager.cancelTask(task.id);
      await expect(manager.continueTask(task.id, userMessage('Continue?'))).rejects.toThrow(
        A2AError
      );
    });

    it('should reject continuing a failed task', async () => {
      const task = await manager.createTask(userMessage('Hello'));
      await manager.failTask(task.id, 'Something went wrong');
      await expect(manager.continueTask(task.id, userMessage('Retry?'))).rejects.toThrow(A2AError);
    });

    it('should reject continuing a task that was just submitted', async () => {
      const task = await manager.createTask(userMessage('Hello'));
      await expect(manager.continueTask(task.id, userMessage('While working?'))).rejects.toThrow(
        A2AError
      );
    });

    it('should throw for unknown taskId', async () => {
      await expect(manager.continueTask('nonexistent', userMessage('Hello'))).rejects.toThrow(
        A2AError
      );
    });

    it('should continue a task waiting for authentication', async () => {
      const task = await manager.createTask(userMessage('Hello'));
      const store = (
        manager as unknown as { store: { update: (id: string, data: unknown) => Promise<void> } }
      ).store;
      await store.update(task.id, {
        status: { state: 'auth-required', timestamp: new Date().toISOString() },
      });

      const continued = await manager.continueTask(task.id, userMessage('Signed in'));
      expect(continued.status.state).toBe('working');
    });

    it('should link tasks via contextId', async () => {
      const contextId = 'shared_conversation';
      await manager.createTask(userMessage('First'), contextId);
      await manager.createTask(userMessage('Second'), contextId);

      const tasks = await manager.listTasks({ contextId });
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.contextId === contextId)).toBe(true);
    });

    it('should emit a working status update on continue', async () => {
      const task = await waitingTask();
      const events: TaskEvent[] = [];
      manager.on('event', (e: TaskEvent) => events.push(e));

      await manager.continueTask(task.id, userMessage('Ada'));

      expect(events).toEqual([
        expect.objectContaining({
          kind: 'status-update',
          taskId: task.id,
          final: false,
          status: expect.objectContaining({ state: 'working' }),
        }),
      ]);
    });
  });

  describe('A2AServer', () => {
    let server: A2AServer;
    let cogitator: CogitatorLike;

    beforeEach(() => {
      cogitator = askingCogitator();
      server = new A2AServer({
        agents: { helper: createMockAgent('helper') },
        cogitator,
      });
    });

    async function send(message: ReturnType<typeof userMessage>, id = 1) {
      return expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message },
          id,
        })
      );
    }

    it('should answer an input-required task with message/send and its taskId', async () => {
      const first = (await send(userMessage('Hello'))).result as A2ATask;
      expect(first.status.state).toBe('input-required');

      const second = await send(userMessage('Ada', { taskId: first.id }), 2);
      expect(second.error).toBeUndefined();
      const task = second.result as A2ATask;
      expect(task.id).toBe(first.id);
      expect(task.contextId).toBe(first.contextId);
      expect(task.status.state).toBe('completed');
      expect(task.history).toHaveLength(4);
    });

    it('should refuse a contextId that does not match the task', async () => {
      const first = (await send(userMessage('Hello'))).result as A2ATask;
      const response = await send(userMessage('Ada', { taskId: first.id, contextId: 'other' }), 2);
      expect(response.error?.code).toBe(-32602);
    });

    it('should carry a conversation on in a new task of the same context', async () => {
      const ctx = 'my_context';
      const replying = createMockCogitator('Noted');
      server = new A2AServer({
        agents: { helper: createMockAgent('helper') },
        cogitator: replying,
      });

      const first = (await send(userMessage('My name is Ada', { contextId: ctx })))
        .result as A2ATask;
      expect(first.contextId).toBe(ctx);
      expect(first.status.state).toBe('completed');

      const second = (await send(userMessage('What is my name?', { contextId: ctx }), 2))
        .result as A2ATask;
      expect(second.contextId).toBe(ctx);
      expect(second.id).not.toBe(first.id);
      expect(replying.run).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.stringContaining('User: My name is Ada'),
          threadId: ctx,
          loadHistory: false,
        })
      );
    });

    it('should stream the answer to an input-required task', async () => {
      const first = (await send(userMessage('Hello'))).result as A2ATask;

      const events = await collectEvents(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/stream',
          params: { message: userMessage('Ada', { taskId: first.id }) },
          id: 2,
        })
      );

      expect(events[0]).toMatchObject({ kind: 'task', id: first.id });
      const last = events.at(-1);
      expect(last).toMatchObject({ kind: 'status-update', final: true, taskId: first.id });
    });

    it('should return error for continuing non-existent task', async () => {
      const response = await send(userMessage('Follow-up', { taskId: 'nonexistent' }));
      expect(response.error!.code).toBe(-32001);
    });
  });
});
