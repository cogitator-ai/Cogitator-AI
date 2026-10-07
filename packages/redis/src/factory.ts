/**
 * Redis client factory
 *
 * Creates unified Redis clients that work in both standalone and cluster modes.
 */

import type { RedisConfig, RedisClient, RedisClusterConfig, RedisStandaloneConfig } from './types';
import { isClusterConfig } from './types';

type EventCallback = (...args: unknown[]) => void;

interface RawRedisClient {
  ping(): Promise<string>;
  quit(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  exists(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number | string): Promise<string[]>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number | string
  ): Promise<[string, string[]]>;
  on(event: string, callback: EventCallback): void;
  off(event: string, callback: EventCallback): void;
  duplicate(): RawRedisClient;
  info(section?: string): Promise<string>;
  nodes?(role: 'master'): RawRedisClient[];
}

interface WrapOptions {
  keyPrefix: string;
  cluster: boolean;
}

const SCAN_BATCH_SIZE = 500;

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
  if (isClusterConfig(config) && config.nodes.length === 0) {
    throw new Error('Redis cluster configuration requires at least one node');
  }

  const ioredis = await loadIoRedis();

  if (isClusterConfig(config)) {
    return createClusterClient(ioredis, config);
  }

  return createStandaloneClient(ioredis, config);
}

interface IoRedis {
  new (url: string, options?: Record<string, unknown>): RawRedisClient;
  Cluster: new (
    nodes: { host: string; port: number }[],
    options?: Record<string, unknown>
  ) => RawRedisClient;
}

async function loadIoRedis(): Promise<IoRedis> {
  try {
    const ioredisModule = await import('ioredis');
    return (ioredisModule.default ?? ioredisModule) as unknown as IoRedis;
  } catch (error) {
    throw new Error(
      '@cogitator-ai/redis requires the "ioredis" package. Install it: pnpm add ioredis',
      {
        cause: error,
      }
    );
  }
}

/**
 * Create a standalone Redis client
 */
function createStandaloneClient(ioredis: IoRedis, config: RedisStandaloneConfig): RedisClient {
  const url = resolveStandaloneUrl(config);

  const client = new ioredis(url, {
    password: config.password,
    db: config.db,
    tls: config.tls ? {} : undefined,
    keyPrefix: config.keyPrefix,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    lazyConnect: config.lazyConnect ?? false,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
  });

  return wrapClient(client, { keyPrefix: config.keyPrefix ?? '', cluster: false });
}

/**
 * Create a Redis Cluster client
 */
function createClusterClient(ioredis: IoRedis, config: RedisClusterConfig): RedisClient {
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

  return wrapClient(cluster, { keyPrefix: config.keyPrefix ?? '', cluster: true });
}

/**
 * The url a standalone client connects to, so the explicit fields win over what `url` says
 * (ioredis lets the url win over its options): explicit `host` and `port` are written into it,
 * and its password and database are dropped when `password` or `db` is set, which the client
 * options then carry. Without `url` it is built from `host` and `port`. A url that is not a URL
 * (a unix socket path) is kept as it is.
 */
export function resolveStandaloneUrl(config: RedisStandaloneConfig): string {
  if (!config.url) return buildUrl(config.host, config.port);
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return config.url;
  }
  if (config.host !== undefined) url.hostname = config.host;
  if (config.port !== undefined) url.port = String(config.port);
  if (config.password !== undefined) url.password = '';
  if (config.db !== undefined) url.pathname = '';
  return url.toString();
}

/**
 * Build Redis URL from host and port
 */
function buildUrl(host?: string, port?: number): string {
  return `redis://${host ?? 'localhost'}:${port ?? 6379}`;
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&');
}

function parseClusterCursor(cursor: string, nodeCount: number): { node: number; at: string } {
  if (cursor === '0') return { node: 0, at: '0' };
  const match = /^(\d+):(\d+)$/.exec(cursor);
  const node = match ? Number(match[1]) : -1;
  if (!match || node >= nodeCount) {
    throw new Error(`Invalid SCAN cursor "${cursor}" for a cluster of ${nodeCount} master nodes`);
  }
  return { node, at: match[2] };
}

/**
 * One SCAN step that applies the key prefix to the pattern and strips it from the keys
 * (ioredis prefixes neither). In cluster mode the cursor is `<master index>:<node cursor>`,
 * so walking it to `'0'` covers every master.
 */
async function scanStep(
  client: RawRedisClient,
  cursor: string,
  pattern: string,
  count: number | string,
  options: WrapOptions
): Promise<[cursor: string, keys: string[]]> {
  const match = escapeGlob(options.keyPrefix) + pattern;
  const strip = (keys: string[]) =>
    keys.map((key) =>
      key.startsWith(options.keyPrefix) ? key.slice(options.keyPrefix.length) : key
    );

  if (!options.cluster || !client.nodes) {
    const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', count);
    return [next, strip(keys)];
  }

  const masters = client.nodes('master');
  const { node, at } = parseClusterCursor(cursor, masters.length);
  const [next, keys] = await masters[node].scan(at, 'MATCH', match, 'COUNT', count);
  if (next !== '0') return [`${node}:${next}`, strip(keys)];
  return [node + 1 < masters.length ? `${node + 1}:0` : '0', strip(keys)];
}

/** KEYS-compatible lookup built on SCAN: non-blocking and covering every master of a cluster. */
async function scanKeys(
  client: RawRedisClient,
  pattern: string,
  options: WrapOptions
): Promise<string[]> {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await scanStep(client, cursor, pattern, SCAN_BATCH_SIZE, options);
    for (const key of keys) found.add(key);
    cursor = next;
  } while (cursor !== '0');
  return [...found];
}

/**
 * Wrap raw Redis client as unified RedisClient interface
 */
function wrapClient(client: RawRedisClient, options: WrapOptions): RedisClient {
  const subscriptionHandlers = new Map<string, Set<EventCallback>>();

  return {
    ping: () => client.ping(),
    quit: () => client.quit(),
    get: (key) => client.get(key),
    set: (key, value) => client.set(key, value),
    setex: (key, seconds, value) => client.setex(key, seconds, value),
    del: (...keys) => client.del(...keys),
    expire: (key, seconds) => client.expire(key, seconds),
    mget: (...keys) => client.mget(...keys),
    exists: (...keys) => client.exists(...keys),
    incr: (key) => client.incr(key),
    decr: (key) => client.decr(key),
    zadd: (key, score, member) => client.zadd(key, score, member),
    zrange: (key, start, stop) => client.zrange(key, start, stop),
    zrangebyscore: (key, min, max) => client.zrangebyscore(key, min, max),
    zrem: (key, ...members) => client.zrem(key, ...members),
    smembers: (key) => client.smembers(key),
    publish: (channel, message) => client.publish(channel, message),
    subscribe: async (channel, callback) => {
      if (callback) {
        const handler: EventCallback = (ch: unknown, msg: unknown) => {
          if (typeof msg === 'string' && ch === channel) {
            callback(channel, msg);
          }
        };
        let handlers = subscriptionHandlers.get(channel);
        if (!handlers) {
          handlers = new Set();
          subscriptionHandlers.set(channel, handlers);
        }
        handlers.add(handler);
        client.on('message', handler);
      }
      await client.subscribe(channel);
    },
    unsubscribe: async (channel) => {
      const handlers = subscriptionHandlers.get(channel);
      if (handlers) {
        for (const handler of handlers) client.off('message', handler);
        subscriptionHandlers.delete(channel);
      }
      await client.unsubscribe(channel);
    },
    on: (event, callback) => {
      client.on(event, callback as EventCallback);
    },
    off: (event, callback) => {
      client.off(event, callback as EventCallback);
    },
    keys: (pattern) => scanKeys(client, pattern, options),
    scan: (cursor, _match, pattern, _count, count) =>
      scanStep(client, String(cursor), pattern, count, options),
    duplicate: () => wrapClient(client.duplicate(), options),
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
 * - REDIS_URL - standalone Redis URL (REDIS_HOST and REDIS_PORT are ignored with it)
 * - REDIS_HOST + REDIS_PORT - standalone Redis host/port
 * - REDIS_CLUSTER_NODES - JSON array of cluster nodes
 * - REDIS_PASSWORD - authentication password
 * - REDIS_KEY_PREFIX - key prefix (default: 'cogitator:' or '{cogitator}:' for cluster)
 *
 * @throws when REDIS_CLUSTER_NODES is set but contains no valid node, instead of silently
 * falling back to a standalone localhost connection
 */
export function createConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const rawClusterNodes = env.REDIS_CLUSTER_NODES?.trim();
  const clusterNodes = parseClusterNodesEnv(rawClusterNodes);

  if (rawClusterNodes && (!clusterNodes || clusterNodes.length === 0)) {
    throw new Error(
      'REDIS_CLUSTER_NODES must be a JSON array of {"host": string, "port": number} objects'
    );
  }

  if (clusterNodes && clusterNodes.length > 0) {
    return {
      mode: 'cluster',
      nodes: clusterNodes,
      password: env.REDIS_PASSWORD,
      keyPrefix: env.REDIS_KEY_PREFIX ?? '{cogitator}:',
    };
  }

  const port = parseInt(env.REDIS_PORT ?? '6379', 10);
  const url = env.REDIS_URL?.trim() || undefined;

  if (url) {
    return {
      mode: 'standalone',
      url,
      password: env.REDIS_PASSWORD,
      keyPrefix: env.REDIS_KEY_PREFIX ?? 'cogitator:',
    };
  }

  return {
    mode: 'standalone',
    url: undefined,
    host: env.REDIS_HOST ?? 'localhost',
    port: Number.isNaN(port) ? 6379 : port,
    password: env.REDIS_PASSWORD,
    keyPrefix: env.REDIS_KEY_PREFIX ?? 'cogitator:',
  };
}
