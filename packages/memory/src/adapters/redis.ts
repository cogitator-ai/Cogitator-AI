/**
 * Redis adapter for short-term memory
 *
 * Uses Redis sorted sets for ordered message retrieval.
 * Supports TTL for automatic expiration.
 */

import type {
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  RedisAdapterConfig,
  MemoryProvider,
} from '@cogitator/types';
import { BaseMemoryAdapter } from './base.js';

type RedisClient = {
  ping(): Promise<string>;
  quit(): Promise<string>;
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
};

export class RedisAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'redis';

  private client: RedisClient | null = null;
  private config: RedisAdapterConfig;
  private prefix: string;
  private ttl: number;

  constructor(config: RedisAdapterConfig) {
    super();
    this.config = config;
    this.prefix = config.keyPrefix ?? 'cogitator:';
    this.ttl = config.ttl ?? 86400; // 24 hours default
  }

  async connect(): Promise<MemoryResult<void>> {
    try {
      const ioredis = await import('ioredis');
      // Handle both ESM default export and CommonJS module.exports
      const RedisClass = (ioredis.default ?? ioredis) as unknown as new (
        url: string
      ) => RedisClient;
      this.client = new RedisClass(this.config.url);
      await this.client.ping();
      return this.success(undefined);
    } catch (error) {
      return this.failure(
        `Redis connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    return this.success(undefined);
  }

  private key(type: string, id: string): string {
    return `${this.prefix}${type}:${id}`;
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<MemoryResult<Thread>> {
    if (!this.client) return this.failure('Not connected');

    const thread: Thread = {
      id: this.generateId('thread'),
      agentId,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.client.setex(
      this.key('thread', thread.id),
      this.ttl,
      JSON.stringify(thread)
    );

    return this.success(thread);
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.client) return this.failure('Not connected');

    const data = await this.client.get(this.key('thread', threadId));
    if (!data) return this.success(null);

    const thread = JSON.parse(data) as Thread;
    thread.createdAt = new Date(thread.createdAt);
    thread.updatedAt = new Date(thread.updatedAt);
    return this.success(thread);
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    const result = await this.getThread(threadId);
    if (!result.success) return result;
    if (!result.data) return this.failure(`Thread not found: ${threadId}`);

    const thread = result.data;
    thread.metadata = { ...thread.metadata, ...metadata };
    thread.updatedAt = new Date();

    await this.client!.setex(
      this.key('thread', threadId),
      this.ttl,
      JSON.stringify(thread)
    );

    return this.success(thread);
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.client) return this.failure('Not connected');

    // Get all entry keys for this thread
    const setKey = this.key('thread:entries', threadId);
    const entryKeys = await this.client.zrange(setKey, 0, -1);

    if (entryKeys.length > 0) {
      await this.client.del(...entryKeys);
    }
    await this.client.del(this.key('thread', threadId));
    await this.client.del(setKey);

    return this.success(undefined);
  }

  async addEntry(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>
  ): Promise<MemoryResult<MemoryEntry>> {
    if (!this.client) return this.failure('Not connected');

    const full: MemoryEntry = {
      ...entry,
      id: this.generateId('entry'),
      createdAt: new Date(),
    };

    const key = this.key('entry', full.id);
    await this.client.setex(key, this.ttl, JSON.stringify(full));

    // Add to thread's entry set with score = timestamp for ordering
    const setKey = this.key('thread:entries', entry.threadId);
    await this.client.zadd(setKey, full.createdAt.getTime(), key);

    // Refresh thread set TTL
    await this.client.expire(setKey, this.ttl);

    return this.success(full);
  }

  async getEntries(
    options: MemoryQueryOptions
  ): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.client) return this.failure('Not connected');

    const setKey = this.key('thread:entries', options.threadId);

    // Get keys sorted by timestamp
    let keys: string[];
    if (options.before || options.after) {
      const min = options.after?.getTime() ?? '-inf';
      const max = options.before?.getTime() ?? '+inf';
      keys = await this.client.zrangebyscore(setKey, min, max);
    } else {
      keys = await this.client.zrange(setKey, 0, -1);
    }

    if (keys.length === 0) return this.success([]);

    // Apply limit from end (most recent)
    if (options.limit && keys.length > options.limit) {
      keys = keys.slice(-options.limit);
    }

    // Fetch all entries
    const values = await this.client.mget(...keys);
    const entries: MemoryEntry[] = values
      .filter((v): v is string => v !== null)
      .map((v) => {
        const entry = JSON.parse(v) as MemoryEntry;
        entry.createdAt = new Date(entry.createdAt);
        if (!options.includeToolCalls) {
          entry.toolCalls = undefined;
          entry.toolResults = undefined;
        }
        return entry;
      });

    return this.success(entries);
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    if (!this.client) return this.failure('Not connected');

    const data = await this.client.get(this.key('entry', entryId));
    if (!data) return this.success(null);

    const entry = JSON.parse(data) as MemoryEntry;
    entry.createdAt = new Date(entry.createdAt);
    return this.success(entry);
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.client) return this.failure('Not connected');

    const result = await this.getEntry(entryId);
    if (result.success && result.data) {
      const key = this.key('entry', entryId);
      await this.client.zrem(
        this.key('thread:entries', result.data.threadId),
        key
      );
      await this.client.del(key);
    }

    return this.success(undefined);
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.client) return this.failure('Not connected');

    const setKey = this.key('thread:entries', threadId);
    const keys = await this.client.zrange(setKey, 0, -1);

    if (keys.length > 0) {
      await this.client.del(...keys);
    }
    await this.client.del(setKey);

    return this.success(undefined);
  }
}
