import type {
  ListThreadsOptions,
  Thread,
  ThreadPage,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  Message,
  MongoDBAdapterConfig,
  MemoryProvider,
  ToolCall,
  ToolResult,
  NewMemoryEntry,
  MemoryEntryType,
  PathQueryOptions,
} from '@cogitator-ai/types';
import { CONVERSATION_ENTRY_TYPES, MEMORY_ENTRY_FORMAT } from '@cogitator-ai/types';
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  FindOneAndUpdateOptions,
  FindOptions,
  MongoClient as DriverClient,
  UpdateFilter,
  WithId,
} from 'mongodb';
import { BranchingMemoryAdapter, entryTypeWanted } from './base';
import { threadListing, threadPage, type ThreadListing } from './thread-listing';

/** A cursor over `find()` results, as far as the adapter reads it. */
type MongoCursor<T extends Document> = Pick<
  FindCursor<WithId<T>>,
  'sort' | 'limit' | 'batchSize' | 'toArray' | 'next' | 'close'
>;

/**
 * The collection methods the adapter calls, typed against the installed `mongodb` driver so a
 * method it no longer has, or one whose signature changed, fails to compile. The overloaded
 * lookups are narrowed to the one form the adapter uses, which the driver's collection still has
 * to satisfy.
 */
interface MongoCollection<T extends Document> extends Pick<
  Collection<T>,
  | 'createIndex'
  | 'insertOne'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany'
  | 'bulkWrite'
> {
  findOne(filter: Filter<T>): Promise<WithId<T> | null>;
  find(filter: Filter<T>, options?: FindOptions): MongoCursor<T>;
  findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T> | Document[],
    options: FindOneAndUpdateOptions
  ): Promise<WithId<T> | null>;
}

interface MongoDatabase {
  collection<T extends Document>(name: string): MongoCollection<T>;
}

interface MongoClient extends Pick<DriverClient, 'connect' | 'close'> {
  db(name?: string): MongoDatabase;
}

/** `entrySeq` counts the entries added to the thread, to order those created at one time. */
interface ThreadDoc {
  _id: string;
  agentId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  entrySeq?: number;
  activeLeafId?: string | null;
  /** Set once the entries written before trees were chained, and on threads made since */
  chained?: boolean;
  /** The write lease of the writer changing the thread's tree, see `MongoDBAdapter.underLease` */
  lease?: ThreadLease | null;
}

/** A write lease on a thread: who holds it, and until when by the server's clock */
interface ThreadLease {
  token: string;
  until: Date;
}

/** A lease this adapter holds */
interface HeldLease {
  threadId: string;
  token: string;
  /** `performance.now()` just before the lease was asked for */
  takenAt: number;
  /** The thread as the lease found it, kept up to date by the writes made under it */
  thread: WithId<ThreadDoc>;
  /** Whether it was given back, by a write that released it or by {@link MongoDBAdapter.release} */
  released: boolean;
}

/** A lease ran out or was taken over before a write under it was done, so the write starts over */
class LeaseLost extends Error {
  constructor() {
    super('The write lease on the thread was lost');
  }
}

/**
 * `T` as an earlier version of the adapter may have stored it: its client serialized optional
 * fields left `undefined` as BSON null, so they read back as `null`.
 */
type Nullable<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] | null };

type StoredMessage = Nullable<Message, 'name' | 'toolCallId'>;
type StoredToolCall = Nullable<ToolCall, 'thoughtSignature' | 'replay'>;
type StoredToolResult = Nullable<ToolResult, 'error'>;

interface EntryDoc {
  _id: string;
  threadId: string;
  message: StoredMessage;
  toolCalls?: StoredToolCall[] | null;
  toolResults?: StoredToolResult[] | null;
  tokenCount: number;
  createdAt: Date;
  metadata?: Record<string, unknown> | null;
  seq?: number;
  type?: MemoryEntryType | null;
  parentId?: string | null;
  event?: Record<string, unknown> | null;
  formatVersion?: number | null;
}

/** An entry as a path walk reads it: no content, only where it hangs and what it is */
type EntrySkeleton = Pick<WithId<EntryDoc>, '_id' | 'parentId' | 'type' | 'createdAt'>;

const SKELETON = { _id: 1, parentId: 1, type: 1, createdAt: 1 } as const;

/** Entry skeletons one round trip of a path walk reads */
const SKELETON_BATCH = 500;

/** Full entries one round trip of a path read asks for */
const ENTRY_BATCH = 100;

/** How long a write lease lasts: a writer that crashed holding one blocks its thread this long */
const LEASE_MS = 5_000;

/**
 * How old a lease may be when its holder makes a write that the lease does not fence, far enough
 * from {@link LEASE_MS} that a lease never runs out between the check and the write
 */
const LEASE_SAFE_MS = 2_000;

/** How long a writer waits for a lease another one holds: long enough for one that crashed */
const LEASE_WAIT_MS = 2 * LEASE_MS;

/** Times a write starts over after its lease was lost */
const LEASE_ATTEMPTS = 5;

const LEASE_FIRST_PAUSE_MS = 2;
const LEASE_MAX_PAUSE_MS = 50;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMessage({ name, toolCallId, ...message }: StoredMessage): Message {
  return {
    ...message,
    ...(name != null && { name }),
    ...(toolCallId != null && { toolCallId }),
  };
}

function readToolCall({ thoughtSignature, replay, ...call }: StoredToolCall): ToolCall {
  return {
    ...call,
    ...(thoughtSignature != null && { thoughtSignature }),
    ...(replay != null && { replay }),
  };
}

function readToolResult({ error, ...result }: StoredToolResult): ToolResult {
  return { ...result, ...(error != null && { error }) };
}

function readEntry(doc: WithId<EntryDoc>, withToolCalls: boolean): MemoryEntry {
  return {
    id: doc._id,
    threadId: doc.threadId,
    message: readMessage(doc.message),
    ...(withToolCalls && doc.toolCalls && { toolCalls: doc.toolCalls.map(readToolCall) }),
    ...(withToolCalls && doc.toolResults && { toolResults: doc.toolResults.map(readToolResult) }),
    tokenCount: doc.tokenCount,
    createdAt: doc.createdAt,
    ...(doc.metadata && { metadata: doc.metadata }),
    type: doc.type ?? 'message',
    parentId: doc.parentId ?? null,
    ...(doc.seq != null && { seq: doc.seq }),
    ...(doc.event && { event: doc.event }),
    formatVersion: doc.formatVersion ?? 1,
  };
}

/** A filter on entry types, absent meaning `message` */
function typeFilter(
  types: readonly MemoryEntryType[] | 'all' | undefined
): Filter<EntryDoc> | undefined {
  if (types === 'all') return undefined;
  const wanted = [...(types ?? CONVERSATION_ENTRY_TYPES)];
  return wanted.includes('message')
    ? { $or: [{ type: { $in: wanted } }, { type: null }] }
    : { type: { $in: wanted } };
}

function readThread(doc: WithId<ThreadDoc>): Thread {
  return {
    id: doc._id,
    agentId: doc.agentId,
    metadata: doc.metadata ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.activeLeafId && { activeLeafId: doc.activeLeafId }),
  };
}

/**
 * Threads whose metadata holds exactly `value` under the top-level `key`. A plain key is matched
 * as a path, leaving out arrays that would match by holding the value. A key with a dot names a
 * field with a dot in it, which only `$getField` reads.
 */
function metadataEquals(key: string, value: string | number | boolean): Filter<ThreadDoc> {
  if (!key.includes('.')) {
    return { [`metadata.${key}`]: { $eq: value, $not: { $type: 'array' } } };
  }
  return {
    $expr: {
      $eq: [{ $getField: { field: { $literal: key }, input: '$metadata' } }, { $literal: value }],
    },
  };
}

/** Threads after the cursor of `listing` in its order. */
function afterCursor({ cursor, order }: ThreadListing): Filter<ThreadDoc> | undefined {
  if (!cursor) return undefined;
  const at = new Date(cursor.updatedAt);
  return order === 'asc'
    ? { $or: [{ updatedAt: { $gt: at } }, { updatedAt: at, _id: { $gt: cursor.id } }] }
    : { $or: [{ updatedAt: { $lt: at } }, { updatedAt: at, _id: { $lt: cursor.id } }] };
}

export class MongoDBAdapter extends BranchingMemoryAdapter {
  readonly provider: MemoryProvider = 'mongodb';

  private client: MongoClient | null = null;
  private db: MongoDatabase | null = null;
  private connecting: Promise<MemoryResult<void>> | null = null;
  private uri: string;
  private database: string;
  private prefix: string;
  /** The tail of each thread's queue of tree writes in this process */
  private writeQueues = new Map<string, Promise<unknown>>();

  constructor(config: MongoDBAdapterConfig) {
    super();
    this.uri = config.uri;
    this.database = config.database ?? 'cogitator';
    this.prefix = config.collectionPrefix ?? 'memory_';
  }

  private get threads(): MongoCollection<ThreadDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<ThreadDoc>(`${this.prefix}threads`);
  }

  private get entries(): MongoCollection<EntryDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<EntryDoc>(`${this.prefix}entries`);
  }

  /**
   * Opens the client and builds the indexes. Concurrent calls share one attempt, and a failed
   * attempt closes its client and leaves the adapter disconnected, so the next call tries again.
   */
  async connect(): Promise<MemoryResult<void>> {
    if (this.client) return this.success(undefined);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<MemoryResult<void>> {
    let MongoClient: typeof DriverClient;
    try {
      ({ MongoClient } = await import('mongodb'));
    } catch {
      return this.failure('mongodb not installed. Run: pnpm add mongodb');
    }

    let client: MongoClient | undefined;
    try {
      client = new MongoClient(this.uri, { ignoreUndefined: true });
      await client.connect();
      const db = client.db(this.database);
      const threads = db.collection<ThreadDoc>(`${this.prefix}threads`);
      await threads.createIndex({ agentId: 1, updatedAt: 1, _id: 1 });
      await threads.createIndex({ updatedAt: 1, _id: 1 });
      await db
        .collection<EntryDoc>(`${this.prefix}entries`)
        .createIndex({ threadId: 1, createdAt: 1, seq: 1 });

      this.client = client;
      this.db = db;
      return this.success(undefined);
    } catch (err) {
      await client?.close().catch(() => undefined);
      return this.failure((err as Error).message);
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.connecting) await this.connecting;
    if (this.client) {
      try {
        await this.client.close();
        return this.success(undefined);
      } catch (err) {
        return this.failure((err as Error).message);
      } finally {
        this.client = null;
        this.db = null;
      }
    }
    return this.success(undefined);
  }

  async createThread(
    agentId: string,
    metadata: Record<string, unknown> = {},
    threadId?: string
  ): Promise<MemoryResult<Thread>> {
    const idProblem = this.threadIdProblem(threadId);
    if (idProblem) return this.failure(idProblem);
    if (!this.db) return this.failure('Not connected');

    const id = threadId ?? this.generateId('thread');
    const now = new Date();

    try {
      await this.threads.updateOne(
        { _id: id },
        {
          $set: { agentId, metadata, updatedAt: now },
          $setOnInsert: { createdAt: now, chained: true },
        },
        { upsert: true }
      );
      const stored = await this.threads.findOne({ _id: id });
      return this.success(
        stored ? readThread(stored) : { id, agentId, metadata, createdAt: now, updatedAt: now }
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const doc = await this.chainedThread(threadId);
      return this.success(doc ? readThread(doc) : null);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * The thread, its entries written before trees chained in the order they were added the
   * first time it is read
   */
  private async chainedThread(threadId: string): Promise<WithId<ThreadDoc> | null> {
    const doc = await this.threads.findOne({ _id: threadId });
    if (!doc || doc.chained) return doc;
    const chained = await this.underLease(
      threadId,
      async (lease) => {
        await this.ensureChained(lease);
        return this.success(undefined);
      },
      { missing: async () => this.success(undefined) }
    );
    if (!chained.success) throw new Error(chained.error);
    return this.threads.findOne({ _id: threadId });
  }

  /**
   * Chains the entries of the leased thread written before trees, once per thread: each after the
   * one before in the order `getEntries` read them then, the newest the active leaf when the
   * thread has none
   */
  private async ensureChained(lease: HeldLease): Promise<void> {
    if (lease.thread.chained) return;
    const legacy = await this.entries
      .find({ threadId: lease.threadId, formatVersion: null }, { projection: { _id: 1 } })
      .sort({ createdAt: -1, seq: -1 })
      .toArray();
    legacy.reverse();
    if (legacy.length > 0) {
      this.guard(lease);
      await this.entries.bulkWrite(
        legacy.map((entry, i) => ({
          updateOne: {
            filter: { _id: entry._id },
            update: { $set: { parentId: i === 0 ? null : legacy[i - 1]!._id } },
          },
        }))
      );
    }
    const activeLeafId = lease.thread.activeLeafId ?? legacy.at(-1)?._id ?? null;
    await this.commit(lease, { $set: { chained: true, activeLeafId } });
    lease.thread = { ...lease.thread, chained: true, activeLeafId };
  }

  /**
   * Runs `write` holding the thread's write lease, the one protocol every change to a thread's
   * tree follows: appends, deletes that splice an entry out, leaf moves, clearing and chaining.
   *
   * MongoDB without a replica set has no transactions over several documents, and a tree write
   * touches several: an append reads the leaf, inserts the entry and moves the leaf, a delete
   * re-parents the children, moves the leaf and removes the entry. Run side by side, an append can
   * hang its entry under one a delete has just removed, or two appends under one parent. So
   * writers take turns: a lease on the thread document, taken by one atomic `findOneAndUpdate`
   * when nobody holds it or the holder's ran out by the server's clock, and given back when the
   * write is done. A writer that crashed holding it blocks the thread for {@link LEASE_MS} at
   * most. The write that finishes a change on the thread document (publishing the leaf) is fenced
   * by the lease token, so it lands only while the lease is still this writer's, and writes to
   * entries are made only while the lease is younger than {@link LEASE_SAFE_MS}. Each step
   * leaves a valid tree when a writer stops after it: an entry is inserted before it is published
   * as the leaf, and a deleted entry's children and the leaf leave it before it goes. A write
   * whose lease was lost starts over. Writes of one adapter to one thread queue up in process
   * first, so they do not compete for the lease, and a write costs one round trip to take the
   * lease, which the write that publishes it gives back.
   *
   * Compare-and-set of the leaf after inserting the entry was the alternative without a lease,
   * but it cannot keep a concurrent splice from removing the parent an entry was just inserted
   * under.
   */
  private underLease<T>(
    threadId: string,
    write: (lease: HeldLease) => Promise<MemoryResult<T>>,
    options: { countEntry?: boolean; missing?: () => Promise<MemoryResult<T>> } = {}
  ): Promise<MemoryResult<T>> {
    return this.queued(threadId, async () => {
      for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt++) {
        const lease = await this.acquire(threadId, options.countEntry === true);
        if (!lease) {
          return options.missing
            ? options.missing()
            : this.failure(`Thread not found: ${threadId}`);
        }
        try {
          return await write(lease);
        } catch (err) {
          if (!(err instanceof LeaseLost)) throw err;
        } finally {
          await this.release(lease);
        }
      }
      return this.failure(
        `Thread ${threadId} lost its write lease on every one of ${LEASE_ATTEMPTS} attempts`
      );
    });
  }

  /** Runs `task` after the tree writes this adapter queued for the thread before it */
  private queued<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.writeQueues.get(threadId) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeQueues.set(threadId, tail);
    void tail.then(() => {
      if (this.writeQueues.get(threadId) === tail) this.writeQueues.delete(threadId);
    });
    return run;
  }

  /**
   * Takes the thread's write lease, counting a new entry in `entrySeq` when `countEntry` is set,
   * waiting while another writer holds it. Null when the thread does not exist.
   */
  private async acquire(threadId: string, countEntry: boolean): Promise<HeldLease | null> {
    const token = this.generateId('lease');
    const deadline = performance.now() + LEASE_WAIT_MS;
    let wait = LEASE_FIRST_PAUSE_MS;
    for (;;) {
      const takenAt = performance.now();
      const thread = await this.threads.findOneAndUpdate(
        { _id: threadId, $or: [{ lease: null }, { $expr: { $lt: ['$lease.until', '$$NOW'] } }] },
        [
          {
            $set: {
              lease: { token: { $literal: token }, until: { $add: ['$$NOW', LEASE_MS] } },
              ...(countEntry && { entrySeq: { $add: [{ $ifNull: ['$entrySeq', 0] }, 1] } }),
            },
          },
        ],
        { returnDocument: 'after' }
      );
      if (thread) return { threadId, token, takenAt, thread, released: false };
      if (!(await this.threads.findOne({ _id: threadId }))) return null;
      if (performance.now() > deadline) {
        throw new Error(
          `Thread ${threadId} stayed leased by another writer for ${LEASE_WAIT_MS} ms`
        );
      }
      await pause(wait * (0.5 + Math.random()));
      wait = Math.min(wait * 2, LEASE_MAX_PAUSE_MS);
    }
  }

  /** Fails with {@link LeaseLost} once the lease is too old for a write it does not fence */
  private guard(lease: HeldLease): void {
    if (performance.now() - lease.takenAt > LEASE_SAFE_MS) throw new LeaseLost();
  }

  /**
   * Updates the leased thread if the lease is still this writer's, giving it back when `release`
   * is set. Fails with {@link LeaseLost} otherwise, also when the thread was deleted.
   */
  private async commit(
    lease: HeldLease,
    update: UpdateFilter<ThreadDoc>,
    release = false
  ): Promise<void> {
    const result = await this.threads.updateOne(
      { _id: lease.threadId, 'lease.token': lease.token },
      release ? { ...update, $unset: { lease: '' } } : update
    );
    if (result.matchedCount === 0) throw new LeaseLost();
    if (release) lease.released = true;
  }

  /** Gives the lease back if it is still this writer's. One it fails to give back runs out. */
  private async release(lease: HeldLease): Promise<void> {
    if (lease.released) return;
    lease.released = true;
    await this.threads
      .updateOne({ _id: lease.threadId, 'lease.token': lease.token }, { $unset: { lease: '' } })
      .catch(() => undefined);
  }

  async listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>> {
    const listing = threadListing(options);
    if (typeof listing === 'string') return this.failure(listing);
    if (!this.db) return this.failure('Not connected');

    const conditions: Filter<ThreadDoc>[] = [];
    if (listing.agentId !== undefined) conditions.push({ agentId: { $eq: listing.agentId } });
    if (listing.updatedAfter) conditions.push({ updatedAt: { $gte: listing.updatedAfter } });
    for (const [key, value] of listing.metadata) conditions.push(metadataEquals(key, value));
    const after = afterCursor(listing);
    if (after) conditions.push(after);
    const direction = listing.order === 'asc' ? 1 : -1;

    try {
      const docs = await this.threads
        .find(conditions.length > 0 ? { $and: conditions } : {})
        .sort({ updatedAt: direction, _id: direction })
        .limit(listing.limit + 1)
        .toArray();
      return this.success(threadPage(docs.map(readThread), listing));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const doc = await this.threads.findOneAndUpdate(
        { _id: threadId },
        [
          {
            $set: {
              metadata: { $mergeObjects: [{ $ifNull: ['$metadata', {}] }, { $literal: metadata }] },
              updatedAt: { $literal: new Date() },
            },
          },
        ],
        { returnDocument: 'after' }
      );
      return doc ? this.success(readThread(doc)) : this.failure(`Thread not found: ${threadId}`);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Deletes the thread before its entries: once it is gone `addEntry` adds none, and one that was
   * adding meanwhile takes its entry back when it finds the thread gone.
   */
  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.dropThread(threadId), () => ({
      type: 'thread-deleted',
      threadId,
    }));
  }

  private async dropThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      await this.threads.deleteOne({ _id: threadId });
      await this.entries.deleteMany({ threadId });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    return this.reported(await this.storeEntry(entry), (stored) => ({
      type: 'entry-added',
      entry: stored,
    }));
  }

  /**
   * Inserts the entry under the parent it asks for, or under the active leaf, then publishes it
   * as the leaf, all under the thread's write lease. An entry inserted by an attempt that lost the
   * lease is moved under the parent the next attempt finds, and taken back when the add fails.
   */
  private async storeEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');

    const id = this.generateId('entry');
    const createdAt = this.entryTimestamp(entry);
    const { activate, parentId: askedParent, ...fields } = entry;
    const type = fields.type ?? (fields.message?.role === 'tool' ? 'tool_result' : 'message');
    const moves = activate !== false;
    let inserted = false;
    let seq: number | undefined;

    try {
      const added = await this.underLease(
        entry.threadId,
        async (lease): Promise<MemoryResult<MemoryEntry>> => {
          await this.ensureChained(lease);
          seq ??= lease.thread.entrySeq ?? 1;
          const parentId =
            askedParent === undefined ? (lease.thread.activeLeafId ?? null) : askedParent;
          if (
            askedParent != null &&
            !(await this.entries.findOne({ _id: askedParent, threadId: entry.threadId }))
          ) {
            return this.failure(`Parent entry ${askedParent} is not in thread ${entry.threadId}`);
          }
          this.guard(lease);
          if (inserted) {
            await this.entries.updateOne({ _id: id }, { $set: { parentId } });
          } else {
            inserted = true;
            await this.entries.insertOne({
              _id: id,
              threadId: entry.threadId,
              message: fields.message,
              toolCalls: fields.toolCalls,
              toolResults: fields.toolResults,
              tokenCount: fields.tokenCount,
              createdAt,
              metadata: fields.metadata,
              seq,
              type,
              parentId,
              event: fields.event,
              formatVersion: MEMORY_ENTRY_FORMAT,
            });
          }
          await this.commit(lease, moves ? { $set: { activeLeafId: id } } : {}, true);
          return this.success({
            ...fields,
            id,
            createdAt,
            type,
            parentId,
            seq,
            formatVersion: MEMORY_ENTRY_FORMAT,
          });
        },
        { countEntry: true }
      );
      if (!added.success && inserted) await this.entries.deleteOne({ _id: id });
      return added;
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * The path walked back from its start reading only skeletons of entries, a bounded batch per
   * round trip, then the full entries it keeps, so a long path of big entries never makes one big
   * result
   */
  override async getPath(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    if (!this.db) return this.failure('Not connected');
    const start = await this.pathStart(options);
    if (!start.success) return start;
    if (start.data === null) return this.success([]);

    try {
      const kept = await this.walkPath(options.threadId, start.data, options);
      const docs = await this.entriesById(options.threadId, kept);
      return this.success(
        docs.map((doc) => readEntry(doc, options.includeToolCalls === true)).reverse()
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * The ids of the entries `options` wants on the path back from `startId`, newest first. A
   * parent is almost always created before its child, so the walk reads the thread's entries
   * created no later than the start through one cursor, newest first, as far as it needs, and
   * looks a parent the cursor does not hold up by its id.
   */
  private async walkPath(
    threadId: string,
    startId: string,
    options: PathQueryOptions
  ): Promise<string[]> {
    const skeleton = async (id: string): Promise<EntrySkeleton | undefined> => {
      const [found] = await this.entries
        .find({ _id: id, threadId }, { projection: SKELETON })
        .limit(1)
        .toArray();
      return found;
    };
    let current = await skeleton(startId);
    if (!current) return [];
    const cursor = this.entries
      .find({ threadId, createdAt: { $lte: current.createdAt } }, { projection: SKELETON })
      .sort({ createdAt: -1, seq: -1 })
      .batchSize(SKELETON_BATCH);
    const scanned = new Map<string, EntrySkeleton>();
    const seen = new Set<string>();
    const kept: string[] = [];
    let scanning = true;

    try {
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        if (entryTypeWanted(current.type ?? undefined, options.types)) {
          kept.push(current._id);
          if (options.limit && kept.length >= options.limit) break;
        }
        const parentId = current.parentId;
        if (!parentId) break;
        current = scanned.get(parentId);
        while (!current && scanning) {
          const next = await cursor.next();
          if (!next) scanning = false;
          else if (next._id === parentId) current = next;
          else scanned.set(next._id, next);
        }
        current ??= await skeleton(parentId);
      }
    } finally {
      await cursor.close();
    }
    return kept;
  }

  /** The full entries of the thread with the ids, in their order, a batch per round trip */
  private async entriesById(threadId: string, ids: string[]): Promise<WithId<EntryDoc>[]> {
    const byId = new Map<string, WithId<EntryDoc>>();
    for (let i = 0; i < ids.length; i += ENTRY_BATCH) {
      const docs = await this.entries
        .find({ _id: { $in: ids.slice(i, i + ENTRY_BATCH) }, threadId })
        .toArray();
      for (const doc of docs) byId.set(doc._id, doc);
    }
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /**
   * Moves the active leaf under the thread's write lease, to an entry that is still the
   * thread's when the leaf moves: a delete takes the same lease, so none can slip in between.
   */
  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');
    try {
      return await this.underLease(threadId, async (lease) => {
        await this.ensureChained(lease);
        if (leafId !== null && !(await this.entries.findOne({ _id: leafId, threadId }))) {
          return this.failure(`Entry ${leafId} is not in thread ${threadId}`);
        }
        const doc = await this.threads.findOneAndUpdate(
          { _id: threadId, 'lease.token': lease.token },
          { $set: { activeLeafId: leafId }, $unset: { lease: '' } },
          { returnDocument: 'after' }
        );
        if (!doc) throw new LeaseLost();
        lease.released = true;
        return this.success(readThread(doc));
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    if (!this.db) return this.failure('Not connected');

    try {
      const filter: Filter<EntryDoc> = { threadId: { $eq: options.threadId } };

      if (options.before || options.after) {
        const createdAt: { $lt?: Date; $gt?: Date } = {};
        if (options.before) createdAt.$lt = options.before;
        if (options.after) createdAt.$gt = options.after;
        filter.createdAt = createdAt;
      }

      const types = typeFilter(options.types);
      let cursor = this.entries
        .find(types ? { $and: [filter, types] } : filter)
        .sort({ createdAt: -1, seq: -1 });
      if (options.limit) cursor = cursor.limit(options.limit);

      const docs = await cursor.toArray();
      docs.reverse();

      return this.success(docs.map((doc) => readEntry(doc, options.includeToolCalls === true)));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const doc = await this.entries.findOne({ _id: entryId });
      return this.success(doc ? readEntry(doc, true) : null);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.removeEntry(entryId), () => ({
      type: 'entry-deleted',
      entryId,
    }));
  }

  /**
   * Splices the entry out of its branch under the thread's write lease: its children go after its
   * parent and the leaf moves to the parent when it was the entry, before the entry goes
   */
  private async removeEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const entry = await this.entries.findOne({ _id: entryId });
      if (!entry) return this.success(undefined);
      const { threadId } = entry;
      return await this.underLease(
        threadId,
        async (lease) => {
          await this.ensureChained(lease);
          const current = await this.entries.findOne({ _id: entryId });
          if (!current) return this.success(undefined);
          const parentId = current.parentId ?? null;
          this.guard(lease);
          await this.entries.updateMany({ threadId, parentId: entryId }, { $set: { parentId } });
          if (lease.thread.activeLeafId === entryId) {
            await this.commit(lease, { $set: { activeLeafId: parentId } });
            lease.thread = { ...lease.thread, activeLeafId: parentId };
          }
          this.guard(lease);
          await this.entries.deleteOne({ _id: entryId });
          return this.success(undefined);
        },
        {
          missing: async () => {
            await this.entries.deleteOne({ _id: entryId });
            return this.success(undefined);
          },
        }
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.emptyThread(threadId), () => ({
      type: 'thread-cleared',
      threadId,
    }));
  }

  /** Deletes the thread's entries and its leaf under its write lease, so no append lands between */
  private async emptyThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      return await this.underLease(
        threadId,
        async (lease) => {
          this.guard(lease);
          await this.entries.deleteMany({ threadId });
          await this.commit(lease, { $set: { activeLeafId: null, chained: true } }, true);
          return this.success(undefined);
        },
        {
          missing: async () => {
            await this.entries.deleteMany({ threadId });
            return this.success(undefined);
          },
        }
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }
}
