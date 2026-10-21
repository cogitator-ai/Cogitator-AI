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
  PathQueryOptions,
} from '@cogitator-ai/types';
import { createRedisClient, type RedisClient } from '@cogitator-ai/redis';
import { BranchingMemoryAdapter, entryTypeWanted } from './base';
import { CONVERSATION_ENTRY_TYPES, MEMORY_ENTRY_FORMAT } from '@cogitator-ai/types';
import { matchesListing, threadListing, threadPage, type ThreadCursor } from './thread-listing';

/**
 * The index member that records the index holds every stored thread: it lives and dies with the
 * index, so an index that expired or was evicted, and was then made again by a write, is rebuilt.
 */
const INDEX_MARKER = '';
const LUA_MARKER = JSON.stringify(INDEX_MARKER);
const SWEEP_BATCH = 20;

/**
 * How many thread lifetimes the index outlives a write by. A thread that expired stays in the
 * index until a later write sweeps it and reports it deleted, also when every thread expired.
 */
const INDEX_LIFETIMES = 7;

/**
 * Lua `sweep(index, cursorKey, prefix, ttl)`: checks the next index members, resuming the ZSCAN
 * where the last sweep stopped, and removes those whose thread expired. Every write sweeps, so the
 * index stays as big as the live threads even when nobody lists them. Returns the ids it removed,
 * which the adapter reports as deleted threads.
 */
/**
 * Lua `keep(key, ttl)` and `put(key, value, ttl)`: give a key the adapter's TTL, or no expiry
 * when the TTL is 0
 */
const LIFETIME = `
local function keep(key, ttl)
  if tonumber(ttl) > 0 then
    redis.call('EXPIRE', key, ttl)
  else
    redis.call('PERSIST', key)
  end
end
local function put(key, value, ttl)
  if tonumber(ttl) > 0 then
    redis.call('SET', key, value, 'EX', ttl)
  else
    redis.call('SET', key, value)
  end
end
`;

const SWEEP_INDEX = `${LIFETIME}
local function sweep(index, cursorKey, prefix, ttl)
  local scanned = redis.call('ZSCAN', index, redis.call('GET', cursorKey) or '0', 'COUNT', ${SWEEP_BATCH})
  local members = scanned[2]
  local removed = {}
  for i = 1, #members, 2 do
    local id = members[i]
    if id ~= ${LUA_MARKER} and redis.call('EXISTS', prefix .. 'thread:' .. id) == 0 then
      redis.call('ZREM', index, id)
      removed[#removed + 1] = id
    end
  end
  if scanned[1] == '0' then
    redis.call('DEL', cursorKey)
  else
    put(cursorKey, scanned[1], ttl)
  end
  return removed
end
`;

/** A write script's reply: whether it wrote, and the expired threads its sweep removed */
function writeReply(reply: unknown): { written: boolean; expired: string[] } {
  if (!Array.isArray(reply)) return { written: false, expired: [] };
  const [written, ...expired] = reply;
  return { written: Number(written) === 1, expired: expired.map(String) };
}

/** A stored thread or entry, read on the primary like every write, never on a lagging replica. */
const READ_KEY = `return redis.call('GET', KEYS[1])`;

/**
 * Writes a thread and its place in the thread index if the thread is still what the caller read:
 * absent when `ARGV[1]` is `'0'`, the JSON in `ARGV[2]` when it is `'1'`. The index outlives the
 * longest-living thread by {@link INDEX_LIFETIMES} lifetimes. Replies `{1, expired ids...}` when
 * written, `{0}` otherwise.
 */
const WRITE_THREAD = `${SWEEP_INDEX}
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return {0} end
elseif current then
  return {0}
end
put(KEYS[1], ARGV[3], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])
keep(KEYS[2], ARGV[4] * ${INDEX_LIFETIMES})
local expired = sweep(KEYS[2], KEYS[3], ARGV[7], ARGV[4])
return {1, unpack(expired)}
`;

/**
 * Lua helpers for trees of entries. An entry's JSON ends with its `parentId`, which
 * `withParent` sets without decoding the rest. With `legacy` set it gives an entry written before
 * trees, which has no `parentId` of its own, its first one and marks it format 1, appending both
 * whatever its last field holds. `chain` links the entries of a thread written before trees once
 * per thread, recorded by the thread's chained marker: those without a top-level `formatVersion`,
 * in the order `getEntries` read them before trees (creation time, then `seq`, then key), each
 * marked so a second chaining skips it, and makes the last one the active leaf when the thread
 * has none.
 */
const TREE = `
local function withParent(json, parent, legacy)
  local value = 'null'
  if parent then value = cjson.encode(parent) end
  local tail = ',"parentId":' .. value .. '}'
  if legacy then return string.sub(json, 1, -2) .. ',"formatVersion":1' .. tail end
  local head = string.match(json, '^(.*),"parentId":[^,]*}$')
  if head then return head .. tail end
  return string.sub(json, 1, -2) .. tail
end
local function chain(entriesKey, leafKey, chainedKey, prefix, ttl)
  if redis.call('EXISTS', chainedKey) == 1 then return end
  local scored = redis.call('ZRANGE', entriesKey, 0, -1, 'WITHSCORES')
  local legacy = {}
  for i = 1, #scored, 2 do
    local json = redis.call('GET', scored[i])
    local entry = json and cjson.decode(json)
    if entry and (entry.formatVersion == nil or entry.formatVersion == cjson.null) then
      local seq = entry.seq
      if type(seq) ~= 'number' then seq = 0 end
      legacy[#legacy + 1] = { key = scored[i], json = json, at = tonumber(scored[i + 1]), seq = seq }
    end
  end
  table.sort(legacy, function(a, b)
    if a.at ~= b.at then return a.at < b.at end
    if a.seq ~= b.seq then return a.seq < b.seq end
    return a.key < b.key
  end)
  local previous = nil
  local skip = #prefix + #'entry:'
  for i = 1, #legacy do
    redis.call('SET', legacy[i].key, withParent(legacy[i].json, previous, true), 'KEEPTTL')
    previous = string.sub(legacy[i].key, skip + 1)
  end
  if previous and redis.call('EXISTS', leafKey) == 0 then put(leafKey, previous, ttl) end
  put(chainedKey, '1', ttl)
end
`;

/**
 * Adds an entry to a thread that exists and makes it the active leaf unless `ARGV[6]` is `'0'`.
 * `ARGV[5]` says where it goes: `'leaf'` after the active leaf, `'root'` as a new root, `'entry'`
 * after the entry `ARGV[8]` of the thread. It refreshes the TTL of the thread, its entries, its
 * leaf, its chained marker and the index. Replies `{1, parent id or '', expired ids...}` when
 * added, `{0}` without the thread, `{-1}` when the parent is not in the thread.
 */
const ADD_ENTRY = `${SWEEP_INDEX}${TREE}
if redis.call('EXISTS', KEYS[1]) == 0 then return {0} end
chain(KEYS[2], KEYS[6], KEYS[7], ARGV[4], ARGV[3])
local parent = nil
if ARGV[5] == 'leaf' then
  parent = redis.call('GET', KEYS[6]) or nil
elseif ARGV[5] == 'entry' then
  if not redis.call('ZSCORE', KEYS[2], ARGV[4] .. 'entry:' .. ARGV[8]) then return {-1} end
  parent = ARGV[8]
end
put(KEYS[3], withParent(ARGV[1], parent), ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], KEYS[3])
keep(KEYS[2], ARGV[3])
keep(KEYS[1], ARGV[3])
keep(KEYS[7], ARGV[3])
if ARGV[6] == '1' then
  put(KEYS[6], ARGV[7], ARGV[3])
elseif redis.call('EXISTS', KEYS[6]) == 1 then
  keep(KEYS[6], ARGV[3])
end
local expired = {}
if redis.call('EXISTS', KEYS[4]) == 1 then
  keep(KEYS[4], ARGV[3] * ${INDEX_LIFETIMES})
  expired = sweep(KEYS[4], KEYS[5], ARGV[4], ARGV[3])
end
return {1, parent or '', unpack(expired)}
`;

/** Chains a thread's entries from before trees, then replies with its active leaf or false */
const READ_LEAF = `${LIFETIME}${TREE}
chain(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2])
return redis.call('GET', KEYS[2])
`;

/**
 * Sets the active leaf of a thread that exists to the entry `KEYS[5]` when `ARGV[3]` is `'1'`,
 * clears it otherwise. The entry must still be one of the thread's when the script runs, so a
 * checkout racing a delete never leaves the leaf on a deleted entry. Replies 1 when set, 0
 * without the thread, -1 when the entry is not in the thread.
 */
const SET_LEAF = `${LIFETIME}${TREE}
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
chain(KEYS[3], KEYS[2], KEYS[4], ARGV[1], ARGV[2])
if ARGV[3] ~= '1' then
  redis.call('DEL', KEYS[2])
  return 1
end
if not redis.call('ZSCORE', KEYS[3], KEYS[5]) or redis.call('EXISTS', KEYS[5]) == 0 then
  return -1
end
put(KEYS[2], ARGV[4], ARGV[2])
return 1
`;

/** Steps one path read walks before it hands the walk back, so a long path does not block Redis */
const PATH_STEPS = 2000;

/**
 * Walks back from the entry `ARGV[2]` of the thread `ARGV[5]` (entries `KEYS[1]`, leaf `KEYS[2]`,
 * chained marker `KEYS[3]`, which also route the script to the thread's node in a cluster),
 * keeping entries of the types in `ARGV[4]` (comma separated, `*` for all) until `ARGV[3]` are
 * kept (0 for all), for at most `ARGV[6]` steps. Replies `{next id or '', kept JSON...}`, newest
 * first.
 */
const PATH = `${LIFETIME}${TREE}
chain(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[7])
local all = ARGV[4] == '*'
local wanted = {}
for t in string.gmatch(ARGV[4], '[^,]+') do wanted[t] = true end
local limit = tonumber(ARGV[3])
local out = {''}
local kept = 0
local current = ARGV[2]
for step = 1, tonumber(ARGV[6]) do
  local json = redis.call('GET', ARGV[1] .. 'entry:' .. current)
  if not json then return out end
  local entry = cjson.decode(json)
  if entry.threadId ~= ARGV[5] then return out end
  local kind = entry.type
  if kind == nil or kind == cjson.null then kind = 'message' end
  if all or wanted[kind] then
    out[#out + 1] = json
    kept = kept + 1
    if limit > 0 and kept >= limit then return out end
  end
  local parent = entry.parentId
  if parent == nil or parent == cjson.null then return out end
  current = parent
end
out[1] = current
return out
`;

/**
 * Deletes the entry `KEYS[1]` of the thread `ARGV[4]` (entries `KEYS[2]`, leaf `KEYS[3]`, chained
 * marker `KEYS[4]`) and splices it out of its branch: its children go after its parent, and the
 * active leaf moves to the parent when it was the entry. Replies 1, 0 without the entry, -1 when
 * the entry is not the thread's.
 */
const REMOVE_ENTRY = `${LIFETIME}${TREE}
local json = redis.call('GET', KEYS[1])
if not json then return 0 end
if cjson.decode(json).threadId ~= ARGV[4] then return -1 end
chain(KEYS[2], KEYS[3], KEYS[4], ARGV[1], ARGV[2])
local parent = cjson.decode(redis.call('GET', KEYS[1])).parentId
if parent == cjson.null then parent = nil end
local suffix = ',"parentId":' .. cjson.encode(ARGV[3]) .. '}'
local members = redis.call('ZRANGE', KEYS[2], 0, -1)
for i = 1, #members do
  local child = redis.call('GET', members[i])
  if child and string.sub(child, -#suffix) == suffix then
    redis.call('SET', members[i], withParent(child, parent), 'KEEPTTL')
  end
end
if redis.call('GET', KEYS[3]) == ARGV[3] then
  if parent then put(KEYS[3], parent, ARGV[2]) else redis.call('DEL', KEYS[3]) end
end
redis.call('ZREM', KEYS[2], KEYS[1])
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Deletes the entries of a thread, their sorted set and its active leaf (`KEYS[1]`, `KEYS[2]`),
 * and with five keys its chained marker, the thread itself and its place in the thread index
 * too (`KEYS[3]` to `KEYS[5]`).
 */
const DROP_ENTRIES = `
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
for i = 1, #members, 500 do
  redis.call('DEL', unpack(members, i, math.min(i + 499, #members)))
end
redis.call('DEL', KEYS[1], KEYS[2])
if #KEYS == 5 then
  redis.call('DEL', KEYS[3], KEYS[4])
  redis.call('ZREM', KEYS[5], ARGV[1])
end
return #members
`;

/**
 * A step through the index with the stored threads, read on the primary: the members with the
 * score `ARGV[3]` (when given), then up to `ARGV[5]` members from the score bound `ARGV[4]` on, as
 * flat `id, score, thread JSON` rows. A member whose thread expired is removed and comes back
 * with no JSON, as does one whose key holds something else. The ids it removed come last.
 */
const INDEX_PAGE = `
local expired = {}
local function rows(members, withScores)
  local out = {}
  local step = withScores and 2 or 1
  for i = 1, #members, step do
    local id = members[i]
    if id ~= ${LUA_MARKER} then
      local value = redis.pcall('GET', ARGV[1] .. 'thread:' .. id)
      if value == false then
        redis.call('ZREM', KEYS[1], id)
        expired[#expired + 1] = id
      elseif type(value) ~= 'string' then
        value = false
      end
      out[#out + 1] = id
      out[#out + 1] = withScores and members[i + 1] or ARGV[3]
      out[#out + 1] = value
    end
  end
  return out
end
local tied = {}
if ARGV[3] ~= '' then
  tied = rows(redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[3], ARGV[3]), false)
end
local after
if ARGV[2] == 'desc' then
  after = redis.call('ZREVRANGEBYSCORE', KEYS[1], ARGV[4], '-inf', 'WITHSCORES', 'LIMIT', 0, ARGV[5])
else
  after = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[4], '+inf', 'WITHSCORES', 'LIMIT', 0, ARGV[5])
end
local page = rows(after, true)
return { #after / 2, tied, page, expired }
`;

/** Moves a thread in the index to the score `ARGV[2]` if the thread is still the JSON `ARGV[1]`. */
const REINDEX_THREAD = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
`;

/** Whether the index holds every stored thread: the score of its marker, or nil. */
const INDEX_STATE = `return redis.call('ZSCORE', KEYS[1], ARGV[1])`;

/** Adds `score, member` pairs to the index, leaving members it already has as they are. */
const INDEX_MISSING = `return redis.call('ZADD', KEYS[1], 'NX', unpack(ARGV))`;

/** Marks the index complete, living as long as the index after a write now. */
const MARK_INDEXED = `${LIFETIME}
redis.call('ZADD', KEYS[1], '-inf', ARGV[1])
keep(KEYS[1], ARGV[2])
return 1
`;

const MAX_WRITE_ATTEMPTS = 100;
const INDEX_BATCH = 200;

/** An index member with the thread stored under it, if there still is one. */
interface IndexRow extends ThreadCursor {
  value: string | null;
}

const SCAN_BATCH = 500;

/** Members one page of a backwards read of a thread's entries takes, at least */
const NEWEST_PAGE = 200;

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
interface StoredEntry extends Omit<
  MemoryEntry,
  'toolCalls' | 'toolResults' | 'metadata' | 'event'
> {
  toolCalls?: ToolCall[] | null;
  toolResults?: ToolResult[] | null;
  metadata?: Record<string, unknown> | null;
  event?: Record<string, unknown> | null;
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
  { toolCalls, toolResults, metadata, event, ...entry }: StoredEntry,
  withToolCalls: boolean
): MemoryEntry {
  return {
    ...entry,
    ...(withToolCalls && toolCalls != null && { toolCalls }),
    ...(withToolCalls && toolResults != null && { toolResults }),
    ...(metadata != null && { metadata }),
    ...(event != null && { event }),
    type: entry.type ?? 'message',
    parentId: entry.parentId ?? null,
    formatVersion: entry.formatVersion ?? 1,
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

function indexRows(reply: unknown): IndexRow[] {
  if (!Array.isArray(reply)) throw new Error('Unexpected reply from Redis');
  const rows: IndexRow[] = [];
  for (let i = 0; i + 2 < reply.length; i += 3) {
    const [id, score, value]: unknown[] = reply.slice(i, i + 3);
    if (typeof id !== 'string' || typeof score !== 'string') {
      throw new Error('Unexpected reply from Redis');
    }
    rows.push({ id, updatedAt: Number(score), value: typeof value === 'string' ? value : null });
  }
  return rows;
}

function indexPage(reply: unknown): {
  tied: IndexRow[];
  after: IndexRow[];
  read: number;
  expired: string[];
} {
  if (
    !Array.isArray(reply) ||
    reply.length !== 4 ||
    typeof reply[0] !== 'number' ||
    !Array.isArray(reply[3])
  ) {
    throw new Error('Unexpected reply from Redis');
  }
  return {
    read: reply[0],
    tied: indexRows(reply[1]),
    after: indexRows(reply[2]),
    expired: reply[3].map(String),
  };
}

export class RedisAdapter extends BranchingMemoryAdapter {
  readonly provider: MemoryProvider = 'redis';

  private client: RedisClient | null = null;
  private config: RedisAdapterConfig;
  private prefix: string;
  private ttl: number;

  constructor(config: RedisAdapterConfig) {
    super();
    this.config = config;
    this.prefix = RedisAdapter.resolvePrefix(config);
    this.ttl = config.ttl ?? 0;
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

  /** The keys every tree script of a thread takes: its entries, its leaf, its chained marker */
  private treeKeys(threadId: string): [string, string, string] {
    return [
      this.key('thread:entries', threadId),
      this.key('thread:leaf', threadId),
      this.key('thread:chained', threadId),
    ];
  }

  /** Thread ids scored by `updatedAt` in ms, kept with the threads by every thread write. */
  private get indexKey(): string {
    return `${this.prefix}threads:index`;
  }

  /** Where the next sweep of the index for expired threads goes on. */
  private get sweepKey(): string {
    return `${this.prefix}threads:sweep`;
  }

  /** Threads that expired, found by the index, reported as deleted */
  private reportExpired(threadIds: string[]): void {
    for (const threadId of threadIds) this.report({ type: 'thread-deleted', threadId });
  }

  /** Entries that expired inside a thread that lives on, by their keys, reported as deleted */
  private reportExpiredEntries(keys: string[]): void {
    const prefix = this.key('entry', '');
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        this.report({ type: 'entry-deleted', entryId: key.slice(prefix.length) });
      }
    }
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
      const read = await client.eval(READ_KEY, 1, threadKey);
      const current = typeof read === 'string' ? read : null;
      const thread = next(current === null ? null : (parseThread(current) ?? null));
      if (!thread) return null;
      const json = JSON.stringify(thread);
      const reply = await client.eval(
        WRITE_THREAD,
        3,
        threadKey,
        this.indexKey,
        this.sweepKey,
        current === null ? '0' : '1',
        current ?? '',
        json,
        this.ttl,
        thread.updatedAt.getTime(),
        threadId,
        this.prefix
      );
      const { written, expired } = writeReply(reply);
      this.reportExpired(expired);
      if (written) return parseThread(json) ?? null;
    }
    throw new Error(`Thread ${threadId} changed on every one of ${MAX_WRITE_ATTEMPTS} attempts`);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    const idProblem = this.threadIdProblem(threadId);
    if (idProblem) return this.failure(idProblem);
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
    const thread = data === null ? undefined : parseThread(data);
    if (!thread) return null;
    const leaf = await client.eval(READ_LEAF, 3, ...this.treeKeys(threadId), this.prefix, this.ttl);
    return typeof leaf === 'string' ? { ...thread, activeLeafId: leaf } : thread;
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
    return this.reported(await this.dropThread(threadId), () => ({
      type: 'thread-deleted',
      threadId,
    }));
  }

  private async dropThread(threadId: string): Promise<MemoryResult<void>> {
    if (threadId === '') return this.success(undefined);
    return this.run(async (client) => {
      await client.eval(
        DROP_ENTRIES,
        5,
        ...this.treeKeys(threadId),
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
        const { rows, exhausted } = await this.indexAfter(client, listing.order, position, batch);
        for (const row of rows) {
          position = row;
          if (row.value === null) continue;
          const thread = parseThread(row.value);
          if (!thread) continue;
          if (thread.updatedAt.getTime() !== row.updatedAt) {
            await client.eval(
              REINDEX_THREAD,
              2,
              this.key('thread', row.id),
              this.indexKey,
              row.value,
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
   * The index members after `position` in `order` with their threads: those sharing its score
   * with a later id, then up to `batch` with a later score. `exhausted` when the index has no
   * more beyond them.
   */
  private async indexAfter(
    client: RedisClient,
    order: 'asc' | 'desc',
    position: ThreadCursor | undefined,
    batch: number
  ): Promise<{ rows: IndexRow[]; exhausted: boolean }> {
    const start = position ? `(${position.updatedAt}` : order === 'desc' ? '+inf' : '-inf';
    const { tied, after, read, expired } = indexPage(
      await client.eval(
        INDEX_PAGE,
        1,
        this.indexKey,
        this.prefix,
        order,
        position ? position.updatedAt : '',
        start,
        batch
      )
    );
    this.reportExpired(expired);
    const sign = order === 'asc' ? 1 : -1;
    const later = position
      ? tied
          .filter((row) => sign * compareMembers(row.id, position.id) > 0)
          .sort((a, b) => sign * compareMembers(a.id, b.id))
      : [];
    return { rows: [...later, ...after], exhausted: read < batch };
  }

  /**
   * Rebuilds the index from the stored threads when it does not hold them all: before the first
   * listing of a prefix, and after the index expired or was evicted. Threads an older version of
   * the adapter creates once the index is complete stay unlisted until it is rebuilt, threads it
   * updates move to their place when a listing meets them.
   */
  private async ensureIndexed(client: RedisClient): Promise<void> {
    if ((await client.eval(INDEX_STATE, 1, this.indexKey, INDEX_MARKER)) !== null) return;
    const pattern = `${escapeGlob(this.prefix)}thread:*`;
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
      cursor = next;
      if (keys.length > 0) await this.indexStored(client, keys);
    } while (cursor !== '0');
    await client.eval(MARK_INDEXED, 1, this.indexKey, INDEX_MARKER, this.ttl * INDEX_LIFETIMES);
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
    return this.reported(await this.storeEntry(entry), (stored) => ({
      type: 'entry-added',
      entry: stored,
    }));
  }

  private async storeEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    return this.run(async (client) => {
      const id = this.generateId('entry');
      const createdAt = this.entryTimestamp(entry);
      const seq = await client.incr(`${this.prefix}entries:seq`);
      const { activate, parentId: askedParent, ...fields } = entry;
      const type = fields.type ?? (fields.message?.role === 'tool' ? 'tool_result' : 'message');
      const stored = {
        ...fields,
        id,
        createdAt,
        seq,
        type,
        formatVersion: MEMORY_ENTRY_FORMAT,
      } satisfies StoredEntry;

      const [entriesKey, leafKey, chainedKey] = this.treeKeys(entry.threadId);
      const reply = await client.eval(
        ADD_ENTRY,
        7,
        this.key('thread', entry.threadId),
        entriesKey,
        this.key('entry', id),
        this.indexKey,
        this.sweepKey,
        leafKey,
        chainedKey,
        JSON.stringify(stored),
        createdAt.getTime(),
        this.ttl,
        this.prefix,
        askedParent === undefined ? 'leaf' : askedParent === null ? 'root' : 'entry',
        activate === false ? '0' : '1',
        id,
        askedParent ?? ''
      );
      if (!Array.isArray(reply)) throw new Error('Unexpected reply from Redis');
      const [status, parent, ...expired] = reply;
      if (Number(status) === -1) {
        return this.failure(`Parent entry ${askedParent} is not in thread ${entry.threadId}`);
      }
      this.reportExpired(expired.map(String));
      if (Number(status) !== 1) return this.failure(`Thread not found: ${entry.threadId}`);

      return this.success(readEntry({ ...stored, parentId: parent ? String(parent) : null }, true));
    });
  }

  /** The path walked back from its start by a script, a bounded number of steps at a time */
  override async getPath(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    const start = await this.pathStart(options);
    if (!start.success) return start;
    if (start.data === null) return this.success([]);
    const types =
      options.types === 'all' ? '*' : (options.types ?? CONVERSATION_ENTRY_TYPES).join(',');

    return this.run(async (client) => {
      const found: MemoryEntry[] = [];
      let next: string = start.data!;
      while (next) {
        const left = options.limit ? options.limit - found.length : 0;
        const reply = await client.eval(
          PATH,
          3,
          ...this.treeKeys(options.threadId),
          this.prefix,
          next,
          left,
          types,
          options.threadId,
          PATH_STEPS,
          this.ttl
        );
        if (!Array.isArray(reply)) throw new Error('Unexpected reply from Redis');
        const [continuation, ...rows] = reply.map(String);
        for (const row of rows) {
          found.push(readEntry(parseEntry(row), options.includeToolCalls === true));
        }
        if (options.limit && found.length >= options.limit) break;
        next = continuation ?? '';
      }
      return this.success(found.reverse());
    });
  }

  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    return this.run(async (client) => {
      const [entriesKey, leafKey, chainedKey] = this.treeKeys(threadId);
      const set = Number(
        await client.eval(
          SET_LEAF,
          5,
          this.key('thread', threadId),
          leafKey,
          entriesKey,
          chainedKey,
          this.key('entry', leafId ?? ''),
          this.prefix,
          this.ttl,
          leafId === null ? '0' : '1',
          leafId ?? ''
        )
      );
      if (set === -1) return this.failure(`Entry ${leafId} is not in thread ${threadId}`);
      if (set !== 1) return this.failure(`Thread not found: ${threadId}`);
      const thread = await this.readThread(client, threadId);
      return thread ? this.success(thread) : this.failure(`Thread not found: ${threadId}`);
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
        this.reportExpiredEntries(expired);
        if (ranged || !limit) break;
      }

      let entries = values.map(parseEntry);
      const wanted = (list: StoredEntry[]) =>
        list.filter((entry) => entryTypeWanted(entry.type, options.types));
      if (limit && !ranged && wanted(entries).length < limit && keys.length >= limit) {
        entries = await this.newestWanted(client, setKey, limit, wanted, keys, entries);
      } else if (limit && !ranged && entries.length === limit) {
        entries = await this.withEarlierTies(client, setKey, keys, entries);
      }
      entries = wanted(entries);
      entries.sort(byCreation);
      if (limit && entries.length > limit) entries = entries.slice(-limit);

      return this.success(
        entries.map((entry) => readEntry(entry, options.includeToolCalls === true))
      );
    });
  }

  /**
   * The newest `limit` entries `wanted` keeps, when the last members already read (`keys`, their
   * `entries`) hold too few: reads on backwards a page of members at a time until it has enough or
   * the thread ends, so entries of other types among the newest never make it read a long thread
   * whole. Members whose entry expired are removed at the end, so pages keep their places.
   */
  private async newestWanted(
    client: RedisClient,
    setKey: string,
    limit: number,
    wanted: (list: StoredEntry[]) => StoredEntry[],
    keys: string[],
    entries: StoredEntry[]
  ): Promise<StoredEntry[]> {
    const read = [...keys];
    const found = wanted(entries);
    const expired: string[] = [];
    const page = Math.max(limit, NEWEST_PAGE);
    let offset = keys.length;
    while (found.length < limit) {
      const chunk = await client.zrange(setKey, -(offset + page), -(offset + 1));
      if (chunk.length === 0) break;
      const values = await client.mget(...chunk);
      const live: StoredEntry[] = [];
      for (const [index, key] of chunk.entries()) {
        const value = values[index];
        if (value == null) {
          expired.push(key);
        } else {
          read.push(key);
          live.push(parseEntry(value));
        }
      }
      found.push(...wanted(live));
      offset += chunk.length;
      if (chunk.length < page) break;
    }
    if (expired.length > 0) {
      await client.zrem(setKey, ...expired);
      this.reportExpiredEntries(expired);
    }
    return found.length > 0 ? this.withEarlierTies(client, setKey, read, found) : [];
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
    return this.reported(await this.removeEntry(entryId), () => ({
      type: 'entry-deleted',
      entryId,
    }));
  }

  /**
   * Deletes an entry and splices it out of its branch: its children go after its parent. The
   * entry is read first to learn its thread, whose keys the script then names.
   */
  private async removeEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      const entryKey = this.key('entry', entryId);
      const json = await client.eval(READ_KEY, 1, entryKey);
      if (typeof json !== 'string') return this.success(undefined);
      const { threadId } = parseEntry(json);
      const removed = await client.eval(
        REMOVE_ENTRY,
        4,
        entryKey,
        ...this.treeKeys(threadId),
        this.prefix,
        this.ttl,
        entryId,
        threadId
      );
      return Number(removed) === -1
        ? this.failure(`Entry ${entryId} is not in thread ${threadId}`)
        : this.success(undefined);
    });
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.emptyThread(threadId), () => ({
      type: 'thread-cleared',
      threadId,
    }));
  }

  private async emptyThread(threadId: string): Promise<MemoryResult<void>> {
    return this.run(async (client) => {
      await client.eval(
        DROP_ENTRIES,
        2,
        this.key('thread:entries', threadId),
        this.key('thread:leaf', threadId)
      );
      return this.success(undefined);
    });
  }
}
