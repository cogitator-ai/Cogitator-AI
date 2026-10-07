/**
 * Redis adapter for short-term memory
 *
 * Uses Redis sorted sets for ordered message retrieval.
 * Supports TTL for automatic expiration.
 * Supports both standalone Redis and Redis Cluster modes via @cogitator-ai/redis.
 */

import type {
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  RedisAdapterConfig,
  MemoryProvider,
  NewMemoryEntry,
} from '@cogitator-ai/types';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import { BaseMemoryAdapter } from './base';

export class RedisAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'redis';

  private client: RedisClient | null = null;
  private config: RedisAdapterConfig;
  private prefix: string;
  private ttl: number;

  constructor(config: RedisAdapterConfig) {
    super();
    this.config = config;
    this.prefix = RedisAdapter.resolvePrefix(config);
    this.ttl = config.ttl ?? 86400;
  }

  /**
   * In cluster mode every key of the adapter must hash to the same slot (multi-key commands),
   * so the prefix must contain a `{hash tag}`.
   */
  private static resolvePrefix(config: RedisAdapterConfig): string {
    if (!config.cluster) return config.keyPrefix ?? 'cogitator:';
    const prefix = config.keyPrefix ?? '{cogitator}:';
    return /\{[^{}]*[^}]\}/.test(prefix) ? prefix : `{${prefix.replace(/:$/, '')}}:`;
  }

  private async run<T>(
    operation: (client: RedisClient) => Promise<MemoryResult<T>>
  ): Promise<MemoryResult<T>> {
    if (!this.client) return this.failure('Not connected');
    try {
      return await operation(this.client);
    } catch (err) {
      return this.failure(err instanceof Error ? err.message : String(err));
    }
  }

  async connect(): Promise<MemoryResult<void>> {
    if (this.client) return this.success(undefined);

    let client: RedisClient | undefined;
    let connectionError: Error | undefined;
    try {
      client = this.config.cluster
        ? await createRedisClient({
            mode: 'cluster',
            nodes: this.config.cluster.nodes,
            scaleReads: this.config.cluster.scaleReads,
            password: this.config.password,
          })
        : await createRedisClient({
            mode: 'standalone',
            url: this.config.url,
            host: this.config.host,
            port: this.config.port,
            password: this.config.password,
          });
      client.on('error', (error: Error) => {
        connectionError ??= error;
      });

      await client.ping();
      this.client = client;
      return this.success(undefined);
    } catch (error) {
      await client?.quit().catch(() => undefined);
      const reason = connectionError ?? error;
      return this.failure(
        `Redis connection failed: ${reason instanceof Error ? reason.message : String(reason)}`
      );
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.client) {
      try {
        await this.client.quit();
        return this.success(undefined);
      } catch (err) {
        return this.failure((err as Error).message);
      } finally {
        this.client = null;
      }
    }
    return this.success(undefined);
  }

  private key(type: string, id: string): string {
    return `${this.prefix}${type}:${id}`;
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    return this.run(async (client) => {
      const id = threadId ?? this.generateId('thread');
      const existing = await this.readThread(client, id);
      const now = new Date();
      const thread: Thread = {
        id,
        agentId,
        metadata,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await client.setex(this.key('thread', id), this.ttl, JSON.stringify(thread));
      return this.success(thread);
    });
  }

  private async readThread(client: RedisClient, threadId: string): Promise<Thread | null> {
    const data = await client.get(this.key('thread', threadId));
    if (!data) return null;

    const thread = JSON.parse(data) as Thread;
    thread.createdAt = new Date(thread.createdAt);
    thread.updatedAt = new Date(thread.updatedAt);
    return thread;
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    return this.run(async (client) => this.success(await this.readThread(client, threadId)));
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    return this.run(async (client) => {
      const thread = await this.readThread(client, threadId);
      if (!thread) return this.failure(`Thread not found: ${threadId}`);

      thread.metadata = { ...thread.metadata, ...metadata };
      thread.updatedAt = new Date();

      await client.setex(this.key('thread', threadId), this.ttl, JSON.stringify(thread));
      return this.success(thread);
    });
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      const setKey = this.key('thread:entries', threadId);
      const entryKeys = await client.zrange(setKey, 0, -1);

      if (entryKeys.length > 0) {
        await client.del(...entryKeys);
      }
      await client.del(this.key('thread', threadId), setKey);

      return this.success(undefined);
    });
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    return this.run(async (client) => {
      const full: MemoryEntry = {
        ...entry,
        id: this.generateId('entry'),
        createdAt: this.entryTimestamp(entry),
      };

      const key = this.key('entry', full.id);
      const setKey = this.key('thread:entries', entry.threadId);

      await client.setex(key, this.ttl, JSON.stringify(full));
      await client.zadd(setKey, full.createdAt.getTime(), key);
      await client.expire(setKey, this.ttl);
      await client.expire(this.key('thread', entry.threadId), this.ttl);

      return this.success(full);
    });
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    return this.run(async (client) => {
      const setKey = this.key('thread:entries', options.threadId);
      const limit = options.limit && options.limit > 0 ? options.limit : undefined;
      const ranged = Boolean(options.before || options.after);

      const read = async (): Promise<string[]> => {
        if (ranged) {
          const min = options.after ? `(${options.after.getTime()}` : '-inf';
          const max = options.before ? `(${options.before.getTime()}` : '+inf';
          return client.zrangebyscore(setKey, min, max);
        }
        return limit ? client.zrange(setKey, -limit, -1) : client.zrange(setKey, 0, -1);
      };

      let values: string[] = [];
      for (;;) {
        const keys = await read();
        if (keys.length === 0) break;
        const found = await client.mget(...keys);
        const expired = keys.filter((_key, index) => found[index] === null);
        values = found.filter((v): v is string => v !== null);
        if (expired.length === 0) break;
        await client.zrem(setKey, ...expired);
        if (ranged || !limit) break;
      }

      let entries: MemoryEntry[] = values.map((v) => {
        const entry = JSON.parse(v) as MemoryEntry;
        entry.createdAt = new Date(entry.createdAt);
        if (!options.includeToolCalls) {
          entry.toolCalls = undefined;
          entry.toolResults = undefined;
        }
        return entry;
      });

      if (limit && entries.length > limit) {
        entries = entries.slice(-limit);
      }

      return this.success(entries);
    });
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    return this.run(async (client) => {
      const data = await client.get(this.key('entry', entryId));
      if (!data) return this.success(null);

      const entry = JSON.parse(data) as MemoryEntry;
      entry.createdAt = new Date(entry.createdAt);
      return this.success(entry);
    });
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      const key = this.key('entry', entryId);
      const data = await client.get(key);
      if (data) {
        const entry = JSON.parse(data) as MemoryEntry;
        await client.zrem(this.key('thread:entries', entry.threadId), key);
        await client.del(key);
      }
      return this.success(undefined);
    });
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      const setKey = this.key('thread:entries', threadId);
      const keys = await client.zrange(setKey, 0, -1);

      if (keys.length > 0) {
        await client.del(...keys);
      }
      await client.del(setKey);

      return this.success(undefined);
    });
  }
}
