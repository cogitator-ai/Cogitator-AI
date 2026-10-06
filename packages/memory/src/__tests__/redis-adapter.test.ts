import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '@cogitator-ai/types';

const { mockRedisClient, mockCreateRedisClient } = vi.hoisted(() => {
  const mockRedisClient = {
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zrange: vi.fn().mockResolvedValue([]),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    zrem: vi.fn().mockResolvedValue(1),
    mget: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  };
  const mockCreateRedisClient = vi.fn().mockResolvedValue(mockRedisClient);
  return { mockRedisClient, mockCreateRedisClient };
});

vi.mock('@cogitator-ai/redis', () => ({
  createRedisClient: mockCreateRedisClient,
}));

import { RedisAdapter } from '../adapters/redis';

describe('RedisAdapter', () => {
  let adapter: RedisAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRedisClient.mockResolvedValue(mockRedisClient);
    adapter = new RedisAdapter({
      provider: 'redis',
      host: 'localhost',
      port: 6379,
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects successfully', async () => {
      const newAdapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockRedisClient.ping).toHaveBeenCalled();
    });

    it('disconnects and calls quit', async () => {
      await adapter.disconnect();

      expect(mockRedisClient.quit).toHaveBeenCalled();
    });

    it('supports cluster mode', async () => {
      vi.clearAllMocks();
      const clusterAdapter = new RedisAdapter({
        provider: 'redis',
        cluster: {
          nodes: [{ host: 'node1', port: 6379 }],
        },
      });

      await clusterAdapter.connect();

      expect(mockCreateRedisClient).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'cluster',
          nodes: [{ host: 'node1', port: 6379 }],
        })
      );
    });
  });

  describe('thread operations', () => {
    it('creates a thread', async () => {
      const result = await adapter.createThread('agent1', { foo: 'bar' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^thread_/);
        expect(result.data.agentId).toBe('agent1');
        expect(result.data.metadata).toEqual({ foo: 'bar' });
        expect(mockRedisClient.setex).toHaveBeenCalled();
      }
    });

    it('gets a thread', async () => {
      const thread = {
        id: 'thread_123',
        agentId: 'agent1',
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(thread));

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('thread_123');
        expect(result.data?.createdAt).toBeInstanceOf(Date);
      }
    });

    it('returns null for non-existent thread', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);

      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const existingThread = {
        id: 'thread_123',
        agentId: 'agent1',
        metadata: { a: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(existingThread));

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
    });

    it('returns error for updating non-existent thread', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread and entries', async () => {
      mockRedisClient.zrange.mockResolvedValueOnce(['entry1', 'entry2']);

      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.del).toHaveBeenCalled();
    });
  });

  describe('entry operations', () => {
    it('adds an entry', async () => {
      const message: Message = { role: 'user', content: 'Hello' };
      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message,
        tokenCount: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^entry_/);
        expect(result.data.message).toEqual(message);
        expect(mockRedisClient.setex).toHaveBeenCalled();
        expect(mockRedisClient.zadd).toHaveBeenCalled();
      }
    });

    it('gets entries for thread', async () => {
      const entry = {
        id: 'entry_123',
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 10,
        createdAt: new Date().toISOString(),
      };
      mockRedisClient.zrange.mockResolvedValueOnce(['key1']);
      mockRedisClient.mget.mockResolvedValueOnce([JSON.stringify(entry)]);

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('entry_123');
      }
    });

    it('gets entries with time range filter', async () => {
      mockRedisClient.zrangebyscore.mockResolvedValueOnce([]);

      const result = await adapter.getEntries({
        threadId: 'thread_123',
        after: new Date('2024-01-01'),
        before: new Date('2024-12-31'),
      });

      expect(result.success).toBe(true);
      expect(mockRedisClient.zrangebyscore).toHaveBeenCalled();
    });

    it('gets entries with limit', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        id: `entry_${i}`,
        threadId: 'thread_123',
        message: { role: 'user', content: `Message ${i}` },
        tokenCount: 10,
        createdAt: new Date().toISOString(),
      }));
      mockRedisClient.zrange.mockResolvedValueOnce(entries.map((_, i) => `key${i}`));
      mockRedisClient.mget.mockResolvedValueOnce(entries.slice(-5).map((e) => JSON.stringify(e)));

      const result = await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      expect(result.success).toBe(true);
    });

    it('gets single entry', async () => {
      const entry = {
        id: 'entry_123',
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 10,
        createdAt: new Date().toISOString(),
      };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(entry));

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('entry_123');
      }
    });

    it('deletes entry', async () => {
      const entry = {
        id: 'entry_123',
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 10,
        createdAt: new Date().toISOString(),
      };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(entry));

      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.zrem).toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalled();
    });

    it('clears thread entries', async () => {
      mockRedisClient.zrange.mockResolvedValueOnce(['key1', 'key2']);

      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.del).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns error when not connected', async () => {
      const disconnectedAdapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });

      const result = await disconnectedAdapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });
  });

  describe('provider', () => {
    it('returns redis as provider', () => {
      expect(adapter.provider).toBe('redis');
    });
  });
});

describe('RedisAdapter hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRedisClient.mockResolvedValue(mockRedisClient);
  });

  it('returns a failure result instead of throwing on Redis errors', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
    await adapter.connect();
    mockRedisClient.get.mockRejectedValueOnce(new Error('READONLY replica'));

    const result = await adapter.getThread('t1');

    expect(result).toEqual({ success: false, error: 'READONLY replica' });
  });

  it('adds a hash tag to custom cluster prefixes', async () => {
    const adapter = new RedisAdapter({
      provider: 'redis',
      cluster: { nodes: [{ host: 'n1', port: 7000 }] },
      keyPrefix: 'myapp:',
    });
    await adapter.connect();
    mockRedisClient.get.mockResolvedValueOnce(null);

    await adapter.getThread('t1');

    expect(mockRedisClient.get).toHaveBeenCalledWith('{myapp}:thread:t1');
  });

  it('drops expired entry keys and applies the limit to live entries', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
    await adapter.connect();
    const live = (id: string) =>
      JSON.stringify({
        id,
        threadId: 't1',
        message: { role: 'user', content: id },
        tokenCount: 1,
        createdAt: new Date(),
      });
    mockRedisClient.zrange.mockResolvedValueOnce(['k1', 'k2', 'k3']);
    mockRedisClient.mget.mockResolvedValueOnce([live('e1'), live('e2'), null]);

    const result = await adapter.getEntries({ threadId: 't1', limit: 2 });

    expect(mockRedisClient.zrem).toHaveBeenCalledWith('cogitator:thread:entries:t1', 'k3');
    expect(result.success && result.data.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('refreshes the thread TTL when entries are added', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost', ttl: 60 });
    await adapter.connect();

    await adapter.addEntry({
      threadId: 't1',
      message: { role: 'user', content: 'x' },
      tokenCount: 1,
    });

    expect(mockRedisClient.expire).toHaveBeenCalledWith('cogitator:thread:t1', 60);
  });

  it('releases the client when the connection fails', async () => {
    mockRedisClient.ping.mockRejectedValueOnce(
      new Error('Reached the max retries per request limit (which is 3)')
    );
    mockRedisClient.on.mockImplementationOnce((_event: string, listener: (e: Error) => void) => {
      listener(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    });
    const failing = new RedisAdapter({ provider: 'redis', host: 'localhost' });

    const result = await failing.connect();

    expect(result).toEqual({
      success: false,
      error: 'Redis connection failed: connect ECONNREFUSED 127.0.0.1:6379',
    });
    expect(mockRedisClient.quit).toHaveBeenCalledTimes(1);
    expect(await failing.getThread('t1')).toEqual({ success: false, error: 'Not connected' });
  });

  it('reads only the newest entries a limit asks for', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
    await adapter.connect();
    const live = (id: string) =>
      JSON.stringify({
        id,
        threadId: 't1',
        message: { role: 'user', content: id },
        tokenCount: 1,
        createdAt: new Date(),
      });
    mockRedisClient.zrange.mockImplementation(async (_key: string, start: number, stop: number) => {
      const keys = Array.from({ length: 1000 }, (_, i) => `k${i}`);
      return start < 0 ? keys.slice(start, stop === -1 ? undefined : stop + 1) : keys;
    });
    mockRedisClient.mget.mockImplementation(async (...keys: string[]) =>
      keys.map((key) => live(key.replace('k', 'e')))
    );

    const result = await adapter.getEntries({ threadId: 't1', limit: 20 });

    expect(mockRedisClient.mget).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.mget.mock.calls[0]).toHaveLength(20);
    expect(result.success && result.data.map((e) => e.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `e${980 + i}`)
    );
    mockRedisClient.zrange.mockReset();
    mockRedisClient.zrange.mockResolvedValue([]);
    mockRedisClient.mget.mockReset();
    mockRedisClient.mget.mockResolvedValue([]);
  });

  it('fills a limit from older entries when the newest have expired', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
    await adapter.connect();
    const members = ['k1', 'k2', 'k3', 'k4'];
    const live = (id: string) =>
      JSON.stringify({
        id,
        threadId: 't1',
        message: { role: 'user', content: id },
        tokenCount: 1,
        createdAt: new Date(),
      });
    mockRedisClient.zrange.mockImplementation(async (_key: string, start: number) =>
      members.slice(start)
    );
    mockRedisClient.zrem.mockImplementation(async (_key: string, ...removed: string[]) => {
      for (const key of removed) members.splice(members.indexOf(key), 1);
      return removed.length;
    });
    mockRedisClient.mget.mockImplementation(async (...keys: string[]) =>
      keys.map((key) => (key === 'k4' ? null : live(key.replace('k', 'e'))))
    );

    const result = await adapter.getEntries({ threadId: 't1', limit: 2 });

    expect(result.success && result.data.map((e) => e.id)).toEqual(['e2', 'e3']);
    mockRedisClient.zrange.mockReset();
    mockRedisClient.zrange.mockResolvedValue([]);
    mockRedisClient.zrem.mockReset();
    mockRedisClient.zrem.mockResolvedValue(1);
    mockRedisClient.mget.mockReset();
    mockRedisClient.mget.mockResolvedValue([]);
  });
});
