import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '@cogitator-ai/types';

const { mockRedisClient, mockCreateRedisClient } = vi.hoisted(() => {
  const mockRedisClient = {
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zrange: vi.fn().mockResolvedValue([]),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    zrem: vi.fn().mockResolvedValue(1),
    mget: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    incr: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
    eval: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  };
  const mockCreateRedisClient = vi.fn().mockResolvedValue(mockRedisClient);
  return { mockRedisClient, mockCreateRedisClient };
});

vi.mock('@cogitator-ai/redis', () => ({
  createRedisClient: mockCreateRedisClient,
}));

import { RedisAdapter } from '../adapters/redis';

const READ_THREAD = "return redis.call('GET', KEYS[1])";

/** The `eval` calls whose script contains `fragment`, as `[numKeys, ...keysAndArgs]`. */
function scriptCalls(fragment: string): unknown[][] {
  return mockRedisClient.eval.mock.calls
    .filter(([script]) => String(script).includes(fragment))
    .map(([, ...rest]) => rest);
}

/** Answers the read of a stored thread with `stored`, and every write with `written`. */
function storedThread(stored: () => string | null, written: () => number = () => 1): void {
  mockRedisClient.eval.mockImplementation(async (script: string) =>
    script === READ_THREAD ? stored() : written()
  );
}

function resetEval(): void {
  mockRedisClient.eval.mockReset();
  mockRedisClient.eval.mockResolvedValue(1);
}

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
    afterEach(resetEval);

    it('creates a thread, reading what is stored on the primary', async () => {
      storedThread(() => null);

      const result = await adapter.createThread('agent1', { foo: 'bar' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^thread_/);
        expect(result.data.agentId).toBe('agent1');
        expect(result.data.metadata).toEqual({ foo: 'bar' });
      }
      const threadKey = `cogitator:thread:${result.success && result.data.id}`;
      expect(mockRedisClient.get).not.toHaveBeenCalled();
      expect(mockRedisClient.eval).toHaveBeenCalledWith(READ_THREAD, 1, threadKey);
      const [write] = scriptCalls("redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])");
      expect(write?.slice(0, 5)).toEqual([
        3,
        threadKey,
        'cogitator:threads:index',
        'cogitator:threads:sweep',
        '0',
      ]);
      expect(write?.at(-1)).toBe('cogitator:');
    });

    it('sweeps expired threads out of the index and keeps the index alive on every write', async () => {
      await adapter.createThread('agent1', {}, 't1');

      const [script] = mockRedisClient.eval.mock.calls.find(([s]) =>
        String(s).includes("redis.call('SET', KEYS[1], ARGV[3]")
      ) ?? [''];
      expect(script).toContain("redis.call('ZSCAN', index");
      expect(script).toContain("redis.call('EXISTS', prefix .. 'thread:' .. id) == 0");
      expect(script).toContain("redis.call('EXPIRE', KEYS[2], ARGV[4])");
      expect(script).toContain('sweep(KEYS[2], KEYS[3], ARGV[7], ARGV[4])');
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
      const existingThread = JSON.stringify({
        id: 'thread_123',
        agentId: 'agent1',
        metadata: { a: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      storedThread(() => existingThread);

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
      const [write] = scriptCalls("redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])");
      expect(write?.slice(4, 6)).toEqual(['1', existingThread]);
      expect(write?.at(-3)).toBe(result.success && result.data.updatedAt.getTime());
    });

    it('rereads and merges again when another writer changed the thread in between', async () => {
      const stored = (metadata: Record<string, unknown>) =>
        JSON.stringify({
          id: 'thread_123',
          agentId: 'agent1',
          metadata,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        });
      const reads = [stored({ a: 1 }), stored({ a: 1, other: true })];
      const writes = [0, 1];
      storedThread(
        () => reads.shift() ?? null,
        () => writes.shift() ?? 1
      );

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success && result.data.metadata).toEqual({ a: 1, other: true, b: 2 });
      const attempts = scriptCalls("redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])");
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.[5]).toBe(stored({ a: 1, other: true }));
    });

    it('fails instead of retrying forever when every write conflicts', async () => {
      const stored = JSON.stringify({
        id: 't1',
        agentId: 'a',
        metadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      storedThread(
        () => stored,
        () => 0
      );

      const result = await adapter.updateThread('t1', { b: 2 });

      expect(result.success).toBe(false);
      expect(scriptCalls("redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])")).toHaveLength(100);
    });

    it('returns error for updating non-existent thread', async () => {
      storedThread(() => null);

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
      expect(scriptCalls("redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])")).toHaveLength(0);
    });

    it('deletes the thread, its entries and its index member in one script', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('ZREM', KEYS[3], ARGV[1])"),
        3,
        'cogitator:thread:entries:thread_123',
        'cogitator:thread:thread_123',
        'cogitator:threads:index',
        'thread_123'
      );
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
        expect(result.data).not.toHaveProperty('seq');
      }
      const [, numKeys, threadKey, setKey, entryKey, indexKey, sweepKey, json] =
        mockRedisClient.eval.mock.calls[0] ?? [];
      expect([numKeys, threadKey, setKey, entryKey, indexKey, sweepKey]).toEqual([
        5,
        'cogitator:thread:thread_123',
        'cogitator:thread:entries:thread_123',
        `cogitator:entry:${result.success && result.data.id}`,
        'cogitator:threads:index',
        'cogitator:threads:sweep',
      ]);
      expect(JSON.parse(String(json))).toMatchObject({ seq: 1 });
    });

    it('refuses an entry for a thread that does not exist', async () => {
      mockRedisClient.eval.mockResolvedValueOnce(0);

      const result = await adapter.addEntry({
        threadId: 'missing',
        message: { role: 'user', content: 'orphan' },
        tokenCount: 1,
      });

      expect(result).toEqual({ success: false, error: 'Thread not found: missing' });
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

    it('clears thread entries and keeps the thread', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('ZRANGE', KEYS[1], 0, -1)"),
        1,
        'cogitator:thread:entries:thread_123'
      );
    });

    it('refuses a limit that is not a whole number of 0 or more', async () => {
      expect((await adapter.getEntries({ threadId: 't1', limit: -1 })).success).toBe(false);
      expect((await adapter.getEntries({ threadId: 't1', limit: 1.5 })).success).toBe(false);
      expect(mockRedisClient.zrange).not.toHaveBeenCalled();
    });

    it('orders entries created at one time by when they were added, also at the limit', async () => {
      const at = new Date(0).toISOString();
      const stored = (id: string, seq: number) =>
        JSON.stringify({
          id,
          threadId: 't1',
          message: { role: 'user', content: id },
          tokenCount: 1,
          createdAt: at,
          seq,
        });
      const byKey: Record<string, string> = {
        kA: stored('fourth', 4),
        kB: stored('first', 1),
        kC: stored('third', 3),
        kD: stored('second', 2),
      };
      mockRedisClient.zrange.mockResolvedValueOnce(['kC', 'kD']);
      mockRedisClient.zrangebyscore.mockResolvedValueOnce(['kA', 'kB', 'kC', 'kD']);
      mockRedisClient.mget.mockImplementation(async (...keys: string[]) =>
        keys.map((key) => byKey[key] ?? null)
      );

      const result = await adapter.getEntries({ threadId: 't1', limit: 2 });

      expect(mockRedisClient.zrangebyscore).toHaveBeenCalledWith(
        'cogitator:thread:entries:t1',
        0,
        0
      );
      expect(result.success && result.data.map((e) => e.id)).toEqual(['third', 'fourth']);
      expect(result.success && result.data[0]).not.toHaveProperty('seq');
      mockRedisClient.mget.mockReset();
      mockRedisClient.mget.mockResolvedValue([]);
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

    const [script, , threadKey, , , , , , , ttl] = mockRedisClient.eval.mock.calls[0] ?? [];
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[3])");
    expect(script).toContain("if redis.call('EXPIRE', KEYS[4], ARGV[3]) == 1 then");
    expect(script).toContain('sweep(KEYS[4], KEYS[5], ARGV[4], ARGV[3])');
    expect([threadKey, ttl]).toEqual(['cogitator:thread:t1', 60]);
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

describe('RedisAdapter listThreads', () => {
  const stored = (id: string, updatedAt: number, agentId = 'a') =>
    JSON.stringify({
      id,
      agentId,
      metadata: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    });

  /** Index rows as the page script returns them: id, score, thread JSON or null. */
  const rows = (...threads: [id: string, score: number, value: string | null][]) =>
    threads.flatMap(([id, score, value]) => [id, String(score), value]);

  interface Scripts {
    complete?: () => string | null;
    page?: (args: unknown[]) => unknown;
  }

  /** Dispatches `eval` by script: whether the index is complete, a page, anything else 1. */
  function scripts({ complete = () => '-inf', page = () => [0, [], []] }: Scripts): void {
    mockRedisClient.eval.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('ZSCORE')) return complete();
      if (script.includes('ZREVRANGEBYSCORE')) return page(args);
      return 1;
    });
  }

  let adapter: RedisAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRedisClient.mockResolvedValue(mockRedisClient);
    adapter = new RedisAdapter({ provider: 'redis', host: 'localhost', ttl: 60 });
    await adapter.connect();
  });

  afterEach(() => {
    resetEval();
    mockRedisClient.mget.mockReset();
    mockRedisClient.mget.mockResolvedValue([]);
    mockRedisClient.scan.mockReset();
    mockRedisClient.scan.mockResolvedValue(['0', []]);
  });

  it('refuses bad options without touching Redis', async () => {
    expect((await adapter.listThreads({ limit: 0 })).success).toBe(false);
    expect((await adapter.listThreads({ cursor: 'nope' })).success).toBe(false);
    expect(mockRedisClient.eval).not.toHaveBeenCalled();
  });

  it('indexes a legacy thread written before the first listing, then marks the index complete', async () => {
    let complete: string | null = null;
    scripts({
      complete: () => complete,
      page: () => [1, [], rows(['old', 2000, stored('old', 2000)])],
    });
    mockRedisClient.scan.mockResolvedValueOnce([
      '0',
      ['cogitator:thread:old', 'cogitator:thread:entries:old'],
    ]);
    mockRedisClient.mget.mockResolvedValueOnce([stored('old', 2000), null]);

    const listed = await adapter.listThreads();
    complete = '-inf';
    await adapter.listThreads();

    expect(listed.success && listed.data.threads.map((t) => t.id)).toEqual(['old']);
    expect(mockRedisClient.scan).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'cogitator:thread:*',
      'COUNT',
      500
    );
    expect(scriptCalls("'NX'")).toEqual([[1, 'cogitator:threads:index', 2000, 'old']]);
    expect(scriptCalls("redis.call('ZADD', KEYS[1], '-inf', ARGV[1])")).toEqual([
      [1, 'cogitator:threads:index', '', 60],
    ]);
  });

  it('rebuilds the index when it was evicted or expired and a write made it again', async () => {
    let complete: string | null = '-inf';
    scripts({ complete: () => complete });
    await adapter.listThreads();
    expect(mockRedisClient.scan).not.toHaveBeenCalled();

    complete = null;
    mockRedisClient.scan.mockResolvedValueOnce(['0', ['cogitator:thread:kept']]);
    mockRedisClient.mget.mockResolvedValueOnce([stored('kept', 3000)]);
    await adapter.listThreads();

    expect(mockRedisClient.scan).toHaveBeenCalledTimes(1);
    expect(scriptCalls("'NX'")).toEqual([[1, 'cogitator:threads:index', 3000, 'kept']]);
    expect(scriptCalls("redis.call('ZADD', KEYS[1], '-inf', ARGV[1])")).toHaveLength(1);
  });

  it('reads the index and the threads on the primary, skipping the ones that expired', async () => {
    scripts({
      page: () => [
        3,
        [],
        rows(
          ['t3', 3000, stored('t3', 3000)],
          ['gone', 2500, null],
          ['t1', 1000, stored('t1', 1000)]
        ),
      ],
    });

    const result = await adapter.listThreads({ limit: 5 });

    expect(result.success && result.data.threads.map((t) => t.id)).toEqual(['t3', 't1']);
    expect(result.success && result.data.nextCursor).toBeUndefined();
    expect(mockRedisClient.mget).not.toHaveBeenCalled();
    expect(scriptCalls('ZREVRANGEBYSCORE')).toEqual([
      [1, 'cogitator:threads:index', 'cogitator:', 'desc', '', '+inf', 200],
    ]);
  });

  it('continues after the cursor with the threads that share its update time', async () => {
    scripts({
      page: () => [2, [], rows(['b', 1000, stored('b', 1000)], ['a', 1000, stored('a', 1000)])],
    });
    const first = await adapter.listThreads({ limit: 1 });
    expect(first.success && first.data.threads.map((t) => t.id)).toEqual(['b']);
    const cursor = first.success ? first.data.nextCursor : undefined;
    expect(cursor).toBeDefined();

    mockRedisClient.eval.mockClear();
    scripts({
      page: () => [
        0,
        rows(
          ['a', 1000, stored('a', 1000)],
          ['b', 1000, stored('b', 1000)],
          ['c', 1000, stored('c', 1000)]
        ),
        [],
      ],
    });
    const second = await adapter.listThreads({ limit: 1, ...(cursor && { cursor }) });

    expect(scriptCalls('ZREVRANGEBYSCORE')).toEqual([
      [1, 'cogitator:threads:index', 'cogitator:', 'desc', 1000, '(1000', 200],
    ]);
    expect(second.success && second.data.threads.map((t) => t.id)).toEqual(['a']);
    expect(second.success && second.data.nextCursor).toBeUndefined();
  });

  it('keeps every key of a cluster listing in the slot of a custom prefix', async () => {
    const cluster = new RedisAdapter({
      provider: 'redis',
      cluster: { nodes: [{ host: 'n1', port: 7000 }] },
      keyPrefix: 'myapp:',
    });
    await cluster.connect();
    scripts({
      complete: () => null,
      page: () => [1, [], rows(['old', 2000, stored('old', 2000)])],
    });
    mockRedisClient.scan.mockResolvedValueOnce(['0', ['{myapp}:thread:old']]);
    mockRedisClient.mget.mockResolvedValueOnce([stored('old', 2000)]);

    const listed = await cluster.listThreads();

    expect(listed.success && listed.data.threads.map((t) => t.id)).toEqual(['old']);
    expect(mockRedisClient.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      '{myapp}:thread:*',
      'COUNT',
      500
    );
    const keys = mockRedisClient.eval.mock.calls.flatMap(([, numKeys, ...args]) =>
      args.slice(0, Number(numKeys))
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(String(key)).toMatch(/^\{myapp\}:/);
  });

  it('moves a thread whose index member is behind its stored update time and skips it there', async () => {
    scripts({ page: () => [1, [], rows(['moved', 1000, stored('moved', 5000)])] });

    const result = await adapter.listThreads();

    expect(result.success && result.data.threads).toEqual([]);
    expect(scriptCalls("redis.call('GET', KEYS[1]) ~= ARGV[1]")).toEqual([
      [
        2,
        'cogitator:thread:moved',
        'cogitator:threads:index',
        stored('moved', 5000),
        5000,
        'moved',
      ],
    ]);
  });
});
