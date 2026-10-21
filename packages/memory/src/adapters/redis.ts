/**
 * Redis adapter for short-term memory
 *
 * Uses Redis sorted sets for ordered message retrieval.
 * Supports TTL for automatic expiration.
 * Supports both standalone Redis and Redis Cluster modes via @cogitator-ai/redis.
 */

import type {
  ListThreadsOptions,
  Thread,
  ThreadPage,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  RedisAdapterConfig,
  MemoryProvider,
  NewMemoryEntry,
  ToolCall,
  ToolResult,
} from '@cogitator-ai/types';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import { BaseMemoryAdapter } from './base';
import { matchesListing, threadListing, threadPage, type ThreadCursor } from './thread-listing';

/**
 * Writes a thread and its place in the thread index if the thread is still what the caller read:
 * absent when `ARGV[1]` is `'0'`, the JSON in `ARGV[2]` when it is `'1'`. Returns 1 when written.
 */
const WRITE_THREAD = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return 0 end
elseif current then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])
return 1
`;

/** Adds an entry to a thread that exists, refreshing the TTL of both. Returns 1 when added. */
const ADD_ENTRY = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], KEYS[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

/**
 * Deletes the entries of a thread and their sorted set, and with three keys the thread itself
 * and its place in the thread index too.
 */
const DROP_ENTRIES = `
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
for i = 1, #members, 500 do
  redis.call('DEL', unpack(members, i, math.min(i + 499, #members)))
end
redis.call('DEL', KEYS[1])
if #KEYS == 3 then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
end
return #members
`;

/** Up to `ARGV[3]` index members with their scores, from the score bound `ARGV[2]` on. */
const RANGE_INDEX = `
if ARGV[1] == 'desc' then
  return redis.call('ZREVRANGEBYSCORE', KEYS[1], ARGV[2], '-inf', 'WITHSCORES', 'LIMIT', 0, ARGV[3])
end
return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[2], '+inf', 'WITHSCORES', 'LIMIT', 0, ARGV[3])
`;

/** Removes the index members (`ARGV`) whose thread keys (`KEYS[2..]`) no longer exist. */
const DROP_EXPIRED = `
local removed = 0
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    removed = removed + redis.call('ZREM', KEYS[1], ARGV[i - 1])
  end
end
return removed
`;

/** Moves a thread in the index to the score `ARGV[2]` if the thread is still the JSON `ARGV[1]`. */
const REINDEX_THREAD = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
`;

/** Adds `score, member` pairs to the index, leaving members it already has as they are. */
const INDEX_MISSING = `return redis.call('ZADD', KEYS[1], 'NX', unpack(ARGV))`;

const MAX_WRITE_ATTEMPTS = 100;
const INDEX_BATCH = 200;
const SCAN_BATCH = 500;

interface StoredThread {
  id: string;
  agentId: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An entry as stored: `seq` orders entries created in the same millisecond by when they were
 * added. Entries written by earlier versions have no `seq`.
 */
interface StoredEntry extends Omit<MemoryEntry, 'toolCalls' | 'toolResults' | 'metadata'> {
  toolCalls?: ToolCall[] | null;
  toolResults?: ToolResult[] | null;
  metadata?: Record<string, unknown> | null;
  seq?: number;
}

function isStoredThread(value: unknown): value is StoredThread {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'agentId' in value &&
    typeof value.agentId === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'string' &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string'
  );
}

function parseThread(data: string): Thread | undefined {
  const value: unknown = JSON.parse(data);
  if (!isStoredThread(value)) return undefined;
  return {
    id: value.id,
    agentId: value.agentId,
    metadata: value.metadata ?? {},
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function parseEntry(data: string): StoredEntry {
  const entry = JSON.parse(data) as StoredEntry;
  entry.createdAt = new Date(entry.createdAt);
  return entry;
}

function readEntry(
  { seq: _seq, toolCalls, toolResults, metadata, ...entry }: StoredEntry,
  withToolCalls: boolean
): MemoryEntry {
  return {
    ...entry,
    ...(withToolCalls && toolCalls != null && { toolCalls }),
    ...(withToolCalls && toolResults != null && { toolResults }),
    ...(metadata != null && { metadata }),
  };
}

function byCreation(a: StoredEntry, b: StoredEntry): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.seq ?? 0) - (b.seq ?? 0);
}

/** Orders ids as Redis orders the members of a sorted set with one score: by their UTF-8 bytes. */
function compareMembers(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&');
}

function stringReply(reply: unknown): string[] {
  if (Array.isArray(reply) && reply.every((item) => typeof item === 'string')) return reply;
  throw new Error('Unexpected reply from Redis');
}

export class RedisAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'redis';

  private client: RedisClient | null = null;
  private config: RedisAdapterConfig;
  private prefix: string;
  private ttl: number;
  private indexed = false;

  constructor(config: RedisAdapterConfig) {
    super();
    this.config = config;
    this.prefix = RedisAdapter.resolvePrefix(config);
    this.ttl = config.ttl ?? 86400;
  }

  /**
   * In cluster mode every key of the adapter must hash to the same slot (multi-key commands and
   * scripts), so the prefix must contain a `{hash tag}`.
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

  /** Thread ids scored by `updatedAt` in ms, kept with the threads by every thread write. */
  private get indexKey(): string {
    return `${this.prefix}threads:index`;
  }

  /**
   * Writes the thread `next` makes of the stored one, retrying when another writer changed it in
   * between, so concurrent writes all land. Returns null, writing nothing, when `next` does.
   */
  private async writeThread(
    client: RedisClient,
    threadId: string,
    next: (current: Thread | null) => Thread | null
  ): Promise<Thread | null> {
    const threadKey = this.key('thread', threadId);
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const current = await client.get(threadKey);
      const thread = next(current === null ? null : (parseThread(current) ?? null));
      if (!thread) return null;
      const json = JSON.stringify(thread);
      const written = await client.eval(
        WRITE_THREAD,
        2,
        threadKey,
        this.indexKey,
        current === null ? '0' : '1',
        current ?? '',
        json,
        this.ttl,
        thread.updatedAt.getTime(),
        threadId
      );
      if (written === 1) return parseThread(json) ?? null;
    }
    throw new Error(`Thread ${threadId} changed on every one of ${MAX_WRITE_ATTEMPTS} attempts`);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    return this.run(async (client) => {
      const id = threadId ?? this.generateId('thread');
      const thread = await this.writeThread(client, id, (existing) => {
        const now = new Date();
        return { id, agentId, metadata, createdAt: existing?.createdAt ?? now, updatedAt: now };
      });
      return thread ? this.success(thread) : this.failure(`Thread could not be created: ${id}`);
    });
  }

  private async readThread(client: RedisClient, threadId: string): Promise<Thread | null> {
    const data = await client.get(this.key('thread', threadId));
    return data === null ? null : (parseThread(data) ?? null);
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    return this.run(async (client) => this.success(await this.readThread(client, threadId)));
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    return this.run(async (client) => {
      const thread = await this.writeThread(client, threadId, (current) =>
        current
          ? { ...current, metadata: { ...current.metadata, ...metadata }, updatedAt: new Date() }
          : null
      );
      return thread ? this.success(thread) : this.failure(`Thread not found: ${threadId}`);
    });
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      await client.eval(
        DROP_ENTRIES,
        3,
        this.key('thread:entries', threadId),
        this.key('thread', threadId),
        this.indexKey,
        threadId
      );
      return this.success(undefined);
    });
  }

  async listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>> {
    const listing = threadListing(options);
    if (typeof listing === 'string') return this.failure(listing);

    return this.run(async (client) => {
      await this.ensureIndexed(client);
      const batch = Math.max(listing.limit + 1, INDEX_BATCH);
      const found: Thread[] = [];
      let position = listing.cursor;

      for (;;) {
        const { members, exhausted } = await this.indexAfter(
          client,
          listing.order,
          position,
          batch
        );
        if (members.length === 0) break;

        const keys = members.map((member) => this.key('thread', member.id));
        const values = await client.mget(...keys);
        const expired = members.filter((_member, index) => values[index] === null);
        if (expired.length > 0) {
          await client.eval(
            DROP_EXPIRED,
            expired.length + 1,
            this.indexKey,
            ...expired.map((member) => this.key('thread', member.id)),
            ...expired.map((member) => member.id)
          );
        }

        for (const [index, member] of members.entries()) {
          position = member;
          const value = values[index];
          if (value === null || value === undefined) continue;
          const thread = parseThread(value);
          if (!thread) continue;
          if (thread.updatedAt.getTime() !== member.updatedAt) {
            await client.eval(
              REINDEX_THREAD,
              2,
              keys[index],
              this.indexKey,
              value,
              thread.updatedAt.getTime(),
              thread.id
            );
            continue;
          }
          if (!matchesListing(thread, listing)) continue;
          found.push(thread);
          if (found.length > listing.limit) return this.success(threadPage(found, listing));
        }
        if (exhausted) break;
      }

      return this.success(threadPage(found, listing));
    });
  }

  /**
   * The index members after `position` in `order`: those sharing its score with a later id, then
   * up to `batch` with a later score. `exhausted` when the index has no more beyond them.
   */
  private async indexAfter(
    client: RedisClient,
    order: 'asc' | 'desc',
    position: ThreadCursor | undefined,
    batch: number
  ): Promise<{ members: ThreadCursor[]; exhausted: boolean }> {
    const members: ThreadCursor[] = [];
    if (position) {
      const sign = order === 'asc' ? 1 : -1;
      const tied = await client.zrangebyscore(
        this.indexKey,
        position.updatedAt,
        position.updatedAt
      );
      const later = tied
        .filter((id) => sign * compareMembers(id, position.id) > 0)
        .sort((a, b) => sign * compareMembers(a, b));
      members.push(...later.map((id) => ({ id, updatedAt: position.updatedAt })));
    }

    const start = position ? `(${position.updatedAt}` : order === 'desc' ? '+inf' : '-inf';
    const reply = stringReply(
      await client.eval(RANGE_INDEX, 1, this.indexKey, order, start, batch)
    );
    for (let i = 0; i + 1 < reply.length; i += 2) {
      members.push({ id: reply[i], updatedAt: Number(reply[i + 1]) });
    }
    return { members, exhausted: reply.length / 2 < batch };
  }

  /**
   * Indexes threads stored before the thread index existed, once per key prefix: a marker key
   * records that it was done.
   */
  private async ensureIndexed(client: RedisClient): Promise<void> {
    if (this.indexed) return;
    const marker = `${this.prefix}threads:indexed`;
    if ((await client.exists(marker)) === 0) {
      const pattern = `${escapeGlob(this.prefix)}thread:*`;
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
        cursor = next;
        if (keys.length > 0) await this.indexStored(client, keys);
      } while (cursor !== '0');
      await client.set(marker, '1');
    }
    this.indexed = true;
  }

  private async indexStored(client: RedisClient, keys: string[]): Promise<void> {
    const values = await client.mget(...keys);
    const pairs: (string | number)[] = [];
    for (const [index, value] of values.entries()) {
      if (value === null) continue;
      let thread: Thread | undefined;
      try {
        thread = parseThread(value);
      } catch {
        continue;
      }
      if (thread && keys[index] === this.key('thread', thread.id)) {
        pairs.push(thread.updatedAt.getTime(), thread.id);
      }
    }
    for (let i = 0; i < pairs.length; i += 2 * SCAN_BATCH) {
      await client.eval(INDEX_MISSING, 1, this.indexKey, ...pairs.slice(i, i + 2 * SCAN_BATCH));
    }
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    return this.run(async (client) => {
      const id = this.generateId('entry');
      const createdAt = this.entryTimestamp(entry);
      const seq = await client.incr(`${this.prefix}entries:seq`);
      const json = JSON.stringify({ ...entry, id, createdAt, seq } satisfies StoredEntry);

      const added = await client.eval(
        ADD_ENTRY,
        3,
        this.key('thread', entry.threadId),
        this.key('thread:entries', entry.threadId),
        this.key('entry', id),
        json,
        createdAt.getTime(),
        this.ttl
      );
      if (added !== 1) return this.failure(`Thread not found: ${entry.threadId}`);

      return this.success(readEntry(parseEntry(json), true));
    });
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);

    return this.run(async (client) => {
      const setKey = this.key('thread:entries', options.threadId);
      const limit = options.limit || undefined;
      const ranged = Boolean(options.before || options.after);

      const read = async (): Promise<string[]> => {
        if (ranged) {
          const min = options.after ? `(${options.after.getTime()}` : '-inf';
          const max = options.before ? `(${options.before.getTime()}` : '+inf';
          return client.zrangebyscore(setKey, min, max);
        }
        return limit ? client.zrange(setKey, -limit, -1) : client.zrange(setKey, 0, -1);
      };

      let keys: string[];
      let values: string[] = [];
      for (;;) {
        keys = await read();
        if (keys.length === 0) break;
        const found = await client.mget(...keys);
        const expired = keys.filter((_key, index) => found[index] === null);
        values = found.filter((v): v is string => v !== null);
        keys = keys.filter((_key, index) => found[index] !== null);
        if (expired.length === 0) break;
        await client.zrem(setKey, ...expired);
        if (ranged || !limit) break;
      }

      let entries = values.map(parseEntry);
      if (limit && !ranged && entries.length === limit) {
        entries = await this.withEarlierTies(client, setKey, keys, entries);
      }
      entries.sort(byCreation);
      if (limit && entries.length > limit) entries = entries.slice(-limit);

      return this.success(
        entries.map((entry) => readEntry(entry, options.includeToolCalls === true))
      );
    });
  }

  /**
   * The newest entries a limit reads are the last members of the sorted set, where members with
   * one score are in id order, not in the order they were added. This adds the entries that share
   * the oldest score read but fell before the window, so sorting by `seq` can pick the right ones.
   */
  private async withEarlierTies(
    client: RedisClient,
    setKey: string,
    keys: string[],
    entries: StoredEntry[]
  ): Promise<StoredEntry[]> {
    const oldest = Math.min(...entries.map((entry) => entry.createdAt.getTime()));
    const known = new Set(keys);
    const missing = (await client.zrangebyscore(setKey, oldest, oldest)).filter(
      (key) => !known.has(key)
    );
    if (missing.length === 0) return entries;
    const found = await client.mget(...missing);
    return [...entries, ...found.filter((v): v is string => v !== null).map(parseEntry)];
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    return this.run(async (client) => {
      const data = await client.get(this.key('entry', entryId));
      return this.success(data === null ? null : readEntry(parseEntry(data), true));
    });
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      const key = this.key('entry', entryId);
      const data = await client.get(key);
      if (data) {
        const entry = parseEntry(data);
        await client.zrem(this.key('thread:entries', entry.threadId), key);
        await client.del(key);
      }
      return this.success(undefined);
    });
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      await client.eval(DROP_ENTRIES, 1, this.key('thread:entries', threadId));
      return this.success(undefined);
    });
  }
}
