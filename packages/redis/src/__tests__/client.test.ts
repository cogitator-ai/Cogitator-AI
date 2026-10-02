import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RedisClient } from '../types';

type EventCallback = (...args: unknown[]) => void;

function createMockRawClient() {
  const listeners = new Map<string, Set<EventCallback>>();

  return {
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    mget: vi.fn().mockResolvedValue([]),
    zadd: vi.fn().mockResolvedValue(1),
    zrange: vi.fn().mockResolvedValue([]),
    zrangebyscore: vi.fn().mockResolvedValue([]),
    zrem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    scan: vi.fn().mockResolvedValue(['0', []]),
    info: vi.fn().mockResolvedValue(''),
    on: vi.fn((event: string, cb: EventCallback) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    off: vi.fn((event: string, cb: EventCallback) => {
      listeners.get(event)?.delete(cb);
    }),
    duplicate: vi.fn(),
    _listeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((cb) => cb(...args));
    },
  };
}

function createMockIoRedis(rawClient: ReturnType<typeof createMockRawClient>) {
  rawClient.duplicate.mockImplementation(() => {
    const dup = createMockRawClient();
    dup.duplicate.mockReturnValue(dup);
    return dup;
  });

  function IoRedisMock(_url: string, _options?: Record<string, unknown>) {
    return rawClient;
  }

  IoRedisMock.Cluster = function ClusterMock(
    _nodes: { host: string; port: number }[],
    _options?: Record<string, unknown>
  ) {
    return rawClient;
  };

  const constructorSpy = vi.fn(IoRedisMock) as unknown as {
    (...args: unknown[]): ReturnType<typeof createMockRawClient>;
    Cluster: ReturnType<typeof vi.fn>;
  };

  constructorSpy.Cluster = vi.fn(IoRedisMock.Cluster);

  return constructorSpy;
}

describe('createRedisClient', () => {
  let rawClient: ReturnType<typeof createMockRawClient>;

  beforeEach(() => {
    rawClient = createMockRawClient();
    vi.resetModules();
  });

  it('creates standalone client via dynamic import', async () => {
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { createRedisClient } = await import('../factory');
    const client = await createRedisClient({
      mode: 'standalone',
      url: 'redis://myhost:1234',
      password: 'secret',
      keyPrefix: 'test:',
    });

    expect(mockIoRedis).toHaveBeenCalledWith(
      'redis://myhost:1234',
      expect.objectContaining({
        password: 'secret',
        keyPrefix: 'test:',
      })
    );

    const pong = await client.ping();
    expect(pong).toBe('PONG');
  });

  it('creates cluster client when mode is cluster', async () => {
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { createRedisClient } = await import('../factory');
    const client = await createRedisClient({
      mode: 'cluster',
      nodes: [
        { host: '10.0.0.1', port: 6379 },
        { host: '10.0.0.2', port: 6379 },
      ],
      keyPrefix: '{test}:',
    });

    expect(mockIoRedis.Cluster).toHaveBeenCalledWith(
      [
        { host: '10.0.0.1', port: 6379 },
        { host: '10.0.0.2', port: 6379 },
      ],
      expect.objectContaining({
        keyPrefix: '{test}:',
        scaleReads: 'master',
      })
    );

    const pong = await client.ping();
    expect(pong).toBe('PONG');
  });

  it('builds URL from host and port when no url provided', async () => {
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { createRedisClient } = await import('../factory');
    await createRedisClient({
      mode: 'standalone',
      host: 'myhost',
      port: 7777,
    });

    expect(mockIoRedis).toHaveBeenCalledWith('redis://myhost:7777', expect.anything());
  });

  it('uses default host/port when none specified', async () => {
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { createRedisClient } = await import('../factory');
    await createRedisClient({ mode: 'standalone' });

    expect(mockIoRedis).toHaveBeenCalledWith('redis://localhost:6379', expect.anything());
  });

  it('passes TLS config when enabled', async () => {
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { createRedisClient } = await import('../factory');
    await createRedisClient({ mode: 'standalone', tls: true });

    expect(mockIoRedis).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tls: {},
      })
    );
  });
});

describe('wrapClient (via createRedisClient)', () => {
  let rawClient: ReturnType<typeof createMockRawClient>;
  let client: RedisClient;

  beforeEach(async () => {
    rawClient = createMockRawClient();
    vi.resetModules();
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));
    const { createRedisClient } = await import('../factory');
    client = await createRedisClient({ mode: 'standalone' });
  });

  it('delegates all basic operations to raw client', async () => {
    await client.get('key1');
    expect(rawClient.get).toHaveBeenCalledWith('key1');

    await client.set('key2', 'val');
    expect(rawClient.set).toHaveBeenCalledWith('key2', 'val');

    await client.setex('key3', 60, 'val');
    expect(rawClient.setex).toHaveBeenCalledWith('key3', 60, 'val');

    await client.del('key4', 'key5');
    expect(rawClient.del).toHaveBeenCalledWith('key4', 'key5');

    await client.expire('key6', 120);
    expect(rawClient.expire).toHaveBeenCalledWith('key6', 120);

    await client.mget('a', 'b', 'c');
    expect(rawClient.mget).toHaveBeenCalledWith('a', 'b', 'c');
  });

  it('delegates sorted set operations', async () => {
    await client.zadd('zkey', 1.5, 'member1');
    expect(rawClient.zadd).toHaveBeenCalledWith('zkey', 1.5, 'member1');

    await client.zrange('zkey', 0, -1);
    expect(rawClient.zrange).toHaveBeenCalledWith('zkey', 0, -1);

    await client.zrangebyscore('zkey', '-inf', '+inf');
    expect(rawClient.zrangebyscore).toHaveBeenCalledWith('zkey', '-inf', '+inf');

    await client.zrem('zkey', 'm1', 'm2');
    expect(rawClient.zrem).toHaveBeenCalledWith('zkey', 'm1', 'm2');
  });

  it('delegates smembers', async () => {
    await client.smembers('setkey');
    expect(rawClient.smembers).toHaveBeenCalledWith('setkey');
  });

  it('keys iterates SCAN until the cursor returns to 0', async () => {
    rawClient.scan
      .mockResolvedValueOnce(['17', ['a:1', 'a:2']])
      .mockResolvedValueOnce(['0', ['a:2', 'a:3']]);

    const keys = await client.keys('a:*');

    expect(keys.sort()).toEqual(['a:1', 'a:2', 'a:3']);
    expect(rawClient.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'a:*', 'COUNT', 500);
    expect(rawClient.scan).toHaveBeenNthCalledWith(2, '17', 'MATCH', 'a:*', 'COUNT', 500);
  });

  it('delegates publish', async () => {
    await client.publish('chan', 'msg');
    expect(rawClient.publish).toHaveBeenCalledWith('chan', 'msg');
  });

  it('subscribe registers handler and calls raw subscribe', async () => {
    const cb = vi.fn();
    await client.subscribe('my-channel', cb);

    expect(rawClient.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(rawClient.subscribe).toHaveBeenCalledWith('my-channel');

    rawClient._emit('message', 'my-channel', 'hello');
    expect(cb).toHaveBeenCalledWith('my-channel', 'hello');
  });

  it('subscribe without callback still subscribes', async () => {
    await client.subscribe('my-channel');
    expect(rawClient.subscribe).toHaveBeenCalledWith('my-channel');
  });

  it('subscribe matches channel names exactly', async () => {
    const cb = vi.fn();
    await client.subscribe('events', cb);

    rawClient._emit('message', 'myapp:events', 'data');
    expect(cb).not.toHaveBeenCalled();

    rawClient._emit('message', 'events', 'data');
    expect(cb).toHaveBeenCalledWith('events', 'data');
  });

  it('keeps every callback subscribed to the same channel and removes all on unsubscribe', async () => {
    const first = vi.fn();
    const second = vi.fn();
    await client.subscribe('chan', first);
    await client.subscribe('chan', second);

    rawClient._emit('message', 'chan', 'one');
    expect(first).toHaveBeenCalledWith('chan', 'one');
    expect(second).toHaveBeenCalledWith('chan', 'one');

    await client.unsubscribe('chan');
    rawClient._emit('message', 'chan', 'two');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(rawClient._listeners.get('message')?.size ?? 0).toBe(0);
  });

  it('subscribe ignores non-string messages', async () => {
    const cb = vi.fn();
    await client.subscribe('chan', cb);

    rawClient._emit('message', 'chan', 42);
    expect(cb).not.toHaveBeenCalled();
  });

  it('subscribe does not fire for unrelated channels', async () => {
    const cb = vi.fn();
    await client.subscribe('events', cb);

    rawClient._emit('message', 'other-channel', 'data');
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes handler and calls raw unsubscribe', async () => {
    const cb = vi.fn();
    await client.subscribe('chan', cb);

    await client.unsubscribe('chan');
    expect(rawClient.off).toHaveBeenCalledWith('message', expect.any(Function));
    expect(rawClient.unsubscribe).toHaveBeenCalledWith('chan');

    rawClient._emit('message', 'chan', 'should-not-arrive');
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe without prior subscribe still calls raw unsubscribe', async () => {
    await client.unsubscribe('chan');
    expect(rawClient.unsubscribe).toHaveBeenCalledWith('chan');
    expect(rawClient.off).not.toHaveBeenCalled();
  });

  it('duplicate creates a new wrapped client', () => {
    const dup = client.duplicate();
    expect(rawClient.duplicate).toHaveBeenCalled();
    expect(dup).toBeDefined();
    expect(typeof dup.ping).toBe('function');
  });

  it('info delegates with and without section', async () => {
    await client.info('cluster');
    expect(rawClient.info).toHaveBeenCalledWith('cluster');

    rawClient.info.mockClear();
    await client.info();
    expect(rawClient.info).toHaveBeenCalledWith();
  });

  it('on/off delegate to raw client', () => {
    const handler = vi.fn();
    client.on('error', handler);
    expect(rawClient.on).toHaveBeenCalledWith('error', handler);

    client.off('error', handler);
    expect(rawClient.off).toHaveBeenCalledWith('error', handler);
  });
});

describe('detectRedisMode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns cluster when cluster_enabled:1', async () => {
    const rawClient = createMockRawClient();
    rawClient.info.mockResolvedValue('cluster_enabled:1\r\ncluster_state:ok');
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { detectRedisMode } = await import('../factory');
    const mode = await detectRedisMode({ host: 'localhost', port: 6379 });
    expect(mode).toBe('cluster');
    expect(rawClient.quit).toHaveBeenCalled();
  });

  it('returns standalone when cluster not enabled', async () => {
    const rawClient = createMockRawClient();
    rawClient.info.mockResolvedValue('cluster_enabled:0');
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { detectRedisMode } = await import('../factory');
    const mode = await detectRedisMode({ host: 'localhost' });
    expect(mode).toBe('standalone');
    expect(rawClient.quit).toHaveBeenCalled();
  });

  it('quits client even when info throws', async () => {
    const rawClient = createMockRawClient();
    rawClient.info.mockRejectedValue(new Error('connection refused'));
    const mockIoRedis = createMockIoRedis(rawClient);
    vi.doMock('ioredis', () => ({ default: mockIoRedis }));

    const { detectRedisMode } = await import('../factory');
    await expect(detectRedisMode({ host: 'badhost' })).rejects.toThrow('connection refused');
    expect(rawClient.quit).toHaveBeenCalled();
  });
});

describe('keys with prefixes and clusters', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('applies the key prefix to the pattern and strips it from results', async () => {
    const rawClient = createMockRawClient();
    rawClient.scan.mockResolvedValue(['0', ['app[1]:cache:a', 'app[1]:cache:b']]);
    vi.doMock('ioredis', () => ({ default: createMockIoRedis(rawClient) }));

    const { createRedisClient } = await import('../factory');
    const client = await createRedisClient({ keyPrefix: 'app[1]:' });
    const keys = await client.keys('cache:*');

    expect(rawClient.scan).toHaveBeenCalledWith('0', 'MATCH', 'app\\[1\\]:cache:*', 'COUNT', 500);
    expect(keys).toEqual(['cache:a', 'cache:b']);
  });

  it('scans every master node in cluster mode', async () => {
    const rawClient = createMockRawClient();
    const masterA = createMockRawClient();
    const masterB = createMockRawClient();
    masterA.scan.mockResolvedValue(['0', ['{app}:x']]);
    masterB.scan.mockResolvedValue(['0', ['{app}:y']]);
    const nodes = vi.fn().mockReturnValue([masterA, masterB]);
    Object.assign(rawClient, { nodes });
    vi.doMock('ioredis', () => ({ default: createMockIoRedis(rawClient) }));

    const { createRedisClient } = await import('../factory');
    const client = await createRedisClient({
      mode: 'cluster',
      nodes: [{ host: 'h', port: 7000 }],
      keyPrefix: '{app}:',
    });
    const keys = await client.keys('*');

    expect(nodes).toHaveBeenCalledWith('master');
    expect(rawClient.scan).not.toHaveBeenCalled();
    expect(keys.sort()).toEqual(['x', 'y']);
  });
});

describe('createRedisClient validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects a cluster configuration without nodes', async () => {
    vi.doMock('ioredis', () => ({ default: createMockIoRedis(createMockRawClient()) }));
    const { createRedisClient } = await import('../factory');

    await expect(createRedisClient({ mode: 'cluster', nodes: [] })).rejects.toThrow(
      'at least one node'
    );
  });

  it('explains how to install ioredis when it is missing', async () => {
    vi.doMock('ioredis', () => {
      throw new Error("Cannot find package 'ioredis'");
    });
    const { createRedisClient } = await import('../factory');

    await expect(createRedisClient({})).rejects.toThrow('pnpm add ioredis');
  });
});
