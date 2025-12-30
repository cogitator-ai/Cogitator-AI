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
  // Connection
  ping(): Promise<string>;
  quit(): Promise<string>;

  // String operations
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;

  // Sorted set operations
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;

  // Set operations
  smembers(key: string): Promise<string[]>;

  // Pub/Sub
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, callback?: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;

  // Events - flexible callback to match ioredis event emitter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, callback: (...args: any[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, callback: (...args: any[]) => void): void;

  // Keys pattern matching
  keys(pattern: string): Promise<string[]>;

  // Cluster-specific (no-op on standalone)
  duplicate(): RedisClient;

  // Info
  info(section?: string): Promise<string>;
}

/**
 * Queue metrics for monitoring
 */
export interface QueueMetrics {
  /** Jobs waiting to be processed */
  waiting: number;
  /** Jobs currently being processed */
  active: number;
  /** Jobs completed successfully */
  completed: number;
  /** Jobs that failed */
  failed: number;
  /** Jobs scheduled for later */
  delayed: number;
  /** Total queue depth (waiting + delayed) */
  depth: number;
}

/**
 * Check if config is for cluster mode
 */
export function isClusterConfig(config: RedisConfig): config is RedisClusterConfig {
  return config.mode === 'cluster' || ('nodes' in config && Array.isArray(config.nodes));
}
