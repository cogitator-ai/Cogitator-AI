import type { Tool } from './tool';
import type { EmbeddingService } from './memory';

export type CacheStrategy = 'exact' | 'semantic';

export type DurationString = `${number}${'ms' | 's' | 'm' | 'h' | 'd' | 'w'}` | string;

export interface ToolCacheConfig {
  strategy: CacheStrategy;
  similarity?: number;
  ttl: DurationString;
  maxSize: number;
  storage: 'memory' | 'redis';
  keyPrefix?: string;
  embeddingService?: EmbeddingService;
  onHit?: (key: string, params: unknown) => void;
  onMiss?: (key: string, params: unknown) => void;
  onEvict?: (key: string) => void;
}

export interface CacheEntry<TResult = unknown> {
  key: string;
  result: TResult;
  embedding?: number[];
  createdAt: number;
  expiresAt: number;
  hits: number;
  lastAccessedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
  hitRate: number;
}

export interface ToolCacheStorage {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  findSimilar?(
    embedding: number[],
    threshold: number,
    limit?: number
  ): Promise<Array<CacheEntry & { score: number }>>;
  getOldest(): Promise<CacheEntry | null>;
  size(): Promise<number>;
  getStats(): CacheStats;
  recordHit(): void;
  recordMiss(): void;
  recordEviction(): void;
}

export interface CachedTool<TParams = unknown, TResult = unknown> extends Tool<TParams, TResult> {
  cache: {
    stats(): CacheStats;
    clear(): Promise<void>;
    invalidate(params: TParams): Promise<boolean>;
    warmup(entries: Array<{ params: TParams; result: TResult }>): Promise<void>;
  };
}

export interface WithCacheOptions extends ToolCacheConfig {
  redisClient?: RedisClientLike;
}

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
}
