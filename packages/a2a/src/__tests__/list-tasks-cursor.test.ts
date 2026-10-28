import { describe, it, expect } from 'vitest';
import { A2AError } from '../errors';
import { decodePageToken, encodePageToken, paginateTasks } from '../list-tasks';
import { InMemoryTaskStore } from '../task-store';
import { RedisTaskStore, type RedisClientLike } from '../redis-task-store';
import { A2AServer } from '../server';
import { compareTasksNewestFirst } from '../ownership';
import type { A2ATask, TaskState } from '../types';
import { expectResponse } from './helpers';
import { echoCogitator, mockAgent } from './v1-helpers';

function taskAt(id: string, time: string, state: TaskState = 'completed'): A2ATask {
  return { kind: 'task', id, contextId: 'ctx', status: { state, timestamp: time } };
}

const SAME = '2026-10-28T10:00:00.000Z';

function mapRedis(): RedisClientLike {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => data.set(key, value),
    del: async (key) => data.delete(key),
    keys: async (pattern) =>
      [...data.keys()].filter((key) => key.startsWith(pattern.replace(/\*$/, ''))),
  };
}

describe('keyset cursor of ListTasks', () => {
  it('encodes the cursor as base64url of { v, t, id }', () => {
    const token = encodePageToken(taskAt('task_a', SAME));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      t: Date.parse(SAME),
      id: 'task_a',
    });
    expect(decodePageToken(token)).toEqual({ t: Date.parse(SAME), id: 'task_a' });
  });

  it('refuses a token it did not issue, naming pageToken', () => {
    for (const token of ['not base64!', Buffer.from('{"v":2}').toString('base64url'), 'eyJ']) {
      try {
        decodePageToken(token);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(A2AError);
        expect((error as A2AError).code).toBe(-32602);
        expect((error as A2AError).fieldViolations?.[0].field).toBe('pageToken');
      }
    }
  });

  it('pages newest first, ties broken by id, without repeats or gaps', () => {
    const tasks = [
      taskAt('task_c', SAME),
      taskAt('task_a', SAME),
      taskAt('task_new', '2026-10-28T11:00:00.000Z'),
      taskAt('task_b', SAME),
      taskAt('task_old', '2026-10-28T09:00:00.000Z'),
    ];
    const seen: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = paginateTasks(tasks, { pageSize: 2, ...(pageToken && { pageToken }) });
      expect(page.totalSize).toBe(5);
      expect(page.pageSize).toBe(2);
      seen.push(...page.tasks.map((task) => task.id));
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
    expect(seen).toEqual(['task_new', 'task_c', 'task_b', 'task_a', 'task_old']);
  });

  it('resumes after the cursor even when tasks arrive between pages', () => {
    const tasks = [taskAt('task_1', SAME), taskAt('task_2', '2026-10-28T09:00:00.000Z')];
    const first = paginateTasks(tasks, { pageSize: 1 });
    const later = [...tasks, taskAt('task_0', '2026-10-28T12:00:00.000Z')];
    const second = paginateTasks(later, { pageSize: 1, pageToken: first.nextPageToken });
    expect(second.tasks.map((task) => task.id)).toEqual(['task_2']);
    expect(second.nextPageToken).toBe('');
  });

  it('filters by statusTimestampAfter, strictly after', () => {
    const tasks = [taskAt('task_1', SAME), taskAt('task_2', '2026-10-28T11:00:00.000Z')];
    expect(paginateTasks(tasks, { statusTimestampAfter: SAME }).tasks.map((t) => t.id)).toEqual([
      'task_2',
    ]);
  });

  it('keeps the insertion order of the stores for equal times, the cursor its total order', async () => {
    const tasks = [taskAt('task_a', SAME), taskAt('task_c', SAME), taskAt('task_b', SAME)];
    const store = new InMemoryTaskStore();
    for (const task of tasks) await store.create(task);
    expect((await store.list()).map((task) => task.id)).toEqual(['task_a', 'task_c', 'task_b']);
    expect(paginateTasks(await store.list(), {}).tasks.map((task) => task.id)).toEqual([
      'task_c',
      'task_b',
      'task_a',
    ]);
    expect([...tasks].sort(compareTasksNewestFirst).map((task) => task.id)).toEqual([
      'task_c',
      'task_b',
      'task_a',
    ]);
  });

  it('pages the same with RedisTaskStore', async () => {
    const store = new RedisTaskStore({ client: mapRedis() });
    for (const task of [taskAt('task_a', SAME), taskAt('task_b', SAME)]) await store.create(task);
    const first = paginateTasks(await store.list(), { pageSize: 1 });
    const second = paginateTasks(await store.list(), {
      pageSize: 1,
      pageToken: first.nextPageToken,
    });
    expect([...first.tasks, ...second.tasks].map((task) => task.id)).toEqual(['task_b', 'task_a']);
  });
});

describe('ListTasks of the server', () => {
  function server() {
    return new A2AServer({ agents: { helper: mockAgent('helper') }, cogitator: echoCogitator() });
  }

  async function call(target: A2AServer, params: unknown) {
    return expectResponse(
      await target.handleJsonRpc(
        { jsonrpc: '2.0', id: 1, method: 'ListTasks', params },
        undefined,
        { protocolVersion: '1.0' }
      )
    );
  }

  it('refuses a page size outside 1 to 100, naming pageSize', async () => {
    for (const pageSize of [0, 101, -1]) {
      const response = await call(server(), { pageSize });
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.data).toContainEqual({
        '@type': 'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations: [{ field: 'pageSize', description: 'must be between 1 and 100' }],
      });
    }
  });

  it('refuses an invalid state and an invalid timestamp', async () => {
    expect((await call(server(), { status: 'TASK_STATE_RUNNING' })).error?.code).toBe(-32602);
    expect((await call(server(), { statusTimestampAfter: 'yesterday' })).error?.code).toBe(-32602);
  });

  it('filters by state and context, and applies historyLength', async () => {
    const target = server();
    const send = async (text: string, contextId?: string) =>
      expectResponse(
        await target.handleJsonRpc(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'SendMessage',
            params: {
              message: {
                messageId: text,
                role: 'ROLE_USER',
                parts: [{ text }],
                ...(contextId && { contextId }),
              },
            },
          },
          undefined,
          { protocolVersion: '1.0' }
        )
      );
    await send('one', 'ctx-one');
    await send('please ask');
    const waiting = (await call(target, { status: 'TASK_STATE_INPUT_REQUIRED' })).result as {
      tasks: { status: { state: string } }[];
    };
    expect(waiting.tasks.map((task) => task.status.state)).toEqual(['TASK_STATE_INPUT_REQUIRED']);
    const inContext = (await call(target, { contextId: 'ctx-one', historyLength: 0 })).result as {
      tasks: Record<string, unknown>[];
      totalSize: number;
    };
    expect(inContext.totalSize).toBe(1);
    expect(inContext.tasks[0]).not.toHaveProperty('history');
    expect(inContext.tasks[0]).not.toHaveProperty('artifacts');
  });

  it('keeps the 0.3 tasks/list offset extension', async () => {
    const target = server();
    for (const text of ['a', 'b', 'c']) {
      await target.handleJsonRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: text,
            role: 'user',
            parts: [{ kind: 'text', text }],
          },
        },
      });
    }
    const response = expectResponse(
      await target.handleJsonRpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/list',
        params: { offset: 1, limit: 1 },
      })
    );
    expect((response.result as { tasks: A2ATask[] }).tasks).toHaveLength(1);
  });
});
