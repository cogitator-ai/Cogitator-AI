/**
 * @cogitator/redis - Unified Redis client with cluster support
 *
 * @example Standalone mode
 * ```ts
 * import { createRedisClient } from '@cogitator/redis';
 *
 * const client = await createRedisClient({
 *   url: 'redis://localhost:6379',
 *   keyPrefix: 'myapp:',
 * });
 *
 * await client.set('key', 'value');
 * const value = await client.get('key');
 * ```
 *
 * @example Cluster mode
 * ```ts
 * import { createRedisClient } from '@cogitator/redis';
 *
 * const client = await createRedisClient({
 *   mode: 'cluster',
 *   nodes: [
 *     { host: '10.0.0.1', port: 6379 },
 *     { host: '10.0.0.2', port: 6379 },
 *     { host: '10.0.0.3', port: 6379 },
 *   ],
 *   keyPrefix: '{myapp}:', // Hash tag for cluster
 * });
 * ```
 *
 * @example From environment
 * ```ts
 * import { createRedisClient, createConfigFromEnv } from '@cogitator/redis';
 *
 * // Uses REDIS_URL, REDIS_CLUSTER_NODES, REDIS_PASSWORD, etc.
 * const config = createConfigFromEnv();
 * const client = await createRedisClient(config);
 * ```
 */

export {
  createRedisClient,
  detectRedisMode,
  parseClusterNodesEnv,
  createConfigFromEnv,
} from './factory';

export {
  isClusterConfig,
  type RedisMode,
  type RedisNodeConfig,
  type RedisCommonOptions,
  type RedisStandaloneConfig,
  type RedisClusterConfig,
  type RedisConfig,
  type RedisClient,
  type QueueMetrics,
} from './types';
