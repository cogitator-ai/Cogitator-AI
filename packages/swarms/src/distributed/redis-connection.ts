/**
 * Connections of distributed swarms: a `RedisConnectionConfig` as an ioredis client, standalone
 * or cluster, and the key helpers that work on both.
 */

import { Cluster, Redis } from 'ioredis';
import type { RedisConnectionConfig } from '@cogitator-ai/types';

/** A single Redis server's connection settings, the url read and the explicit fields applied. */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

/** A client of distributed swarms: one Redis server or a cluster */
export type SwarmRedis = Redis | Cluster;

/**
 * Connection settings from a redis config: `url` first (`redis://` or `rediss://` for TLS,
 * `user:password@`, a `/db` path), then the explicit fields, which win.
 *
 * @throws Error for a url that is not redis:// or rediss://, or a db path that is not a number
 */
export function resolveRedisOptions(redis: RedisConnectionConfig = {}): RedisConnectionOptions {
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

/**
 * What every cluster node connection needs from the config: the credentials and TLS of the url
 * and the explicit fields, without a host, port or database (a cluster has no database).
 */
export function clusterNodeOptions(
  redis: RedisConnectionConfig
): Omit<RedisConnectionOptions, 'host' | 'port' | 'db'> {
  const { host: _host, port: _port, db: _db, ...rest } = resolveRedisOptions(redis);
  return rest;
}

/**
 * An ioredis client for the config, connecting on first use. A `blocking` client (for BLMOVE)
 * waits for a command as long as it takes instead of failing it after a few retries.
 *
 * @throws Error for a cluster without nodes, or a url `resolveRedisOptions` refuses
 */
export function createSwarmRedis(
  redis: RedisConnectionConfig = {},
  options: { blocking?: boolean } = {}
): SwarmRedis {
  const maxRetriesPerRequest = options.blocking ? null : undefined;
  if (redis.cluster) {
    if (redis.cluster.nodes.length === 0) {
      throw new Error('Redis cluster configuration requires at least one node');
    }
    return new Cluster(redis.cluster.nodes, {
      lazyConnect: true,
      redisOptions: { ...clusterNodeOptions(redis), maxRetriesPerRequest },
    });
  }
  return new Redis({ ...resolveRedisOptions(redis), lazyConnect: true, maxRetriesPerRequest });
}

/**
 * Every key matching `pattern`, on each master of a cluster or on the one server. Keys of a
 * swarm share a hash tag, so in a cluster they all sit on one master.
 */
export async function scanSwarmKeys(client: SwarmRedis, pattern: string): Promise<string[]> {
  const servers = client instanceof Cluster ? client.nodes('master') : [client];
  const keys: string[] = [];
  for (const server of servers) {
    let cursor = '0';
    do {
      const [next, found] = await server.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      keys.push(...found);
      cursor = next;
    } while (cursor !== '0');
  }
  return keys;
}

/** Close a client, whether it connected or not */
export async function closeSwarmRedis(client: SwarmRedis): Promise<void> {
  if (client.status === 'end') return;
  if (client.status === 'wait') {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

/** A second connection with the settings of `client`, for a subscriber */
export function duplicateSwarmRedis(client: SwarmRedis): SwarmRedis {
  return client instanceof Cluster ? client.duplicate() : client.duplicate();
}
