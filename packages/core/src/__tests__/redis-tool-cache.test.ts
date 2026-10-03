import { describe, it, expect, expectTypeOf, beforeEach, vi } from 'vitest';
import type { CacheEntry, RedisClientLike } from '@cogitator-ai/types';
import { RedisToolCacheStorage, createToolCacheStorage } from '../cache/index';

class FakeRedis implements RedisClientLike {
  readonly strings = new Map<string, string>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  expire(key: string): void {
    this.strings.delete(key);
  }

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  async setex(key: string, _seconds: number, value: string) {
    this.strings.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key) || this.sortedSets.delete(key)) removed++;
    }
    return removed;
  }

  async mget(...keys: string[]) {
    return keys.map((key) => this.strings.get(key) ?? null);
  }

  async zadd(key: string, score: number, member: string) {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.sortedSets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zrange(key: string, start: number, stopArg: string) {
    const stop = Number(stopArg);
    const members = [...(this.sortedSets.get(key) ?? new Map<string, number>()).entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
    const end = stop < 0 ? members.length + stop + 1 : stop + 1;
    return members.slice(start, end);
  }

  async zrem(key: string, ...members: string[]) {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  }

  async incr(key: string) {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async decr(key: string) {
    const next = Number(this.strings.get(key) ?? '0') - 1;
    this.strings.set(key, String(next));
    return next;
  }

  async exists(...keys: string[]) {
    return keys.filter((key) => this.strings.has(key)).length;
  }

  async scan(
    _cursor: number | string,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    _count: number | string
  ): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, '');
    const keys = [...this.strings.keys(), ...this.sortedSets.keys()].filter((key) =>
      key.startsWith(prefix)
    );
    return ['0', keys];
  }
}

function entry(key: string, overrides: Partial<CacheEntry> = {}): CacheEntry {
  const now = Date.now();
  return {
    key,
    result: { value: key },
    createdAt: now,
    expiresAt: now + 60_000,
    hits: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

describe('RedisToolCacheStorage', () => {
  let redis: FakeRedis;
  let storage: RedisToolCacheStorage;

  beforeEach(() => {
    redis = new FakeRedis();
    storage = new RedisToolCacheStorage({ client: redis, keyPrefix: 'tc:', maxSize: 2 });
  });

  it('stores, reads and deletes entries while tracking size', async () => {
    await storage.set('a', entry('a'));

    expect(await storage.size()).toBe(1);
    expect(await storage.has('a')).toBe(true);
    expect((await storage.get('a'))?.result).toEqual({ value: 'a' });

    await storage.delete('a');

    expect(await storage.size()).toBe(0);
    expect(await storage.get('a')).toBeNull();
  });

  it('reports LRU evictions through onEvict', async () => {
    const onEvict = vi.fn();
    const evicting = new RedisToolCacheStorage({ client: redis, maxSize: 1, onEvict });

    await evicting.set('a', entry('a', { lastAccessedAt: 1 }));
    await evicting.set('b', entry('b', { lastAccessedAt: 2 }));

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('forwards onEvict from createToolCacheStorage', async () => {
    const onEvict = vi.fn();
    const evicting = createToolCacheStorage('redis', { redisClient: redis, maxSize: 1, onEvict });

    await evicting.set('a', entry('a', { lastAccessedAt: 1 }));
    await evicting.set('b', entry('b', { lastAccessedAt: 2 }));

    expect(onEvict).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('separates a key prefix without a trailing colon from the key names', async () => {
    const plain = new RedisToolCacheStorage({ client: redis, keyPrefix: 'toolcache' });

    await plain.set('toolcache:search:abc', entry('toolcache:search:abc'));

    expect([...redis.strings.keys()]).toEqual([
      'toolcache:entry:toolcache:search:abc',
      'toolcache:counter',
    ]);
    expect([...redis.sortedSets.keys()]).toEqual(['toolcache:lru']);
  });

  it('does not double count overwritten keys', async () => {
    await storage.set('a', entry('a'));
    await storage.set('a', entry('a', { result: 'updated' }));

    expect(await storage.size()).toBe(1);
  });

  it('evicts the least recently used entry when full', async () => {
    await storage.set('a', entry('a', { lastAccessedAt: 1 }));
    await storage.set('b', entry('b', { lastAccessedAt: 2 }));
    await storage.set('c', entry('c', { lastAccessedAt: 3 }));

    expect(await storage.has('a')).toBe(false);
    expect(await storage.has('b')).toBe(true);
    expect(await storage.has('c')).toBe(true);
    expect(await storage.size()).toBe(2);
    expect(storage.getStats().evictions).toBe(1);
  });

  it('reconciles the size counter after Redis expires entries by TTL', async () => {
    await storage.set('a', entry('a', { lastAccessedAt: 1 }));
    await storage.set('b', entry('b', { lastAccessedAt: 2 }));
    redis.expire('tc:entry:a');
    redis.expire('tc:entry:b');

    await storage.set('c', entry('c', { lastAccessedAt: 3 }));

    expect(await storage.size()).toBe(1);
    expect(storage.getStats().evictions).toBe(0);
    expect(await redis.zrange('tc:lru', 0, '-1')).toEqual(['c']);
  });

  it('drops logically expired entries on read', async () => {
    await storage.set('a', entry('a', { expiresAt: Date.now() + 5_000 }));
    const stored = JSON.parse((await redis.get('tc:entry:a'))!) as CacheEntry;
    await redis.setex('tc:entry:a', 1, JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }));

    expect(await storage.get('a')).toBeNull();
    expect(await storage.size()).toBe(0);
  });

  it('finds semantically similar entries above the threshold', async () => {
    await storage.set('a', entry('a', { embedding: [1, 0] }));
    await storage.set('b', entry('b', { embedding: [0, 1] }));

    const matches = await storage.findSimilar([1, 0.1], 0.9, 5);

    expect(matches.map((m) => m.key)).toEqual(['a']);
    expect(matches[0].score).toBeGreaterThan(0.9);
  });

  it('clears every key under the prefix', async () => {
    await storage.set('a', entry('a'));
    await storage.clear();

    expect(await storage.size()).toBe(0);
    expect(redis.strings.size).toBe(0);
    expect(redis.sortedSets.size).toBe(0);
  });
});

describe('RedisClientLike', () => {
  it('takes the scan and zrange of ioredis 5 and 6', () => {
    type Callback<T> = (err?: Error | null, result?: T) => void;
    type ScanReply = [cursor: string, elements: string[]];
    interface Ioredis {
      scan(cursor: number | string, callback?: Callback<ScanReply>): Promise<ScanReply>;
      scan(
        cursor: number | string,
        patternToken: 'MATCH',
        pattern: string,
        countToken: 'COUNT',
        count: number | string,
        callback?: Callback<ScanReply>
      ): Promise<ScanReply>;
      zrange(
        key: string,
        start: string | number,
        stop: string,
        callback?: Callback<string[]>
      ): Promise<string[]>;
    }

    expectTypeOf<Ioredis['scan']>().toExtend<RedisClientLike['scan']>();
    expectTypeOf<Ioredis['zrange']>().toExtend<RedisClientLike['zrange']>();
  });
});
