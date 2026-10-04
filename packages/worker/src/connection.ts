import { Cluster, Redis } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import type { QueueConfig } from './types';

export const DEFAULT_QUEUE_NAME = 'cogitator-jobs';

/** A single Redis server's connection settings, the url read and the explicit fields applied. */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

/**
 * Connection settings from the queue's redis config: `url` first (`redis://` or `rediss://` for
 * TLS, `user:password@`, a `/db` path), then the explicit fields, which win.
 *
 * @throws Error for a url that is not redis:// or rediss://, or a db path that is not a number
 */
export function resolveRedisOptions(redis: RedisConnectionConfig): RedisConnectionOptions {
  let fromUrl: Partial<RedisConnectionOptions> & { tlsFromUrl?: boolean } = {};
  if (redis.url) {
    const url = new URL(redis.url);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error(`Redis url must start with redis:// or rediss://, got ${url.protocol}//`);
    }
    const dbPath = url.pathname.replace(/^\//, '');
    if (dbPath !== '' && !/^\d+$/.test(dbPath)) {
      throw new Error(`Redis url database must be a number, got "${dbPath}"`);
    }
    fromUrl = {
      ...(url.hostname && { host: url.hostname }),
      ...(url.port && { port: Number(url.port) }),
      ...(url.username && { username: decodeURIComponent(url.username) }),
      ...(url.password && { password: decodeURIComponent(url.password) }),
      ...(dbPath !== '' && { db: Number(dbPath) }),
      tlsFromUrl: url.protocol === 'rediss:',
    };
  }
  const tls = redis.tls ?? fromUrl.tlsFromUrl ?? false;
  const username = redis.username ?? fromUrl.username;
  const password = redis.password ?? fromUrl.password;
  const db = redis.db ?? fromUrl.db;
  return {
    host: redis.host ?? fromUrl.host ?? 'localhost',
    port: redis.port ?? fromUrl.port ?? 6379,
    ...(username !== undefined && { username }),
    ...(password !== undefined && { password }),
    ...(db !== undefined && { db }),
    ...(tls && { tls: {} }),
  };
}

export type RedisClient = Redis | Cluster;

type RedisConnectionConfig = QueueConfig['redis'];

/**
 * BullMQ key prefix; cluster mode needs a hash tag so all queue keys share a slot.
 */
export function queuePrefix(redis: RedisConnectionConfig): string {
  return redis.cluster ? '{cogitator}' : 'cogitator';
}

export interface BullConnection {
  connection: ConnectionOptions;
  /** Close connections that BullMQ treats as shared (cluster instances) */
  dispose(): Promise<void>;
}

/**
 * What every cluster node connection needs from the config: the credentials and TLS of the url
 * and the explicit fields, without a host, port or database (a cluster has no database).
 */
function clusterNodeOptions(
  redis: RedisConnectionConfig
): Omit<RedisConnectionOptions, 'host' | 'port' | 'db'> {
  const { host: _host, port: _port, db: _db, ...rest } = resolveRedisOptions(redis);
  return rest;
}

/**
 * Connection for BullMQ queues and workers. Blocking (worker) connections must not limit
 * retries per request, as BullMQ requires. Cluster instances are shared with BullMQ, which
 * does not close them, so callers must `dispose()` them.
 */
export function createBullConnection(
  redis: RedisConnectionConfig,
  options: { blocking?: boolean } = {}
): BullConnection {
  const maxRetriesPerRequest = options.blocking ? null : undefined;

  if (redis.cluster) {
    if (redis.cluster.nodes.length === 0) {
      throw new Error('Redis cluster configuration requires at least one node');
    }
    const cluster = new Cluster(redis.cluster.nodes, {
      lazyConnect: true,
      redisOptions: { ...clusterNodeOptions(redis), maxRetriesPerRequest },
    });
    return {
      connection: cluster,
      dispose: async () => {
        if (cluster.status === 'end') return;
        if (cluster.status === 'wait') {
          cluster.disconnect();
          return;
        }
        await cluster.quit();
      },
    };
  }

  return {
    connection: { ...resolveRedisOptions(redis), maxRetriesPerRequest },
    dispose: async () => {},
  };
}

/**
 * Plain client (e.g. for publishing swarm results) using the same Redis configuration.
 */
export function createRedisClient(redis: RedisConnectionConfig): RedisClient {
  if (redis.cluster) {
    if (redis.cluster.nodes.length === 0) {
      throw new Error('Redis cluster configuration requires at least one node');
    }
    return new Cluster(redis.cluster.nodes, { redisOptions: clusterNodeOptions(redis) });
  }

  return new Redis(resolveRedisOptions(redis));
}
