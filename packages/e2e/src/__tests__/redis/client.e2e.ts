import { describe, it, expect, afterAll } from 'vitest';
import {
  parseClusterNodesEnv,
  createConfigFromEnv,
  createRedisClient,
  type RedisClient,
} from '@cogitator-ai/redis';

const describeRedis = process.env.TEST_REDIS === 'true' ? describe : describe.skip;

describe('Redis: Config Utilities', () => {
  it('parseClusterNodesEnv parses valid nodes', () => {
    const input = JSON.stringify([
      { host: 'host1', port: 7000 },
      { host: 'host2', port: 7001 },
    ]);

    const result = parseClusterNodesEnv(input);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ host: 'host1', port: 7000 });
    expect(result![1]).toEqual({ host: 'host2', port: 7001 });
  });

  it('parseClusterNodesEnv handles invalid input', () => {
    expect(parseClusterNodesEnv(undefined)).toBeNull();
    expect(parseClusterNodesEnv('')).toBeNull();
    expect(parseClusterNodesEnv('not-json')).toBeNull();
    expect(parseClusterNodesEnv('"just a string"')).toBeNull();
  });

  it('createConfigFromEnv reads REDIS_URL', () => {
    const config = createConfigFromEnv({
      REDIS_URL: 'redis://myhost:6380',
    } as NodeJS.ProcessEnv);

    expect(config.mode).toBe('standalone');
    if (config.mode !== 'cluster') {
      expect(config.url).toBe('redis://myhost:6380');
    }
  });

  it('createConfigFromEnv reads host+port', () => {
    const config = createConfigFromEnv({
      REDIS_HOST: 'custom-host',
      REDIS_PORT: '6380',
    } as NodeJS.ProcessEnv);

    expect(config.mode).toBe('standalone');
    if (config.mode !== 'cluster') {
      expect(config.host).toBe('custom-host');
      expect(config.port).toBe(6380);
    }
  });

  it('createConfigFromEnv detects cluster mode', () => {
    const config = createConfigFromEnv({
      REDIS_CLUSTER_NODES: JSON.stringify([
        { host: '10.0.0.1', port: 6379 },
        { host: '10.0.0.2', port: 6379 },
      ]),
    } as NodeJS.ProcessEnv);

    expect(config.mode).toBe('cluster');
  });

  it('createConfigFromEnv applies default key prefix', () => {
    const standaloneConfig = createConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(standaloneConfig.keyPrefix).toBe('cogitator:');

    const clusterConfig = createConfigFromEnv({
      REDIS_CLUSTER_NODES: JSON.stringify([{ host: 'h1', port: 6379 }]),
    } as NodeJS.ProcessEnv);
    expect(clusterConfig.keyPrefix).toBe('{cogitator}:');
  });
});

describeRedis('Redis: Client Operations', () => {
  let client: RedisClient;
  const testPrefix = `e2e-test-${Date.now()}:`;

  afterAll(async () => {
    if (client) {
      const keys = await client.keys(`${testPrefix}*`);
      if (keys.length > 0) {
        await client.del(...keys);
      }
      await client.quit();
    }
  });

  it('createRedisClient connects standalone', async () => {
    client = await createRedisClient({
      mode: 'standalone',
      host: 'localhost',
      port: 6379,
      keyPrefix: testPrefix,
    });

    const pong = await client.ping();
    expect(pong).toBe('PONG');
  });

  it('RedisClient set/get/del operations', async () => {
    await client.set('str-key', 'hello-world');
    const value = await client.get('str-key');
    expect(value).toBe('hello-world');

    const deleted = await client.del('str-key');
    expect(deleted).toBe(1);

    const gone = await client.get('str-key');
    expect(gone).toBeNull();
  });

  it('RedisClient sorted set operations', async () => {
    await client.zadd('zset-key', 1.0, 'alpha');
    await client.zadd('zset-key', 2.0, 'beta');
    await client.zadd('zset-key', 3.0, 'gamma');

    const range = await client.zrange('zset-key', 0, -1);
    expect(range).toEqual(['alpha', 'beta', 'gamma']);

    const removed = await client.zrem('zset-key', 'beta');
    expect(removed).toBe(1);

    const afterRemove = await client.zrange('zset-key', 0, -1);
    expect(afterRemove).toEqual(['alpha', 'gamma']);

    await client.del('zset-key');
  });
});
