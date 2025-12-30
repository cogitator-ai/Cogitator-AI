/**
 * Redis client factory
 *
 * Creates unified Redis clients that work in both standalone and cluster modes.
 */

import type { RedisConfig, RedisClient, RedisClusterConfig, RedisStandaloneConfig } from './types.js';
import { isClusterConfig } from './types.js';

// Internal interface for raw ioredis client methods
// Using `any` for event callbacks to match ioredis's flexible event system
interface RawRedisClient {
  ping(): Promise<string>;
  quit(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, callback: (...args: any[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, callback: (...args: any[]) => void): void;
  duplicate(): RawRedisClient;
  info(section?: string): Promise<string>;
}

/**
 * Create a Redis client from configuration
 *
 * @example Standalone mode
 * ```ts
 * const client = await createRedisClient({
 *   url: 'redis://localhost:6379',
 *   keyPrefix: 'myapp:',
 * });
 * ```
 *
 * @example Cluster mode
 * ```ts
 * const client = await createRedisClient({
 *   mode: 'cluster',
 *   nodes: [
 *     { host: '10.0.0.1', port: 6379 },
 *     { host: '10.0.0.2', port: 6379 },
 *     { host: '10.0.0.3', port: 6379 },
 *   ],
 *   keyPrefix: '{myapp}:', // Hash tag for cluster key routing
 * });
 * ```
 */
export async function createRedisClient(config: RedisConfig): Promise<RedisClient> {
  // Dynamic import with ESM/CJS interop handling
  const ioredisModule = await import('ioredis');
  const ioredis = (ioredisModule.default ?? ioredisModule) as unknown as {
    new (url: string, options?: Record<string, unknown>): RawRedisClient;
    Cluster: new (
      nodes: Array<{ host: string; port: number }>,
      options?: Record<string, unknown>
    ) => RawRedisClient;
  };

  if (isClusterConfig(config)) {
    return createClusterClient(ioredis, config);
  }

  return createStandaloneClient(ioredis, config);
}

// Type for the ioredis module after ESM/CJS normalization
interface IoRedis {
  new (url: string, options?: Record<string, unknown>): RawRedisClient;
  Cluster: new (
    nodes: Array<{ host: string; port: number }>,
    options?: Record<string, unknown>
  ) => RawRedisClient;
}

/**
 * Create a standalone Redis client
 */
function createStandaloneClient(
  ioredis: IoRedis,
  config: RedisStandaloneConfig
): RedisClient {
  const url = config.url ?? buildUrl(config.host, config.port);

  const client = new ioredis(url, {
    password: config.password,
    db: config.db,
    tls: config.tls ? {} : undefined,
    keyPrefix: config.keyPrefix,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    lazyConnect: config.lazyConnect ?? false,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
  });

  return wrapClient(client);
}

/**
 * Create a Redis Cluster client
 */
function createClusterClient(
  ioredis: IoRedis,
  config: RedisClusterConfig
): RedisClient {
  const cluster = new ioredis.Cluster(config.nodes, {
    scaleReads: config.scaleReads ?? 'master',
    redisOptions: {
      password: config.password,
      tls: config.tls ? {} : undefined,
      maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
      lazyConnect: config.lazyConnect ?? false,
    },
    clusterRetryStrategy: (times: number) => Math.min(100 + times * 2, 2000),
    natMap: config.natMap,
    keyPrefix: config.keyPrefix,
  });

  return wrapClient(cluster);
}

/**
 * Build Redis URL from host and port
 */
function buildUrl(host?: string, port?: number): string {
  return `redis://${host ?? 'localhost'}:${port ?? 6379}`;
}

/**
 * Wrap raw Redis client as unified RedisClient interface
 */
function wrapClient(client: RawRedisClient): RedisClient {
  return {
    ping: () => client.ping(),
    quit: () => client.quit(),
    get: (key) => client.get(key),
    set: (key, value) => client.set(key, value),
    setex: (key, seconds, value) => client.setex(key, seconds, value),
    del: (...keys) => client.del(...keys),
    expire: (key, seconds) => client.expire(key, seconds),
    mget: (...keys) => client.mget(...keys),
    zadd: (key, score, member) => client.zadd(key, score, member),
    zrange: (key, start, stop) => client.zrange(key, start, stop),
    zrangebyscore: (key, min, max) => client.zrangebyscore(key, min, max),
    zrem: (key, ...members) => client.zrem(key, ...members),
    smembers: (key) => client.smembers(key),
    publish: (channel, message) => client.publish(channel, message),
    subscribe: async (channel) => {
      await client.subscribe(channel);
    },
    unsubscribe: async (channel) => {
      await client.unsubscribe(channel);
    },
    on: (event, callback) => {
      client.on(event, callback);
    },
    off: (event, callback) => {
      client.off(event, callback);
    },
    keys: (pattern) => client.keys(pattern),
    duplicate: () => wrapClient(client.duplicate()),
    info: (section) => (section ? client.info(section) : client.info()),
  };
}

/**
 * Detect if a Redis server is running in cluster mode
 *
 * Useful for auto-detection when mode is not explicitly specified.
 */
export async function detectRedisMode(
  config: Omit<RedisStandaloneConfig, 'mode'>
): Promise<'standalone' | 'cluster'> {
  const client = await createRedisClient({ ...config, mode: 'standalone' });

  try {
    const info = await client.info('cluster');
    return info.includes('cluster_enabled:1') ? 'cluster' : 'standalone';
  } finally {
    await client.quit();
  }
}

/**
 * Parse REDIS_CLUSTER_NODES environment variable
 *
 * @example
 * ```
 * REDIS_CLUSTER_NODES='[{"host":"10.0.0.1","port":6379},{"host":"10.0.0.2","port":6379}]'
 * ```
 */
export function parseClusterNodesEnv(env?: string): { host: string; port: number }[] | null {
  if (!env) return null;

  try {
    const nodes = JSON.parse(env);
    if (!Array.isArray(nodes)) return null;

    return nodes.filter(
      (node): node is { host: string; port: number } =>
        typeof node === 'object' &&
        node !== null &&
        typeof node.host === 'string' &&
        typeof node.port === 'number'
    );
  } catch {
    return null;
  }
}

/**
 * Create Redis configuration from environment variables
 *
 * Supports:
 * - REDIS_URL - standalone Redis URL
 * - REDIS_HOST + REDIS_PORT - standalone Redis host/port
 * - REDIS_CLUSTER_NODES - JSON array of cluster nodes
 * - REDIS_PASSWORD - authentication password
 * - REDIS_KEY_PREFIX - key prefix (default: 'cogitator:' or '{cogitator}:' for cluster)
 */
export function createConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const clusterNodes = parseClusterNodesEnv(env.REDIS_CLUSTER_NODES);

  if (clusterNodes && clusterNodes.length > 0) {
    return {
      mode: 'cluster',
      nodes: clusterNodes,
      password: env.REDIS_PASSWORD,
      keyPrefix: env.REDIS_KEY_PREFIX ?? '{cogitator}:',
    };
  }

  return {
    mode: 'standalone',
    url: env.REDIS_URL,
    host: env.REDIS_HOST ?? 'localhost',
    port: parseInt(env.REDIS_PORT ?? '6379', 10),
    password: env.REDIS_PASSWORD,
    keyPrefix: env.REDIS_KEY_PREFIX ?? 'cogitator:',
  };
}
