import { describe, it, expect, beforeEach } from 'vitest';
import { TaskManager } from '../task-manager';
import type { TaskEvent } from '../task-manager';
import { A2AError } from '../errors';
import { messageText } from '../protocol';
import { TASK_AGENT_KEY } from '../ownership';
import type { A2AMessage, AgentRunResult, CogitatorLike } from '../types';

function userMessage(text: string): A2AMessage {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
  };
}

describe('tasks carried out outside the manager', () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager();
  });

  describe('createTask metadata', () => {
    it('stores the given metadata with the task', async () => {
      const task = await manager.createTask(userMessage('Do it'), undefined, {
        metadata: { 'example:job': { number: 7, checks: ['pnpm test'] } },
      });

      const stored = await manager.getTask(task.id);
      expect(stored.metadata?.['example:job']).toEqual({ number: 7, checks: ['pnpm test'] });
    });

    it('keeps its own keys over the same keys of the given metadata', async () => {
      const task = await manager.createTask(userMessage('Do it'), undefined, {
        agentName: 'writer',
        metadata: { [TASK_AGENT_KEY]: 'someone-else', extra: true },
      });

      expect(task.metadata?.[TASK_AGENT_KEY]).toBe('writer');
      expect(task.metadata?.extra).toBe(true);
    });

    it('does not share the given object with the stored task', async () => {
      const metadata = { nested: { value: 1 } };
      const task = await manager.createTask(userMessage('Do it'), undefined, { metadata });
      metadata.nested.value = 2;

      const stored = await manager.getTask(task.id);
      expect(stored.metadata?.nested).toEqual({ value: 1 });
    });
  });

  describe('advanceTask', () => {
    it('takes a submitted task into work', async () => {
      const task = await manager.createTask(userMessage('Do it'));

      const working = await manager.advanceTask(task.id, { state: 'working' });

      expect(working.status.state).toBe('working');
      expect(working.status.message).toBeUndefined();
      expect(working.history).toHaveLength(1);
    });

    it('asks for input with a question the client then answers', async () => {
      const task = await manager.createTask(userMessage('Write the tests'));
      await manager.advanceTask(task.id, { state: 'working' });

      const waiting = await manager.advanceTask(task.id, {
        state: 'input-required',
        message: 'Mock Redis or run a real one?',
      });
      expect(waiting.status.state).toBe('input-required');
      expect(messageText(waiting.status.message)).toBe('Mock Redis or run a real one?');
      expect(waiting.history?.at(-1)).toMatchObject({ role: 'agent', taskId: task.id });

      const resumed = await manager.continueTask(task.id, userMessage('Mock it'));
      expect(resumed.status.state).toBe('working');
      expect(resumed.history?.map((message) => message.role)).toEqual(['user', 'agent', 'user']);
    });

    it('finishes a task with its result', async () => {
      const task = await manager.createTask(userMessage('Do it'));
      await manager.advanceTask(task.id, { state: 'working' });

      const done = await manager.advanceTask(task.id, {
        state: 'completed',
        message: [{ kind: 'text', text: 'Done: 14 tests' }],
      });

      expect(done.status.state).toBe('completed');
      expect(messageText(done.status.message)).toBe('Done: 14 tests');
    });

    it('does not move a finished task', async () => {
      const task = await manager.createTask(userMessage('Do it'));
      await manager.advanceTask(task.id, { state: 'failed', message: 'No access' });

      await expect(manager.advanceTask(task.id, { state: 'working' })).rejects.toThrow(A2AError);
      await expect(manager.advanceTask(task.id, { state: 'completed' })).rejects.toMatchObject({
        jsonRpcError: { data: { taskId: task.id, state: 'failed' } },
      });
      expect((await manager.getTask(task.id)).status.state).toBe('failed');
    });

    it('does not move a task a run of the manager is executing', async () => {
      const task = await manager.createTask(userMessage('Do it'));
      let release!: (result: AgentRunResult) => void;
      const cogitator: CogitatorLike = {
        run: () => new Promise<AgentRunResult>((resolve) => (release = resolve)),
      };
      const running = manager.executeTask(task, cogitator, {}, userMessage('Do it'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(manager.advanceTask(task.id, { state: 'completed' })).rejects.toThrow(A2AError);

      release({
        output: 'From the run',
        runId: 'run_1',
        agentId: 'agent_1',
        threadId: 'thread_1',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
        toolCalls: [],
      });
      const finished = await running;
      expect(messageText(finished.status.message)).toBe('From the run');
    });

    it('throws taskNotFound for an unknown task', async () => {
      await expect(manager.advanceTask('nope', { state: 'working' })).rejects.toThrow(A2AError);
    });

    it('emits a status update, final for a state the stream ends on', async () => {
      const events: TaskEvent[] = [];
      const task = await manager.createTask(userMessage('Do it'));
      manager.on('event', (event: TaskEvent) => events.push(event));

      await manager.advanceTask(task.id, { state: 'working' });
      await manager.advanceTask(task.id, { state: 'input-required', message: 'Which one?' });

      expect(events).toMatchObject([
        { kind: 'status-update', taskId: task.id, final: false, status: { state: 'working' } },
        {
          kind: 'status-update',
          taskId: task.id,
          final: true,
          status: { state: 'input-required' },
        },
      ]);
    });

    it('ignores an empty message', async () => {
      const task = await manager.createTask(userMessage('Do it'));

      const working = await manager.advanceTask(task.id, { state: 'working', message: [] });

      expect(working.status.message).toBeUndefined();
      expect(working.history).toHaveLength(1);
    });
  });
});
