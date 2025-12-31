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
