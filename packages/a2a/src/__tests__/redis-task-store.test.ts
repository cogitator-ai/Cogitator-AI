import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisTaskStore, type RedisClientLike } from '../redis-task-store';
import type { A2ATask } from '../types';

function createMockRedis(): RedisClientLike {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    keys: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    }),
  };
}

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

describe('RedisTaskStore', () => {
  let redis: RedisClientLike;
  let store: RedisTaskStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisTaskStore({ client: redis });
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

  it('should return empty array when no tasks exist', async () => {
    const tasks = await store.list();
    expect(tasks).toEqual([]);
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
    const now = Date.now();
    await store.create(
      createTask('task_1', {
        status: { state: 'working', timestamp: new Date(now + 3000).toISOString() },
      })
    );
    await store.create(
      createTask('task_2', {
        status: { state: 'working', timestamp: new Date(now + 2000).toISOString() },
      })
    );
    await store.create(
      createTask('task_3', {
        status: { state: 'working', timestamp: new Date(now + 1000).toISOString() },
      })
    );
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

  describe('key prefix', () => {
    it('should use default prefix a2a:task:', async () => {
      const task = createTask('task_1');
      await store.create(task);
      expect(redis.set).toHaveBeenCalledWith('a2a:task:task_1', expect.any(String));
    });

    it('should use custom prefix', async () => {
      const customStore = new RedisTaskStore({ client: redis, keyPrefix: 'custom:' });
      const task = createTask('task_1');
      await customStore.create(task);
      expect(redis.set).toHaveBeenCalledWith('custom:task_1', expect.any(String));
    });
  });

  describe('TTL', () => {
    it('should use setex when TTL is configured', async () => {
      const ttlStore = new RedisTaskStore({ client: redis, ttl: 3600 });
      const task = createTask('task_1');
      await ttlStore.create(task);
      expect(redis.setex).toHaveBeenCalledWith('a2a:task:task_1', 3600, expect.any(String));
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should use setex on update when TTL is configured', async () => {
      const ttlStore = new RedisTaskStore({ client: redis, ttl: 1800 });
      const task = createTask('task_1');
      await ttlStore.create(task);
      vi.mocked(redis.setex!).mockClear();

      await ttlStore.update('task_1', {
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });
      expect(redis.setex).toHaveBeenCalledWith('a2a:task:task_1', 1800, expect.any(String));
    });

    it('should fall back to set if setex is not available', async () => {
      const noSetexRedis = createMockRedis();
      delete noSetexRedis.setex;
      const ttlStore = new RedisTaskStore({ client: noSetexRedis, ttl: 3600 });
      const task = createTask('task_1');
      await ttlStore.create(task);
      expect(noSetexRedis.set).toHaveBeenCalledWith('a2a:task:task_1', expect.any(String));
    });

    it('should not use setex when TTL is not configured', async () => {
      const task = createTask('task_1');
      await store.create(task);
      expect(redis.setex).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalled();
    });
  });
});
