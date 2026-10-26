import type {
  DurableRunFilter,
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
  const { base: _base, journal: _journal, lease: _lease, ...stored } = record;
  return stored;
}

function positiveMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`A durable run lease must last a positive number of ms, got ${ttlMs}`);
  }
  return Math.ceil(ttlMs);
}

interface MemoryEntryOfRun {
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
  private readonly runs = new Map<string, MemoryEntryOfRun>();
  private readonly leases = new Map<string, Required<DurableRunLease>>();
  private readonly now: () => number;

  /** @param options.now the clock leases run out by, `Date.now` by default */
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async acquire(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean> {
    const ttl = positiveMs(ttlMs);
    const held = this.liveLease(ref.runId);
    if (held && held.owner !== owner) return false;
    this.leases.set(ref.runId, { owner, expiresAt: this.now() + ttl });
    return true;
  }

  async renew(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean> {
    const ttl = positiveMs(ttlMs);
    const held = this.liveLease(ref.runId);
    if (held?.owner !== owner) return false;
    held.expiresAt = this.now() + ttl;
    return true;
  }

  async release(ref: DurableRunRef, owner: string): Promise<void> {
    if (this.leases.get(ref.runId)?.owner === owner) this.leases.delete(ref.runId);
  }

  async save(record: DurableRunRecord): Promise<void> {
    const kept = this.runs.get(record.runId);
    this.runs.set(record.runId, {
      record: structuredClone(storedPart(record)),
      base: record.base ? structuredClone(record.base) : (kept?.base ?? []),
      journal: structuredClone(record.journal),
    });
  }

  async append(ref: DurableRunRef, marks: readonly DurableRunMark[]): Promise<void> {
    const kept = this.runs.get(ref.runId);
    if (!kept) return;
    kept.journal.push(...structuredClone([...marks]));
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

  async delete(ref: DurableRunRef): Promise<void> {
    this.runs.delete(ref.runId);
    this.leases.delete(ref.runId);
  }

  private liveLease(runId: string): Required<DurableRunLease> | undefined {
    const lease = this.leases.get(runId);
    if (!lease) return undefined;
    if (lease.expiresAt > this.now()) return lease;
    this.leases.delete(runId);
    return undefined;
  }
}

const FLAG = 'cogitatorDurableRuns';
const RECORD = 'durableRun.';
const BASE = 'durableRunBase.';
const JOURNAL = 'durableRunJournal.';
const LEASE = 'durableRunLease.';
const THREAD_PAGE = 500;

function isRecord(value: unknown): value is StoredRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === 'string' &&
    typeof (value as { checkpoint?: unknown }).checkpoint === 'object'
  );
}

function isLease(value: unknown): value is Required<DurableRunLease> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { owner?: unknown }).owner === 'string' &&
    typeof (value as { expiresAt?: unknown }).expiresAt === 'number'
  );
}

/**
 * Durable runs kept in the metadata of their threads, so they last as long as the memory
 * adapter's threads do (Redis, Postgres, SQLite, MongoDB). A memory adapter cannot lock, so its
 * leases are checked and written in two steps: let one process at a time run and recover these
 * runs, or use a store with atomic leases (`RedisDurableRunStore`) for several.
 */
export class ThreadDurableRunStore implements DurableRunStore {
  private readonly now: () => number;

  constructor(
    private readonly memory: MemoryAdapter,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  async acquire(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean> {
    const ttl = positiveMs(ttlMs);
    const thread = await this.thread(ref.threadId);
    const held = thread?.metadata[LEASE + ref.runId];
    if (isLease(held) && held.owner !== owner && held.expiresAt > this.now()) return false;
    await this.write(ref, thread, { [LEASE + ref.runId]: { owner, expiresAt: this.now() + ttl } });
    const after = await this.thread(ref.threadId);
    const kept = after?.metadata[LEASE + ref.runId];
    return isLease(kept) && kept.owner === owner;
  }

  async renew(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean> {
    const ttl = positiveMs(ttlMs);
    const thread = await this.thread(ref.threadId);
    const held = thread?.metadata[LEASE + ref.runId];
    if (!thread || !isLease(held) || held.owner !== owner || held.expiresAt <= this.now()) {
      return false;
    }
    await this.update(ref.threadId, {
      [LEASE + ref.runId]: { owner, expiresAt: this.now() + ttl },
    });
    return true;
  }

  async release(ref: DurableRunRef, owner: string): Promise<void> {
    const thread = await this.thread(ref.threadId);
    const held = thread?.metadata[LEASE + ref.runId];
    if (!thread || !isLease(held) || held.owner !== owner) return;
    await this.update(ref.threadId, { [LEASE + ref.runId]: null });
  }

  async save(record: DurableRunRecord): Promise<void> {
    const thread = await this.thread(record.threadId);
    await this.write(record, thread, {
      [FLAG]: true,
      [RECORD + record.runId]: storedPart(record),
      [JOURNAL + record.runId]: record.journal,
      ...(record.base && { [BASE + record.runId]: record.base }),
    });
  }

  async append(ref: DurableRunRef, marks: readonly DurableRunMark[]): Promise<void> {
    const thread = await this.thread(ref.threadId);
    if (!thread || !isRecord(thread.metadata[RECORD + ref.runId])) return;
    const journal = thread.metadata[JOURNAL + ref.runId];
    await this.update(ref.threadId, {
      [JOURNAL + ref.runId]: [...(Array.isArray(journal) ? journal : []), ...marks],
    });
  }

  async load(ref: DurableRunRef): Promise<DurableRunRecord | null> {
    const thread = await this.thread(ref.threadId);
    return thread ? this.recordOf(thread, ref.runId) : null;
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
    const summaries: DurableRunSummary[] = [];
    for (const thread of threads) {
      for (const [key, value] of Object.entries(thread.metadata)) {
        if (!key.startsWith(RECORD) || !isRecord(value)) continue;
        const summary = summaryOf(value, this.leaseOf(thread, value.runId));
        if (matches(summary, filter)) summaries.push(summary);
      }
    }
    return summaries;
  }

  async delete(ref: DurableRunRef): Promise<void> {
    const thread = await this.thread(ref.threadId);
    if (!thread) return;
    await this.update(ref.threadId, {
      [RECORD + ref.runId]: null,
      [BASE + ref.runId]: null,
      [JOURNAL + ref.runId]: null,
      [LEASE + ref.runId]: null,
    });
    if (await this.holdsRuns(ref.threadId)) return;
    await this.update(ref.threadId, { [FLAG]: false });
    if (await this.holdsRuns(ref.threadId)) await this.update(ref.threadId, { [FLAG]: true });
  }

  private recordOf(thread: Thread, runId: string): DurableRunRecord | null {
    const stored = thread.metadata[RECORD + runId];
    if (!isRecord(stored)) return null;
    const base = thread.metadata[BASE + runId];
    const journal = thread.metadata[JOURNAL + runId];
    const lease = this.leaseOf(thread, runId);
    return {
      ...stored,
      base: Array.isArray(base) ? (base as Message[]) : [],
      journal: Array.isArray(journal) ? (journal as DurableRunMark[]) : [],
      ...(lease && { lease }),
    };
  }

  private leaseOf(thread: Thread, runId: string): DurableRunLease | undefined {
    const lease = thread.metadata[LEASE + runId];
    return isLease(lease) && lease.expiresAt > this.now() ? { ...lease } : undefined;
  }

  private async holdsRuns(threadId: string): Promise<boolean> {
    const thread = await this.thread(threadId);
    if (!thread) return false;
    return Object.entries(thread.metadata).some(
      ([key, value]) => key.startsWith(RECORD) && isRecord(value)
    );
  }

  private async thread(threadId: string): Promise<Thread | null> {
    const found = await this.memory.getThread(threadId);
    if (!found.success) throw new Error(found.error);
    return found.data;
  }

  private async write(
    ref: DurableRunRef & { agentId?: string; userId?: string },
    thread: Thread | null,
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (!thread) {
      const agentId = ref.agentId ?? 'cogitator';
      const created = await this.memory.createThread(
        agentId,
        { agentId, ...(ref.userId !== undefined && { userId: ref.userId }) },
        ref.threadId
      );
      if (!created.success) throw new Error(created.error);
    }
    await this.update(ref.threadId, metadata);
  }

  private async update(threadId: string, metadata: Record<string, unknown>): Promise<void> {
    const updated = await this.memory.updateThread(threadId, metadata);
    if (!updated.success) throw new Error(updated.error);
  }
}

/** The Redis commands `RedisDurableRunStore` uses: `@cogitator-ai/redis` clients and ioredis both have them */
export interface DurableRunRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
}

export interface RedisDurableRunStoreOptions {
  client: DurableRunRedisClient;
  /** Prefix of every key (default `cogitator:durable-runs`) */
  keyPrefix?: string;
}

const ACQUIRE_SCRIPT = `
local held = redis.call('GET', KEYS[1])
if held and held ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1`;

const LEASE_SCRIPT = `
return { redis.call('GET', KEYS[1]), redis.call('PTTL', KEYS[1]) }`;

const APPEND_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('APPEND', KEYS[1], ARGV[1])
return 1`;

/**
 * Durable runs in Redis, with atomic leases (`SET ... PX` in a script, by Redis's own clock), so
 * any number of processes may share it: each run as JSON under its id, its journal as JSON lines,
 * and a sorted set of the run ids to list them.
 */
export class RedisDurableRunStore implements DurableRunStore {
  private readonly client: DurableRunRedisClient;
  private readonly prefix: string;

  constructor(options: RedisDurableRunStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:durable-runs';
  }

  async acquire(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean> {
    const taken = await this.client.eval(
      ACQUIRE_SCRIPT,
      1,
      this.key('lease', ref.runId),
      owner,
      positiveMs(ttlMs)
    );
    return Number(taken) === 1;
  }

  async renew(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean> {
    const renewed = await this.client.eval(
      RENEW_SCRIPT,
      1,
      this.key('lease', ref.runId),
      owner,
      positiveMs(ttlMs)
    );
    return Number(renewed) === 1;
  }

  async release(ref: DurableRunRef, owner: string): Promise<void> {
    await this.client.eval(RELEASE_SCRIPT, 1, this.key('lease', ref.runId), owner);
  }

  async save(record: DurableRunRecord): Promise<void> {
    await this.client.set(this.key('run', record.runId), JSON.stringify(storedPart(record)));
    if (record.base)
      await this.client.set(this.key('base', record.runId), JSON.stringify(record.base));
    if (record.journal.length > 0) {
      await this.client.set(this.key('journal', record.runId), journalLines(record.journal));
    } else {
      await this.client.del(this.key('journal', record.runId));
    }
    await this.client.zadd(this.indexKey(), record.savedAt, record.runId);
  }

  async append(ref: DurableRunRef, marks: readonly DurableRunMark[]): Promise<void> {
    if (marks.length === 0) return;
    await this.client.eval(
      APPEND_SCRIPT,
      2,
      this.key('journal', ref.runId),
      this.key('run', ref.runId),
      journalLines(marks)
    );
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
      base: base ? (JSON.parse(base) as Message[]) : [],
      journal: journal ? readJournal(journal) : [],
      ...(lease && { lease }),
    };
  }

  async list(filter?: DurableRunFilter): Promise<DurableRunSummary[]> {
    const ids =
      filter?.runId !== undefined
        ? [filter.runId]
        : await this.client.zrange(this.indexKey(), 0, -1);
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
    if (missing.length > 0) await this.client.zrem(this.indexKey(), ...missing);
    return summaries;
  }

  async delete(ref: DurableRunRef): Promise<void> {
    await this.client.del(
      this.key('run', ref.runId),
      this.key('base', ref.runId),
      this.key('journal', ref.runId),
      this.key('lease', ref.runId)
    );
    await this.client.zrem(this.indexKey(), ref.runId);
  }

  private async leaseOf(runId: string): Promise<DurableRunLease | undefined> {
    const reply = await this.client.eval(LEASE_SCRIPT, 1, this.key('lease', runId));
    if (!Array.isArray(reply)) return undefined;
    const [owner, ttl] = reply as [unknown, unknown];
    if (typeof owner !== 'string') return undefined;
    const left = Number(ttl);
    return { owner, ...(left > 0 && { expiresAt: Date.now() + left }) };
  }

  private key(part: 'run' | 'base' | 'journal' | 'lease', runId: string): string {
    return `${this.prefix}:${part}:${runId}`;
  }

  private indexKey(): string {
    return `${this.prefix}:index`;
  }
}

function journalLines(marks: readonly DurableRunMark[]): string {
  return marks.map((mark) => `${JSON.stringify(mark)}\n`).join('');
}

function readJournal(text: string): DurableRunMark[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as DurableRunMark);
}
