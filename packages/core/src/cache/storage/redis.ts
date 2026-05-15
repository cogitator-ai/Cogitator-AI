import type {
  CacheEntry,
  CacheStats,
  ToolCacheStorage,
  RedisClientLike,
} from '@cogitator-ai/types';
import { cosineSimilarity } from '../cache-key';

export interface RedisToolCacheStorageConfig {
  client: RedisClientLike;
  keyPrefix?: string;
  maxSize?: number;
}

export class RedisToolCacheStorage implements ToolCacheStorage {
  private client: RedisClientLike;
  private prefix: string;
  private maxSize: number;
  private lruKey: string;
  private counterKey: string;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    evictions: 0,
    hitRate: 0,
  };

  constructor(config: RedisToolCacheStorageConfig) {
    this.client = config.client;
    this.prefix = config.keyPrefix ?? 'toolcache:';
    this.maxSize = config.maxSize ?? 1000;
    this.lruKey = `${this.prefix}lru`;
    this.counterKey = `${this.prefix}counter`;
  }

  private entryKey(key: string): string {
    return `${this.prefix}entry:${key}`;
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  recordHit(): void {
    this.stats.hits++;
    this.updateHitRate();
  }

  recordMiss(): void {
    this.stats.misses++;
    this.updateHitRate();
  }

  recordEviction(): void {
    this.stats.evictions++;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async get(key: string): Promise<CacheEntry | null> {
    const data = await this.client.get(this.entryKey(key));
    if (!data) return null;

    const entry = JSON.parse(data) as CacheEntry;

    if (Date.now() > entry.expiresAt) {
      await this.delete(key);
      return null;
    }

    entry.hits++;
    entry.lastAccessedAt = Date.now();

    const ttlSeconds = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    if (ttlSeconds > 0) {
      await this.client.setex(this.entryKey(key), ttlSeconds, JSON.stringify(entry));
      await this.client.zadd(this.lruKey, entry.lastAccessedAt, key);
    }

    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const currentSize = await this.size();
    if (currentSize >= this.maxSize) {
      await this.evictOldest();
    }

    const ttlSeconds = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    if (ttlSeconds > 0) {
      const isNew = !(await this.client.exists(this.entryKey(key)));
      await this.client.setex(this.entryKey(key), ttlSeconds, JSON.stringify(entry));
      await this.client.zadd(this.lruKey, entry.lastAccessedAt, key);
      if (isNew) {
        await this.client.incr(this.counterKey);
      }
    }

    this.stats.size = await this.size();
  }

  async delete(key: string): Promise<void> {
    const existed = await this.client.exists(this.entryKey(key));
    await this.client.del(this.entryKey(key));
    await this.client.zrem(this.lruKey, key);
    if (existed) {
      await this.client.decr(this.counterKey);
    }
    this.stats.size = await this.size();
  }

  async has(key: string): Promise<boolean> {
    const data = await this.client.get(this.entryKey(key));
    return data !== null;
  }

  async clear(): Promise<void> {
    let cursor = 0;
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, {
        match: `${this.prefix}*`,
        count: 100,
      });
      cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : nextCursor;
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } while (cursor !== 0);
    this.stats.size = 0;
  }

  async getOldest(): Promise<CacheEntry | null> {
    const keys = await this.client.zrange(this.lruKey, 0, 0);
    if (keys.length === 0) return null;
    return this.get(keys[0]);
  }

  async size(): Promise<number> {
    const val = await this.client.get(this.counterKey);
    return val ? Math.max(0, parseInt(val, 10)) : 0;
  }

  async findSimilar(
    embedding: number[],
    threshold: number,
    limit: number = 1
  ): Promise<Array<CacheEntry & { score: number }>> {
    const results: Array<CacheEntry & { score: number }> = [];
    const now = Date.now();
    const pattern = `${this.prefix}entry:*`;

    let cursor = 0;
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, {
        match: pattern,
        count: 100,
      });
      cursor = typeof nextCursor === 'string' ? parseInt(nextCursor, 10) : nextCursor;

      if (keys.length === 0) continue;

      const values = await this.client.mget(...keys);
      for (const data of values) {
        if (!data) continue;

        const entry = JSON.parse(data) as CacheEntry;
        if (now > entry.expiresAt) continue;
        if (!entry.embedding) continue;

        const score = cosineSimilarity(embedding, entry.embedding);
        if (score >= threshold) {
          results.push({ ...entry, score });
        }
      }
    } while (cursor !== 0);

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async evictOldest(): Promise<void> {
    const keys = await this.client.zrange(this.lruKey, 0, 0);
    if (keys.length > 0) {
      await this.delete(keys[0]);
      this.recordEviction();
    }
  }
}
