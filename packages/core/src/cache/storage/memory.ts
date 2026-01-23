import type { CacheEntry, CacheStats, ToolCacheStorage } from '@cogitator-ai/types';
import { cosineSimilarity } from '../cache-key';

export class InMemoryToolCacheStorage implements ToolCacheStorage {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    evictions: 0,
    hitRate: 0,
  };

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
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
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
      return null;
    }

    entry.hits++;
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    while (this.cache.size >= this.maxSize) {
      await this.evictOldest();
    }
    this.cache.set(key, entry);
    this.stats.size = this.cache.size;
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    this.stats.size = this.cache.size;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
      return false;
    }
    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.stats.size = 0;
  }

  async getOldest(): Promise<CacheEntry | null> {
    let oldest: CacheEntry | null = null;

    for (const entry of this.cache.values()) {
      if (!oldest || entry.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = entry;
      }
    }

    return oldest;
  }

  async size(): Promise<number> {
    return this.cache.size;
  }

  async findSimilar(
    embedding: number[],
    threshold: number,
    limit: number = 1
  ): Promise<Array<CacheEntry & { score: number }>> {
    const results: Array<CacheEntry & { score: number }> = [];
    const now = Date.now();

    for (const entry of this.cache.values()) {
      if (now > entry.expiresAt) continue;
      if (!entry.embedding) continue;

      const score = cosineSimilarity(embedding, entry.embedding);
      if (score >= threshold) {
        results.push({ ...entry, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async evictOldest(): Promise<void> {
    const oldest = await this.getOldest();
    if (oldest) {
      this.cache.delete(oldest.key);
      this.stats.size = this.cache.size;
      this.recordEviction();
    }
  }
}
