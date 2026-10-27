import type {
  DurableRunFilter,
  DurableRunHolder,
  DurableRunLease,
  DurableRunMark,
  DurableRunRecord,
  DurableRunRef,
  DurableRunStore,
  DurableRunSummary,
  MemoryAdapter,
  Message,
  Thread,
} from '@cogitator-ai/types';

/** The part of a durable record a store keeps apart from its base, journal and lease */
type StoredRecord = Omit<DurableRunRecord, 'base' | 'journal' | 'lease'>;

/** A lease as the in-process stores keep it */
type HeldLease = Required<DurableRunLease>;

function summaryOf(record: StoredRecord, lease: DurableRunLease | undefined): DurableRunSummary {
  return {
    runId: record.runId,
    threadId: record.threadId,
    agentId: record.agentId,
    agentName: record.agentName,
    ...(record.userId !== undefined && { userId: record.userId }),
    iterations: record.checkpoint.iterations,
    startedAt: record.checkpoint.startedAt,
    savedAt: record.savedAt,
    ...(lease && { lease }),
  };
}

function matches(summary: DurableRunSummary, filter: DurableRunFilter | undefined): boolean {
  if (!filter) return true;
  return (
    (filter.runId === undefined || summary.runId === filter.runId) &&
    (filter.threadId === undefined || summary.threadId === filter.threadId) &&
    (filter.agentId === undefined || summary.agentId === filter.agentId) &&
    (filter.userId === undefined || summary.userId === filter.userId)
  );
}

function storedPart(record: DurableRunRecord): StoredRecord {
  const { base: _base, baseFrom: _baseFrom, journal: _journal, lease: _lease, ...stored } = record;
  return stored;
}

/** The base a save leaves: the one kept, replaced by `record.base` or added to from `baseFrom` */
function nextBase(kept: readonly Message[], record: DurableRunRecord): Message[] {
  if (!record.base) return [...kept];
  if (record.baseFrom === undefined) return [...record.base];
  return [...kept.slice(0, record.baseFrom), ...record.base];
}

function positiveMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`A durable run lease must last a positive number of ms, got ${ttlMs}`);
  }
  return Math.ceil(ttlMs);
}

/** Whether `lease`, live at `now`, lets `holder` take the run */
function mayTake(
  lease: HeldLease | undefined,
  holder: DurableRunHolder,
  replacing: string | undefined
): boolean {
  return !lease || lease.instance === holder.instance || lease.instance === replacing;
}

/** The epoch a lease taken by `holder` gets: the live one's when its instance renews it, else one more than `last` */
function nextEpoch(
  live: HeldLease | undefined,
  holder: DurableRunHolder,
  last: number,
  above = 0
): number {
  return live?.instance === holder.instance ? live.epoch : Math.max(last, above) + 1;
}

function isHeldBy(lease: HeldLease | undefined, holder: DurableRunHolder): boolean {
  return lease?.instance === holder.instance && lease.owner === holder.owner;
}

interface KeptRun {
  record: StoredRecord;
  base: Message[];
  journal: DurableRunMark[];
}

/**
 * Durable runs in process memory: lost with the process, so they survive only a runtime that
 * stops while the process goes on (tests, several runtimes in one process). Its leases are
 * atomic, so runtimes sharing one store never hold a run at once.
 */
export class InMemoryDurableRunStore implements DurableRunStore {
  private readonly runs = new Map<string, KeptRun>();
  private readonly leases = new Map<string, HeldLease>();
  /** The last lease epoch of each run, kept while its lease comes and goes */
  private readonly epochs = new Map<string, number>();
  private readonly now: () => number;

  /** @param options.now the clock leases run out by, `Date.now` by default */
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async acquire(
    ref: DurableRunRef,
    holder: DurableRunHolder,
    ttlMs: number,
    options: { replacing?: string; above?: number } = {}
  ): Promise<number | false> {
    const ttl = positiveMs(ttlMs);
    const live = this.liveLease(ref.runId);
    if (!mayTake(live, holder, options.replacing)) return false;
    const epoch = nextEpoch(live, holder, this.epochs.get(ref.runId) ?? 0, options.above);
    this.epochs.set(ref.runId, epoch);
    this.leases.set(ref.runId, { ...holder, expiresAt: this.now() + ttl, epoch });
    return epoch;
  }

  async renew(ref: DurableRunRef, holder: DurableRunHolder, ttlMs: number): Promise<boolean> {
    const ttl = positiveMs(ttlMs);
    const held = this.liveLease(ref.runId);
    if (!held || !isHeldBy(held, holder)) return false;
    held.expiresAt = this.now() + ttl;
    return true;
  }

  async release(ref: DurableRunRef, holder: DurableRunHolder): Promise<void> {
    if (isHeldBy(this.leases.get(ref.runId), holder)) this.leases.delete(ref.runId);
  }

  async save(record: DurableRunRecord, holder: DurableRunHolder): Promise<boolean> {
    if (!isHeldBy(this.liveLease(record.runId), holder)) return false;
    const kept = this.runs.get(record.runId);
    this.runs.set(record.runId, {
      record: structuredClone(storedPart(record)),
      base: structuredClone(nextBase(kept?.base ?? [], record)),
      journal: structuredClone(record.journal),
    });
    return true;
  }

  async append(
    ref: DurableRunRef,
    marks: readonly DurableRunMark[],
    holder: DurableRunHolder
  ): Promise<boolean> {
    const kept = this.runs.get(ref.runId);
    if (!kept || !isHeldBy(this.liveLease(ref.runId), holder)) return false;
    kept.journal.push(...structuredClone([...marks]));
    return true;
  }

  async load(ref: DurableRunRef): Promise<DurableRunRecord | null> {
    const kept = this.runs.get(ref.runId);
    if (!kept) return null;
    const lease = this.liveLease(ref.runId);
    return {
      ...structuredClone(kept.record),
      base: structuredClone(kept.base),
      journal: structuredClone(kept.journal),
      ...(lease && { lease: { ...lease } }),
    };
  }

  async list(filter?: DurableRunFilter): Promise<DurableRunSummary[]> {
    return [...this.runs.values()]
      .map((kept) => {
        const lease = this.liveLease(kept.record.runId);
        return summaryOf(kept.record, lease && { ...lease });
      })
      .filter((summary) => matches(summary, filter));
  }

  async delete(ref: DurableRunRef, holder?: DurableRunHolder): Promise<boolean> {
    if (holder && !isHeldBy(this.liveLease(ref.runId), holder)) return false;
    this.runs.delete(ref.runId);
    this.leases.delete(ref.runId);
    this.epochs.delete(ref.runId);
    return true;
  }

  private liveLease(runId: string): HeldLease | undefined {
    const lease = this.leases.get(runId);
    if (!lease) return undefined;
    if (lease.expiresAt > this.now()) return lease;
    this.leases.delete(runId);
    return undefined;
  }
}

const FLAG = 'cogitatorDurableRuns';
const RUNS = 'durableRuns';
const THREAD_PAGE = 500;

/**
 * A durable run as a thread's metadata keeps it, under `durableRuns` by run id. A run that took
 * its lease before its first checkpoint has no `kept` yet
 */
interface ThreadEntry {
  kept?: KeptRun;
  lease?: HeldLease;
  /** The last lease epoch, kept while the lease comes and goes */
  epoch?: number;
}

function isLease(value: unknown): value is HeldLease {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { owner?: unknown }).owner === 'string' &&
    typeof (value as { instance?: unknown }).instance === 'string' &&
    typeof (value as { expiresAt?: unknown }).expiresAt === 'number' &&
    typeof (value as { epoch?: unknown }).epoch === 'number'
  );
}

function isKept(value: unknown): value is KeptRun {
  if (typeof value !== 'object' || value === null) return false;
  const record = (value as { record?: unknown }).record;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof (record as { runId?: unknown }).runId === 'string' &&
    Array.isArray((value as { base?: unknown }).base) &&
    Array.isArray((value as { journal?: unknown }).journal)
  );
}

function entriesOf(thread: Thread | null): Map<string, ThreadEntry> {
  const entries = new Map<string, ThreadEntry>();
  const runs = thread?.metadata[RUNS];
  if (typeof runs !== 'object' || runs === null || Array.isArray(runs)) return entries;
  for (const [runId, value] of Object.entries(runs as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const kept: unknown = (value as { kept?: unknown }).kept;
    const lease: unknown = (value as { lease?: unknown }).lease;
    const epoch: unknown = (value as { epoch?: unknown }).epoch;
    entries.set(runId, {
      ...(isKept(kept) && { kept }),
      ...(isLease(lease) && { lease }),
      ...(typeof epoch === 'number' && { epoch }),
    });
  }
  return entries;
}

/** Who a thread a store creates belongs to, as the run that takes it names it */
interface ThreadOwner {
  agentId?: string;
  userId?: string;
}

/**
 * The agent and user a run's reference names, when the runtime passes its whole owner (it does):
 * a thread the store has to create for a new run belongs to them, as one the run creates would
 */
function ownerOf(ref: DurableRunRef): ThreadOwner {
  const agentId: unknown = Reflect.get(ref, 'agentId');
  const userId: unknown = Reflect.get(ref, 'userId');
  return {
    ...(typeof agentId === 'string' && { agentId }),
    ...(typeof userId === 'string' && { userId }),
  };
}

/**
 * Durable runs kept in the metadata of their threads (one `durableRuns` map per thread), so they
 * last as long as the memory adapter's threads do (Redis, Postgres, SQLite, MongoDB). A memory
 * adapter cannot lock, so the writes of one store go one after another per thread and its leases
 * are checked and written in two steps: let one process at a time run and recover these runs, or
 * use a store with atomic leases (`RedisDurableRunStore`) for several. A finished run leaves
 * nothing behind in the thread.
 */
export class ThreadDurableRunStore implements DurableRunStore {
  private readonly now: () => number;
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly memory: MemoryAdapter,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  async acquire(
    ref: DurableRunRef,
    holder: DurableRunHolder,
    ttlMs: number,
    options: { replacing?: string; above?: number } = {}
  ): Promise<number | false> {
    const ttl = positiveMs(ttlMs);
    let epoch = 0;
    const taken = await this.change(
      ref,
      (entries) => {
        const entry = entries.get(ref.runId) ?? {};
        const live = this.live(entry.lease);
        if (!mayTake(live, holder, options.replacing)) return false;
        epoch = nextEpoch(live, holder, entry.epoch ?? entry.lease?.epoch ?? 0, options.above);
        entries.set(ref.runId, {
          ...entry,
          epoch,
          lease: { ...holder, expiresAt: this.now() + ttl, epoch },
        });
        return true;
      },
      ownerOf(ref)
    );
    return taken ? epoch : false;
  }

  async renew(ref: DurableRunRef, holder: DurableRunHolder, ttlMs: number): Promise<boolean> {
    const ttl = positiveMs(ttlMs);
    return this.change(ref, (entries) => {
      const entry = entries.get(ref.runId);
      const live = this.live(entry?.lease);
      if (!entry || !live || !isHeldBy(live, holder)) return false;
      entries.set(ref.runId, { ...entry, lease: { ...live, expiresAt: this.now() + ttl } });
      return true;
    });
  }

  async release(ref: DurableRunRef, holder: DurableRunHolder): Promise<void> {
    await this.change(ref, (entries) => {
      const entry = entries.get(ref.runId);
      if (!entry || !isHeldBy(entry.lease, holder)) return false;
      if (entry.kept) {
        entries.set(ref.runId, {
          kept: entry.kept,
          ...(entry.epoch !== undefined && { epoch: entry.epoch }),
        });
      } else {
        entries.delete(ref.runId);
      }
      return true;
    });
  }

  async save(record: DurableRunRecord, holder: DurableRunHolder): Promise<boolean> {
    return this.change(
      record,
      (entries) => {
        const entry = entries.get(record.runId);
        if (!entry || !isHeldBy(this.live(entry.lease), holder)) return false;
        entries.set(record.runId, {
          ...entry,
          kept: {
            record: storedPart(record),
            base: nextBase(entry.kept?.base ?? [], record),
            journal: [...record.journal],
          },
        });
        return true;
      },
      record
    );
  }

  async append(
    ref: DurableRunRef,
    marks: readonly DurableRunMark[],
    holder: DurableRunHolder
  ): Promise<boolean> {
    return this.change(ref, (entries) => {
      const entry = entries.get(ref.runId);
      if (!entry?.kept || !isHeldBy(this.live(entry.lease), holder)) return false;
      entries.set(ref.runId, {
        ...entry,
        kept: { ...entry.kept, journal: [...entry.kept.journal, ...marks] },
      });
      return true;
    });
  }

  async load(ref: DurableRunRef): Promise<DurableRunRecord | null> {
    const entry = entriesOf(await this.thread(ref.threadId)).get(ref.runId);
    if (!entry?.kept) return null;
    const lease = this.live(entry.lease);
    return {
      ...entry.kept.record,
      base: entry.kept.base,
      journal: entry.kept.journal,
      ...(lease && { lease: { ...lease } }),
    };
  }

  async list(filter?: DurableRunFilter): Promise<DurableRunSummary[]> {
    const threads: Thread[] = [];
    if (filter?.threadId !== undefined) {
      const thread = await this.thread(filter.threadId);
      if (thread) threads.push(thread);
    } else {
      let cursor: string | undefined;
      do {
        const page = await this.memory.listThreads({
          metadata: { [FLAG]: true },
          limit: THREAD_PAGE,
          ...(cursor !== undefined && { cursor }),
        });
        if (!page.success) throw new Error(page.error);
        threads.push(...page.data.threads);
        cursor = page.data.nextCursor;
      } while (cursor !== undefined);
    }
    return threads.flatMap((thread) =>
      [...entriesOf(thread).values()].flatMap((entry) => {
        if (!entry.kept) return [];
        const summary = summaryOf(entry.kept.record, this.live(entry.lease));
        return matches(summary, filter) ? [summary] : [];
      })
    );
  }

  async delete(ref: DurableRunRef, holder?: DurableRunHolder): Promise<boolean> {
    return this.change(ref, (entries) => {
      const entry = entries.get(ref.runId);
      if (!entry) return !holder;
      if (holder && !isHeldBy(this.live(entry.lease), holder)) return false;
      entries.delete(ref.runId);
      return true;
    });
  }

  private live(lease: HeldLease | undefined): HeldLease | undefined {
    return lease && lease.expiresAt > this.now() ? lease : undefined;
  }

  /**
   * Changes the `durableRuns` map of the thread of `ref`, after the writes of this store to that
   * thread before it. `change` edits the map and says whether to write it. Entries of runs that
   * never saved a checkpoint and whose lease ran out are dropped on the way
   */
  private change(
    ref: DurableRunRef,
    change: (entries: Map<string, ThreadEntry>) => boolean,
    creating?: ThreadOwner
  ): Promise<boolean> {
    const before = this.writes.get(ref.threadId) ?? Promise.resolve();
    const next = before.then(async () => {
      const thread = await this.thread(ref.threadId);
      const entries = entriesOf(thread);
      if (!change(entries)) return false;
      for (const [runId, entry] of entries) {
        if (!entry.kept && !this.live(entry.lease)) entries.delete(runId);
      }
      if (!thread) {
        const agentId = creating?.agentId ?? 'cogitator';
        const created = await this.memory.createThread(
          agentId,
          { agentId, ...(creating?.userId !== undefined && { userId: creating.userId }) },
          ref.threadId
        );
        if (!created.success) throw new Error(created.error);
      }
      const empty = entries.size === 0;
      const updated = await this.memory.updateThread(ref.threadId, {
        [RUNS]: empty ? null : Object.fromEntries(entries),
        [FLAG]: [...entries.values()].some((entry) => entry.kept !== undefined),
      });
      if (!updated.success) throw new Error(updated.error);
      return true;
    });
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.writes.set(ref.threadId, settled);
    void settled.then(() => {
      if (this.writes.get(ref.threadId) === settled) this.writes.delete(ref.threadId);
    });
    return next;
  }

  private async thread(threadId: string): Promise<Thread | null> {
    const found = await this.memory.getThread(threadId);
    if (!found.success) throw new Error(found.error);
    return found.data;
  }
}

/** The Redis commands `RedisDurableRunStore` uses: `@cogitator-ai/redis` clients and ioredis both have them */
export interface DurableRunRedisClient {
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  zrange(key: string, start: number, stop: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

export interface RedisDurableRunStoreOptions {
  client: DurableRunRedisClient;
  /**
   * Prefix of every key (default `{cogitator}:durable-runs`). The scripts touch several keys at
   * once, so in Redis Cluster the prefix needs a `{hash tag}` that puts them in one slot
   */
  keyPrefix?: string;
  /**
   * Seconds a run's keys are kept after its last write, for a run nobody recovers or discards.
   * Default: 7 days, `0` keeps them until they are deleted
   */
  ttl?: number;
}

/** Default of `RedisDurableRunStoreOptions.ttl`: 7 days */
const DEFAULT_REDIS_TTL = 7 * 24 * 60 * 60;

const HELD = `
local function holder(key)
  local held = redis.call('GET', key)
  if not held then return nil end
  return string.match(held, '^([^|]*)|')
end`;

const ACQUIRE_SCRIPT = `${HELD}
local held = holder(KEYS[1])
if held and held ~= ARGV[1] and held ~= ARGV[4] then return 0 end
local epoch
if held == ARGV[1] then
  epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
else
  epoch = math.max(tonumber(redis.call('GET', KEYS[2]) or '0'), tonumber(ARGV[6])) + 1
  redis.call('SET', KEYS[2], epoch)
end
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'PX', ARGV[3])
if tonumber(ARGV[5]) > 0 then redis.call('EXPIRE', KEYS[2], ARGV[5]) end
return epoch`;

const RENEW_SCRIPT = `${HELD}
if holder(KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
local ttl = tonumber(ARGV[3])
if ttl > 0 then
  for i = 2, #KEYS do
    if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ttl) end
  end
end
return 1`;

const RELEASE_SCRIPT = `${HELD}
if holder(KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1`;

const LEASE_SCRIPT = `
return { redis.call('GET', KEYS[1]), redis.call('PTTL', KEYS[1]), redis.call('GET', KEYS[2]) }`;

/**
 * Writes a checkpoint while the caller holds the lease. A base extension says the size of the base
 * it extends: a retry of an extension already written (its reply was lost) finds the size it left
 * and the hash of the same messages, and is taken as done
 */
const SAVE_SCRIPT = `${HELD}
if holder(KEYS[4]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
local sized = redis.call('GET', KEYS[7]) or '0|'
local size, last = string.match(sized, '^(%d+)|(.*)$')
size = tonumber(size or '0')
local sha = redis.sha1hex(ARGV[3])
if ARGV[8] == 'replace' then
  redis.call('SET', KEYS[2], ARGV[3])
  redis.call('SET', KEYS[7], ARGV[10] .. '|' .. sha)
elseif ARGV[8] == 'append' then
  if size == tonumber(ARGV[9]) then
    redis.call('APPEND', KEYS[2], ARGV[3])
    redis.call('SET', KEYS[7], ARGV[10] .. '|' .. sha)
  elseif not (size == tonumber(ARGV[10]) and last == sha) then
    return -1
  end
end
if ARGV[4] ~= '' then redis.call('SET', KEYS[3], ARGV[4]) else redis.call('DEL', KEYS[3]) end
redis.call('ZADD', KEYS[5], ARGV[5], ARGV[6])
redis.call('ZADD', KEYS[6], ARGV[5], ARGV[6])
local ttl = tonumber(ARGV[7])
if ttl > 0 then
  for _, i in ipairs({ 1, 2, 3, 7 }) do
    if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ttl) end
  end
  redis.call('EXPIRE', KEYS[6], ttl)
end
return 1`;

const APPEND_SCRIPT = `${HELD}
if holder(KEYS[2]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS', KEYS[3]) == 0 then return 0 end
redis.call('APPEND', KEYS[1], ARGV[2])
local ttl = tonumber(ARGV[3])
if ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end
return 1`;

const DELETE_SCRIPT = `${HELD}
if ARGV[1] ~= '' and holder(KEYS[4]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[7], KEYS[8])
redis.call('ZREM', KEYS[5], ARGV[2])
redis.call('ZREM', KEYS[6], ARGV[2])
return 1`;

/**
 * Durable runs in Redis, with atomic leases (by Redis's own clock) and fenced writes: a
 * checkpoint, its base, its journal and the indexes change in one script, and only while the
 * writer holds the lease, so any number of processes may share it. Each run's keys expire `ttl`
 * after its last write. Runs are listed from a sorted set, and by thread from one per thread.
 */
export class RedisDurableRunStore implements DurableRunStore {
  private readonly client: DurableRunRedisClient;
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(options: RedisDurableRunStoreOptions) {
    const ttl = options.ttl ?? DEFAULT_REDIS_TTL;
    if (!Number.isInteger(ttl) || ttl < 0) {
      throw new RangeError(`ttl must be 0 or a whole number of seconds, got ${ttl}`);
    }
    this.client = options.client;
    this.prefix = options.keyPrefix ?? '{cogitator}:durable-runs';
    this.ttl = ttl;
  }

  async acquire(
    ref: DurableRunRef,
    holder: DurableRunHolder,
    ttlMs: number,
    options: { replacing?: string; above?: number } = {}
  ): Promise<number | false> {
    const epoch = Number(
      await this.client.eval(
        ACQUIRE_SCRIPT,
        2,
        this.key('lease', ref.runId),
        this.key('epoch', ref.runId),
        holder.instance,
        holder.owner,
        positiveMs(ttlMs),
        options.replacing ?? '',
        this.ttl,
        options.above ?? 0
      )
    );
    return epoch > 0 ? epoch : false;
  }

  async renew(ref: DurableRunRef, holder: DurableRunHolder, ttlMs: number): Promise<boolean> {
    const renewed = await this.client.eval(
      RENEW_SCRIPT,
      7,
      this.key('lease', ref.runId),
      this.key('run', ref.runId),
      this.key('base', ref.runId),
      this.key('base-size', ref.runId),
      this.key('journal', ref.runId),
      this.key('epoch', ref.runId),
      this.threadKey(ref.threadId),
      holder.instance,
      positiveMs(ttlMs),
      this.ttl
    );
    return Number(renewed) === 1;
  }

  async release(ref: DurableRunRef, holder: DurableRunHolder): Promise<void> {
    await this.client.eval(RELEASE_SCRIPT, 1, this.key('lease', ref.runId), holder.instance);
  }

  async save(record: DurableRunRecord, holder: DurableRunHolder): Promise<boolean> {
    const mode = !record.base ? 'keep' : record.baseFrom === undefined ? 'replace' : 'append';
    const saved = await this.client.eval(
      SAVE_SCRIPT,
      7,
      this.key('run', record.runId),
      this.key('base', record.runId),
      this.key('journal', record.runId),
      this.key('lease', record.runId),
      this.indexKey(),
      this.threadKey(record.threadId),
      this.key('base-size', record.runId),
      holder.instance,
      JSON.stringify(storedPart(record)),
      record.base ? lines(record.base) : '',
      journalLines(record.journal),
      record.savedAt,
      record.runId,
      this.ttl,
      mode,
      record.baseFrom ?? 0,
      (record.baseFrom ?? 0) + (record.base?.length ?? 0)
    );
    if (Number(saved) === -1) {
      throw new Error(`The base of durable run ${record.runId} in Redis is not the one it extends`);
    }
    return Number(saved) === 1;
  }

  async append(
    ref: DurableRunRef,
    marks: readonly DurableRunMark[],
    holder: DurableRunHolder
  ): Promise<boolean> {
    if (marks.length === 0) return true;
    const appended = await this.client.eval(
      APPEND_SCRIPT,
      3,
      this.key('journal', ref.runId),
      this.key('lease', ref.runId),
      this.key('run', ref.runId),
      holder.instance,
      journalLines(marks),
      this.ttl
    );
    return Number(appended) === 1;
  }

  async load(ref: DurableRunRef): Promise<DurableRunRecord | null> {
    const raw = await this.client.get(this.key('run', ref.runId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredRecord;
    const base = await this.client.get(this.key('base', ref.runId));
    const journal = await this.client.get(this.key('journal', ref.runId));
    const lease = await this.leaseOf(ref.runId);
    return {
      ...stored,
      base: base ? readLines<Message>(base) : [],
      journal: journal ? readJournal(journal) : [],
      ...(lease && { lease }),
    };
  }

  async list(filter?: DurableRunFilter): Promise<DurableRunSummary[]> {
    const index =
      filter?.threadId !== undefined ? this.threadKey(filter.threadId) : this.indexKey();
    const ids =
      filter?.runId !== undefined ? [filter.runId] : await this.client.zrange(index, 0, -1);
    const summaries: DurableRunSummary[] = [];
    const missing: string[] = [];
    for (const runId of ids) {
      const raw = await this.client.get(this.key('run', runId));
      if (!raw) {
        missing.push(runId);
        continue;
      }
      const summary = summaryOf(JSON.parse(raw) as StoredRecord, await this.leaseOf(runId));
      if (matches(summary, filter)) summaries.push(summary);
    }
    if (missing.length > 0 && filter?.runId === undefined) {
      await this.client.zrem(index, ...missing);
    }
    return summaries;
  }

  async delete(ref: DurableRunRef, holder?: DurableRunHolder): Promise<boolean> {
    const deleted = await this.client.eval(
      DELETE_SCRIPT,
      8,
      this.key('run', ref.runId),
      this.key('base', ref.runId),
      this.key('journal', ref.runId),
      this.key('lease', ref.runId),
      this.indexKey(),
      this.threadKey(ref.threadId),
      this.key('base-size', ref.runId),
      this.key('epoch', ref.runId),
      holder?.instance ?? '',
      ref.runId
    );
    return Number(deleted) === 1;
  }

  private async leaseOf(runId: string): Promise<DurableRunLease | undefined> {
    const reply = await this.client.eval(
      LEASE_SCRIPT,
      2,
      this.key('lease', runId),
      this.key('epoch', runId)
    );
    if (!Array.isArray(reply)) return undefined;
    const [held, ttl, epoch] = reply as [unknown, unknown, unknown];
    if (typeof held !== 'string') return undefined;
    const split = held.indexOf('|');
    if (split === -1) return undefined;
    const left = Number(ttl);
    return {
      instance: held.slice(0, split),
      owner: held.slice(split + 1),
      ...(left > 0 && { expiresAt: Date.now() + left }),
      ...(Number(epoch) > 0 && { epoch: Number(epoch) }),
    };
  }

  private key(
    part: 'run' | 'base' | 'base-size' | 'journal' | 'lease' | 'epoch',
    runId: string
  ): string {
    return `${this.prefix}:${part}:${runId}`;
  }

  private indexKey(): string {
    return `${this.prefix}:index`;
  }

  private threadKey(threadId: string): string {
    return `${this.prefix}:thread:${threadId}`;
  }
}

function lines(values: readonly unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join('');
}

function journalLines(marks: readonly DurableRunMark[]): string {
  return lines(marks);
}

function readLines<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

function readJournal(text: string): DurableRunMark[] {
  return readLines<DurableRunMark>(text);
}
