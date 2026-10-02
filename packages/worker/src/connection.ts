import { Cluster, Redis } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import type { QueueConfig } from './types';

export const DEFAULT_QUEUE_NAME = 'cogitator-jobs';

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
      redisOptions: { password: redis.password, maxRetriesPerRequest },
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
    connection: {
      host: redis.host ?? 'localhost',
      port: redis.port ?? 6379,
      password: redis.password,
      maxRetriesPerRequest,
    },
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
    return new Cluster(redis.cluster.nodes, { redisOptions: { password: redis.password } });
  }

  return new Redis({
    host: redis.host ?? 'localhost',
    port: redis.port ?? 6379,
    password: redis.password,
  });
}
