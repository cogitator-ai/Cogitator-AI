/**
 * Redis configuration and client types
 *
 * Supports both standalone Redis and Redis Cluster modes.
 */

export type RedisMode = 'standalone' | 'cluster';

/**
 * Redis node configuration for cluster mode
 */
export interface RedisNodeConfig {
  host: string;
  port: number;
}

/**
 * Common Redis options shared between standalone and cluster modes
 */
export interface RedisCommonOptions {
  /** Key prefix for all operations (use {hashtag} format for cluster) */
  keyPrefix?: string;
  /** Password for authentication */
  password?: string;
  /** Enable TLS */
  tls?: boolean;
  /** Max retries per request */
  maxRetriesPerRequest?: number;
  /** Lazy connect - don't connect immediately */
  lazyConnect?: boolean;
}

/**
 * Standalone Redis configuration
 */
export interface RedisStandaloneConfig extends RedisCommonOptions {
  mode?: 'standalone';
  /** Redis URL (e.g., redis://localhost:6379) */
  url?: string;
  /** Host (alternative to url) */
  host?: string;
  /** Port (alternative to url) */
  port?: number;
  /** Database number */
  db?: number;
}

/**
 * Redis Cluster configuration
 */
export interface RedisClusterConfig extends RedisCommonOptions {
  mode: 'cluster';
  /** Array of cluster nodes */
  nodes: RedisNodeConfig[];
  /** Scale reads to replicas: 'master' | 'slave' | 'all' */
  scaleReads?: 'master' | 'slave' | 'all';
  /** NAT mapping for cluster nodes behind NAT */
  natMap?: Record<string, RedisNodeConfig>;
}

/**
 * Combined Redis configuration type
 */
export type RedisConfig = RedisStandaloneConfig | RedisClusterConfig;

/**
 * Unified Redis client interface
 *
 * Provides a common interface for both standalone Redis and Redis Cluster.
 * All methods work identically regardless of the underlying implementation.
 */
export interface RedisClient {
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
  /** `stop` may also be a string such as `'-1'`, as ioredis takes it */
  zrange(key: string, start: number, stop: number | string): Promise<string[]>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;

  smembers(key: string): Promise<string[]>;

  publish(channel: string, message: string): Promise<number>;
  /** Channels are not prefixed with `keyPrefix`. A subscribed connection can only run pub/sub commands, use `duplicate()`. */
  subscribe(channel: string, callback?: (channel: string, message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;

  on(event: 'message', callback: (channel: string, message: string) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'connect' | 'ready' | 'close' | 'reconnecting' | 'end', callback: () => void): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;

  /**
   * Keys matching a glob pattern, relative to `keyPrefix` (the prefix is applied to the
   * pattern and stripped from results, so they can be passed to `get`/`del`). Uses SCAN
   * instead of the blocking KEYS command and covers every master node in cluster mode.
   */
  keys(pattern: string): Promise<string[]>;

  /**
   * One SCAN step with ioredis' `SCAN cursor MATCH pattern COUNT count` signature: start with
   * cursor `'0'` and call again with the returned cursor until it is `'0'` again. Like `keys`,
   * the pattern and the returned keys are relative to `keyPrefix`; in cluster mode the cursor
   * walks every master node in turn.
   */
  scan(
    cursor: number | string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number | string
  ): Promise<[cursor: string, keys: string[]]>;

  duplicate(): RedisClient;

  info(section?: string): Promise<string>;
}

/**
 * Check if config is for cluster mode
 */
export function isClusterConfig(config: RedisConfig): config is RedisClusterConfig {
  return config.mode === 'cluster' || ('nodes' in config && Array.isArray(config.nodes));
}
