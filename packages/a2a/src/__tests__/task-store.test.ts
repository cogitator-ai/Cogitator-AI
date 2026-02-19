import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTaskStore } from '../task-store';
import type { A2ATask } from '../types';

function createTask(id: string, overrides?: Partial<A2ATask>): A2ATask {
  return {
    id,
    contextId: overrides?.contextId ?? 'ctx_default',
    status: overrides?.status ?? { state: 'working', timestamp: new Date().toISOString() },
    history: overrides?.history ?? [],
    artifacts: overrides?.artifacts ?? [],
    ...overrides,
  };
}

describe('InMemoryTaskStore', () => {
  let store: InMemoryTaskStore;

  beforeEach(() => {
    store = new InMemoryTaskStore();
  });

  it('should create and get a task', async () => {
    const task = createTask('task_1');
    await store.create(task);
    const retrieved = await store.get('task_1');
    expect(retrieved).toEqual(task);
  });

  it('should return null for unknown task', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should update task state', async () => {
    const task = createTask('task_1');
    await store.create(task);
    await store.update('task_1', {
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });
    const updated = await store.get('task_1');
    expect(updated?.status.state).toBe('completed');
  });

  it('should silently ignore update for non-existent task', async () => {
    await expect(
      store.update('nonexistent', { status: { state: 'completed', timestamp: '' } })
    ).resolves.not.toThrow();
  });

  it('should list all tasks', async () => {
    await store.create(createTask('task_1'));
    await store.create(createTask('task_2'));
    await store.create(createTask('task_3'));
    const tasks = await store.list();
    expect(tasks).toHaveLength(3);
  });

  it('should filter by contextId', async () => {
    await store.create(createTask('task_1', { contextId: 'ctx_a' }));
    await store.create(createTask('task_2', { contextId: 'ctx_b' }));
    await store.create(createTask('task_3', { contextId: 'ctx_a' }));
    const filtered = await store.list({ contextId: 'ctx_a' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((t) => t.contextId === 'ctx_a')).toBe(true);
  });

  it('should filter by state', async () => {
    await store.create(createTask('task_1', { status: { state: 'working', timestamp: '' } }));
    await store.create(createTask('task_2', { status: { state: 'completed', timestamp: '' } }));
    await store.create(createTask('task_3', { status: { state: 'working', timestamp: '' } }));
    const filtered = await store.list({ state: 'working' });
    expect(filtered).toHaveLength(2);
  });

  it('should apply limit', async () => {
    await store.create(createTask('task_1'));
    await store.create(createTask('task_2'));
    await store.create(createTask('task_3'));
    const limited = await store.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('should apply offset', async () => {
    await store.create(createTask('task_1'));
    await store.create(createTask('task_2'));
    await store.create(createTask('task_3'));
    const offset = await store.list({ offset: 1, limit: 2 });
    expect(offset).toHaveLength(2);
    expect(offset[0].id).toBe('task_2');
  });

  it('should delete a task', async () => {
    await store.create(createTask('task_1'));
    await store.delete('task_1');
    const result = await store.get('task_1');
    expect(result).toBeNull();
  });

  it('should silently handle delete of non-existent task', async () => {
    await expect(store.delete('nonexistent')).resolves.not.toThrow();
  });

  it('should return deep copies (no mutation leaks)', async () => {
    const task = createTask('task_1');
    await store.create(task);

    const retrieved = await store.get('task_1');
    retrieved!.status.state = 'failed';

    const retrievedAgain = await store.get('task_1');
    expect(retrievedAgain?.status.state).toBe('working');
  });
});
