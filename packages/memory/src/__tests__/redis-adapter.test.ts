import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MemoryItem, Message } from '@cogitator-ai/types';

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
    eval: vi.fn<(script: string, ...args: unknown[]) => Promise<unknown>>(async (script) =>
      script.includes('local function sweep') ? [1] : 1
    ),
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

/** Whether `script` is a write that sweeps the thread index, replying `{written, expired...}` */
const sweeps = (script: string) => script.includes('local function sweep');

/** Answers the read of a stored thread with `stored`, and every write with `written`. */
function storedThread(stored: () => string | null, written: () => number = () => 1): void {
  mockRedisClient.eval.mockImplementation(async (script: string) =>
    script === READ_THREAD ? stored() : sweeps(script) ? [written()] : written()
  );
}

function resetEval(): void {
  mockRedisClient.eval.mockReset();
  mockRedisClient.eval.mockImplementation(async (script: string) => (sweeps(script) ? [1] : 1));
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
        String(s).includes('put(KEYS[1], ARGV[3], ARGV[4])')
      ) ?? [''];
      expect(script).toContain("redis.call('ZSCAN', index");
      expect(script).toContain("redis.call('EXISTS', prefix .. 'thread:' .. id) == 0");
      expect(script).toContain('keep(KEYS[2], ARGV[4] * 7)');
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
        expect.stringContaining("redis.call('ZREM', KEYS[5], ARGV[1])"),
        5,
        'cogitator:thread:entries:thread_123',
        'cogitator:thread:leaf:thread_123',
        'cogitator:thread:chained:thread_123',
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
        expect(result.data).toMatchObject({ seq: 1, parentId: null, type: 'message' });
      }
      const [
        ,
        numKeys,
        threadKey,
        setKey,
        entryKey,
        indexKey,
        sweepKey,
        leafKey,
        chainedKey,
        json,
      ] = mockRedisClient.eval.mock.calls[0] ?? [];
      expect([
        numKeys,
        threadKey,
        setKey,
        entryKey,
        indexKey,
        sweepKey,
        leafKey,
        chainedKey,
      ]).toEqual([
        7,
        'cogitator:thread:thread_123',
        'cogitator:thread:entries:thread_123',
        `cogitator:entry:${result.success && result.data.id}`,
        'cogitator:threads:index',
        'cogitator:threads:sweep',
        'cogitator:thread:leaf:thread_123',
        'cogitator:thread:chained:thread_123',
      ]);
      expect(JSON.parse(String(json))).toMatchObject({ seq: 1 });
    });

    it('tells the script apart a parent left out, a new root and a parent entry', async () => {
      const add = (parentId?: string | null) =>
        adapter.addEntry({
          threadId: 't1',
          message: { role: 'user', content: 'x' },
          tokenCount: 1,
          ...(parentId !== undefined && { parentId }),
        });
      mockRedisClient.eval.mockResolvedValue([1, '']);

      await add();
      await add(null);
      await add('entry_parent');

      const placements = scriptCalls('ARGV[5] ==').map((call) => [call[12], call[15]]);
      expect(placements).toEqual([
        ['leaf', ''],
        ['root', ''],
        ['entry', 'entry_parent'],
      ]);
      const [script] = mockRedisClient.eval.mock.calls[0] ?? [];
      expect(script).toContain("if ARGV[5] == 'leaf' then");
      resetEval();
    });

    it('names a key of the thread in every script, so a cluster routes it to its node', async () => {
      const at = new Date(0).toISOString();
      mockRedisClient.get.mockImplementation(async (key: string) =>
        key === 'cogitator:thread:t1'
          ? JSON.stringify({ id: 't1', agentId: 'a', createdAt: at, updatedAt: at })
          : JSON.stringify({ id: 'e1', threadId: 't1', createdAt: at })
      );
      mockRedisClient.eval.mockImplementation(async (script: string) => {
        if (script === READ_THREAD) {
          return JSON.stringify({ id: 'e1', threadId: 't1', createdAt: new Date(0) });
        }
        if (script.includes("if ARGV[5] == 'leaf' then")) return [1, ''];
        if (script.includes('local out = {')) return [''];
        return sweeps(script) ? [1] : 1;
      });

      await adapter.addEntry({
        threadId: 't1',
        message: { role: 'user', content: 'x' },
        tokenCount: 1,
      });
      await adapter.getThread('t1');
      await adapter.getPath({ threadId: 't1', leafId: 'e1' });
      await adapter.checkout('t1', 'e1');
      await adapter.deleteEntry('e1');
      await adapter.clearThread('t1');
      await adapter.deleteThread('t1');

      expect(scriptCalls('local out = {')[0]?.slice(0, 4)).toEqual([
        3,
        'cogitator:thread:entries:t1',
        'cogitator:thread:leaf:t1',
        'cogitator:thread:chained:t1',
      ]);
      const keyless = mockRedisClient.eval.mock.calls.filter(([, numKeys]) => Number(numKeys) < 1);
      expect(keyless).toEqual([]);
      mockRedisClient.get.mockReset();
      mockRedisClient.get.mockResolvedValue(null);
      resetEval();
    });

    it('moves the leaf only to an entry the script still finds in the thread', async () => {
      mockRedisClient.get.mockResolvedValue(
        JSON.stringify({ id: 'e1', threadId: 't1', createdAt: new Date(0) })
      );
      mockRedisClient.eval.mockImplementation(async (script: string) => {
        if (script === READ_THREAD) {
          return JSON.stringify({ id: 'e1', threadId: 't1', createdAt: new Date(0) });
        }
        if (script.includes("redis.call('ZSCORE', KEYS[3], KEYS[5])")) return -1;
        return sweeps(script) ? [1] : 1;
      });

      const result = await adapter.checkout('t1', 'e1');

      expect(result).toEqual({ success: false, error: 'Entry e1 is not in thread t1' });
      const [setLeaf] = scriptCalls("redis.call('ZSCORE', KEYS[3], KEYS[5])");
      expect(setLeaf?.slice(0, 6)).toEqual([
        5,
        'cogitator:thread:t1',
        'cogitator:thread:leaf:t1',
        'cogitator:thread:entries:t1',
        'cogitator:thread:chained:t1',
        'cogitator:entry:e1',
      ]);
      mockRedisClient.get.mockResolvedValue(null);
      resetEval();
    });

    it('reports threads its sweep found expired as deleted', async () => {
      const changes: unknown[] = [];
      adapter.onChange((change) => changes.push(change));
      mockRedisClient.eval.mockResolvedValueOnce([1, '', 'gone-1', 'gone-2']);

      const result = await adapter.addEntry({
        threadId: 't1',
        message: { role: 'user', content: 'hi' },
        tokenCount: 1,
      });

      expect(result.success).toBe(true);
      expect(changes.map((change) => (change as { type: string }).type)).toEqual([
        'thread-deleted',
        'thread-deleted',
        'entry-added',
      ]);
      expect(changes.slice(0, 2)).toEqual([
        { type: 'thread-deleted', threadId: 'gone-1' },
        { type: 'thread-deleted', threadId: 'gone-2' },
      ]);
    });

    it('refuses an entry for a thread that does not exist', async () => {
      mockRedisClient.eval.mockResolvedValueOnce([0]);

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

    it('deletes entry, naming the keys of its thread', async () => {
      mockRedisClient.eval.mockImplementation(async (script: string) =>
        script === READ_THREAD
          ? JSON.stringify({ id: 'entry_123', threadId: 'thread_123', createdAt: new Date(0) })
          : 1
      );

      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        READ_THREAD,
        1,
        'cogitator:entry:entry_123'
      );
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('ZREM', KEYS[2], KEYS[1])"),
        4,
        'cogitator:entry:entry_123',
        'cogitator:thread:entries:thread_123',
        'cogitator:thread:leaf:thread_123',
        'cogitator:thread:chained:thread_123',
        'cogitator:',
        0,
        'entry_123',
        'thread_123'
      );
      resetEval();
    });

    it('deletes nothing when the entry is gone', async () => {
      mockRedisClient.eval.mockImplementation(async () => null);

      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledTimes(1);
      resetEval();
    });

    it('clears thread entries and keeps the thread', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('ZRANGE', KEYS[1], 0, -1)"),
        2,
        'cogitator:thread:entries:thread_123',
        'cogitator:thread:leaf:thread_123'
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
      expect(result.success && result.data[0]).toMatchObject({ seq: 3 });
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

  it('reports entries that expired inside a thread as deleted', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
    await adapter.connect();
    const changes: unknown[] = [];
    adapter.onChange((change) => changes.push(change));
    mockRedisClient.zrange.mockResolvedValueOnce(['cogitator:entry:e1', 'cogitator:entry:e2']);
    mockRedisClient.mget.mockResolvedValueOnce([null, null]);

    await adapter.getEntries({ threadId: 't1' });

    expect(changes).toEqual([
      { type: 'entry-deleted', entryId: 'e1' },
      { type: 'entry-deleted', entryId: 'e2' },
    ]);
  });

  it('refreshes the thread TTL when entries are added', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost', ttl: 60 });
    await adapter.connect();

    await adapter.addEntry({
      threadId: 't1',
      message: { role: 'user', content: 'x' },
      tokenCount: 1,
    });

    const [script, , threadKey, , , , , , , , , ttl] = mockRedisClient.eval.mock.calls[0] ?? [];
    expect(script).toContain('keep(KEYS[1], ARGV[3])');
    expect(script).toContain('keep(KEYS[4], ARGV[3] * 7)');
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

  it('pages back past event entries for a limit instead of reading the whole thread', async () => {
    const adapter = new RedisAdapter({ provider: 'redis', host: 'localhost' });
    await adapter.connect();
    const members = Array.from({ length: 10_000 }, (_, i) => `k${String(i).padStart(5, '0')}`);
    const events = new Set(members.slice(-300));
    const stored = (key: string) =>
      JSON.stringify({
        id: key.replace('k', 'e'),
        threadId: 't1',
        message: { role: 'user', content: key },
        tokenCount: 1,
        createdAt: new Date(Number(key.slice(1)) * 1000),
        ...(events.has(key) && { type: 'model_change' }),
      });
    const at = (index: number) => (index < 0 ? Math.max(members.length + index, 0) : index);
    mockRedisClient.zrange.mockImplementation(async (_key: string, start: number, stop) =>
      members.slice(at(start), at(Number(stop)) + 1)
    );
    mockRedisClient.mget.mockImplementation(async (...keys: string[]) => keys.map(stored));
    mockRedisClient.zrangebyscore.mockResolvedValue([]);

    const result = await adapter.getEntries({ threadId: 't1', limit: 3 });

    expect(result.success && result.data.map((e) => e.id)).toEqual(['e09697', 'e09698', 'e09699']);
    expect(mockRedisClient.zrange).not.toHaveBeenCalledWith('cogitator:thread:entries:t1', 0, -1);
    const fetched = mockRedisClient.mget.mock.calls.reduce((sum, call) => sum + call.length, 0);
    expect(fetched).toBeLessThanOrEqual(403);
    mockRedisClient.zrangebyscore.mockReset();
    mockRedisClient.zrangebyscore.mockResolvedValue([]);
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

  /**
   * Dispatches `eval` by script: whether the index is complete, a page (with no expired threads
   * unless it names them), anything else 1.
   */
  function scripts({ complete = () => '-inf', page = () => [0, [], []] }: Scripts): void {
    mockRedisClient.eval.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('ZSCORE')) return complete();
      if (script.includes('ZREVRANGEBYSCORE')) {
        const reply = page(args);
        return Array.isArray(reply) && reply.length === 3 ? [...reply, []] : reply;
      }
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
      [1, 'cogitator:threads:index', '', 420],
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

  it('reports threads the listing found expired as deleted', async () => {
    scripts({ page: () => [2, [], rows(['live', 1000, stored('live', 1000)]), ['gone']] });
    const changes: unknown[] = [];
    adapter.onChange((change) => changes.push(change));

    const listed = await adapter.listThreads();

    expect(listed.success && listed.data.threads.map((t) => t.id)).toEqual(['live']);
    expect(changes).toEqual([{ type: 'thread-deleted', threadId: 'gone' }]);
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

describe('RedisAdapter memory items', () => {
  const READ_FIELD = "return redis.call('HGET', KEYS[1], ARGV[1])";
  const PUT_RECORD = 'local staleSorted';
  const DROP_RECORD = "for i = 3, #KEYS do redis.call('SREM', KEYS[i], ARGV[2]) end";
  const READ_RECORDS = "if ARGV[1] == 'records' then";

  const at = new Date('2026-01-01T00:00:00.000Z');
  const item: MemoryItem = {
    id: 'mem_1',
    kind: 'fact',
    content: 'Ana lives in Porto',
    entityId: 'ent_1',
    slot: 'ent_1:home city',
    status: 'active',
    trust: 'user',
    confidence: 0.9,
    scope: { agentId: 'agent:1' },
    evidence: [{ entryId: 'e1', quote: 'I live in Porto' }],
    verified: true,
    saidAt: at,
    sessionAt: at,
    validFrom: at,
    recordedAt: at,
  };
  const agentItems = 'cogitator:items:agent:agent%3A1';
  const slotSet = `${agentItems}:slot:ent_1%3Ahome%20city`;
  const entitySet = `${agentItems}:entity:ent_1`;

  let adapter: RedisAdapter;
  let stored: string | null;
  let putReplies: number[];

  beforeEach(async () => {
    vi.clearAllMocks();
    stored = null;
    putReplies = [];
    mockCreateRedisClient.mockResolvedValue(mockRedisClient);
    mockRedisClient.eval.mockImplementation(async (script: string) => {
      if (script === READ_FIELD) return stored;
      if (script.includes(PUT_RECORD)) return putReplies.shift() ?? 1;
      return 1;
    });
    adapter = new RedisAdapter({ provider: 'redis', host: 'localhost', ttl: 60 });
    await adapter.connect();
  });

  afterEach(async () => {
    resetEval();
    await adapter.disconnect();
  });

  const indexes = (sorted: string, sets: string[]) => JSON.stringify({ sorted, sets });

  it('writes a new item into its agent, slot and entity indexes, with no expiry', async () => {
    const result = await adapter.putItem(item);

    expect(result.success && result.data).toEqual(item);
    const [put] = scriptCalls(PUT_RECORD);
    const next = indexes(agentItems, [slotSet, entitySet]);
    expect(put).toEqual([
      4,
      'cogitator:item:mem_1',
      agentItems,
      slotSet,
      entitySet,
      '',
      'mem_1',
      JSON.stringify(item),
      at.getTime(),
      next,
      2,
      0,
    ]);
    expect(put).not.toContain(60);
  });

  it('takes a replaced item out of the indexes it leaves', async () => {
    stored = indexes(agentItems, [slotSet, entitySet]);
    const moved: MemoryItem = { ...item, slot: 'ent_1:work city', scope: { agentId: 'other' } };
    delete moved.entityId;

    await adapter.putItem(moved);

    const otherItems = 'cogitator:items:agent:other';
    const otherSlot = `${otherItems}:slot:ent_1%3Awork%20city`;
    const [put] = scriptCalls(PUT_RECORD);
    expect(put?.slice(0, 7)).toEqual([
      6,
      'cogitator:item:mem_1',
      otherItems,
      otherSlot,
      agentItems,
      slotSet,
      entitySet,
    ]);
    expect(put?.slice(7, 8)).toEqual([stored]);
    expect(put?.slice(-3)).toEqual([indexes(otherItems, [otherSlot]), 1, 1]);
  });

  it('leaves the indexes a replaced item stays in alone', async () => {
    stored = indexes(agentItems, [slotSet, entitySet]);

    await adapter.putItem({ ...item, status: 'superseded' });

    const [put] = scriptCalls(PUT_RECORD);
    expect(put?.slice(0, 5)).toEqual([4, 'cogitator:item:mem_1', agentItems, slotSet, entitySet]);
    expect(put?.slice(-2)).toEqual([2, 0]);
  });

  it('reads the indexes again when another writer moved the item in between', async () => {
    putReplies = [0, 1];
    let reads = 0;
    mockRedisClient.eval.mockImplementation(async (script: string) => {
      if (script === READ_FIELD) {
        reads++;
        return reads === 1 ? null : indexes(agentItems, [entitySet]);
      }
      if (script.includes(PUT_RECORD)) return putReplies.shift() ?? 1;
      return 1;
    });

    const result = await adapter.putItem({ ...item, entityId: undefined });

    expect(result.success).toBe(true);
    const puts = scriptCalls(PUT_RECORD);
    expect(puts).toHaveLength(2);
    expect(puts[1]?.slice(0, 5)).toEqual([
      4,
      'cogitator:item:mem_1',
      agentItems,
      slotSet,
      entitySet,
    ]);
    expect(puts[1]?.[5]).toBe(indexes(agentItems, [entitySet]));
  });

  it('deletes an item out of every index it is in, and skips one that is gone', async () => {
    const kept = indexes(agentItems, [slotSet, entitySet]);
    stored = kept;

    await adapter.deleteItems(['mem_1', 'mem_1']);
    stored = null;
    await adapter.deleteItems(['missing']);

    expect(scriptCalls(DROP_RECORD)).toEqual([
      [4, 'cogitator:item:mem_1', agentItems, slotSet, entitySet, kept, 'mem_1'],
    ]);
  });

  it('finds items through the narrowest index, filtering and ordering in process', async () => {
    const later = { ...item, id: 'mem_0', recordedAt: new Date(at.getTime() + 1000) };
    const foreign = { ...item, id: 'mem_2', scope: { agentId: 'other' } };
    const gone = { ...item, id: 'mem_3', expiredAt: at };
    const ahead = { ...item, id: 'mem_4', expiredAt: new Date(Date.now() + 60_000) };
    mockRedisClient.eval.mockImplementation(async (script: string) =>
      script.includes(READ_RECORDS)
        ? [later, foreign, gone, ahead, item].map((i) => JSON.stringify(i))
        : 1
    );

    const result = await adapter.findItems({ agentId: 'agent:1', slots: [item.slot!, item.slot!] });

    expect(result.success && result.data.map((found) => found.id)).toEqual([
      'mem_1',
      'mem_4',
      'mem_0',
    ]);
    expect(result.success && result.data[0]?.recordedAt).toBeInstanceOf(Date);
    expect(scriptCalls(READ_RECORDS)).toEqual([[1, slotSet, 'sets', 'cogitator:item:']]);

    await adapter.findItems({ agentId: 'agent:1', ids: ['mem_1'], slots: [item.slot!] });
    await adapter.findItems({ agentId: 'agent:1' });
    expect(scriptCalls(READ_RECORDS).slice(1)).toEqual([
      [1, 'cogitator:item:mem_1', 'records', 'cogitator:item:'],
      [1, agentItems, 'sorted', 'cogitator:item:'],
    ]);
  });

  it('finds nothing without reading when a filter lists no values', async () => {
    const result = await adapter.findItems({ agentId: 'agent:1', entityIds: [] });

    expect(result.success && result.data).toEqual([]);
    expect(scriptCalls(READ_RECORDS)).toEqual([]);
  });

  it('keeps the name index of a replaced entity to the names it still has', async () => {
    const agentEntities = 'cogitator:entities:agent:agent%3A1';
    const named = (name: string) => `${agentEntities}:name:${encodeURIComponent(name)}`;
    stored = indexes(agentEntities, [named('ana lima'), named('ana'), named('dr. lima')]);

    await adapter.putEntity({
      id: 'ent_1',
      scope: { agentId: 'agent:1' },
      name: 'Ana Lima',
      aliases: ['Ana'],
      firstSeenAt: at,
      lastSeenAt: at,
    });

    const [put] = scriptCalls(PUT_RECORD);
    expect(put?.slice(0, 5)).toEqual([
      5,
      'cogitator:entity:ent_1',
      agentEntities,
      named('ana lima'),
      named('ana'),
    ]);
    expect(put?.[5]).toBe(named('dr. lima'));
    expect(put?.slice(-2)).toEqual([2, 0]);
  });

  it('deletes an entity out of its name index', async () => {
    const agentEntities = 'cogitator:entities:agent:a';
    stored = indexes(agentEntities, [`${agentEntities}:name:porto`]);

    await adapter.deleteEntities(['ent_1']);

    expect(scriptCalls(DROP_RECORD)).toEqual([
      [3, 'cogitator:entity:ent_1', agentEntities, `${agentEntities}:name:porto`, stored, 'ent_1'],
    ]);
  });
});
