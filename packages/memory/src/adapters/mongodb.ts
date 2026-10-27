import type {
  ListThreadsOptions,
  Thread,
  ThreadPage,
  MemoryEntity,
  MemoryEntityFilter,
  MemoryEntry,
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemFilter,
  MemoryItemKind,
  MemoryItemStatus,
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
  MemoryFileAdapter,
  MemoryFileFilter,
  MemoryFileVersion,
  EntryRedaction,
  MemoryFileHeadFilter,
} from '@cogitator-ai/types';
import {
  CONVERSATION_ENTRY_TYPES,
  MEMORY_ENTRY_FORMAT,
  MEMORY_FILE_CONFLICT,
} from '@cogitator-ai/types';
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
import { entityNames } from '../memory-items';
import { byFileVersion, fileKeyOf, matchesFileFilter, fileHeads } from '../memory-files';

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
  | 'replaceOne'
  | 'countDocuments'
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
  command(command: Document): Promise<Document>;
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
  /** Entries deletes took out of the tree lately, see {@link RemovedEntry} */
  removed?: RemovedEntry[] | null;
}

/**
 * An entry a delete took out of the thread's tree. The delete records it on the thread, fenced by
 * its lease, before it touches any entry: from then on no writer hangs an entry under it or makes
 * it the leaf, even while it still exists, and every writer that takes the lease finishes the
 * delete (its children moved to `parentId`, or further up past entries removed too, and the
 * entry gone). So a delete whose writes land late, after its lease ran out, leaves nothing that
 * points at the entry. Records are kept for {@link REMOVED_KEPT_MS}, so writes that land late are
 * repaired too, and a path read follows them past a parent that is already gone.
 */
interface RemovedEntry {
  id: string;
  parentId: string | null;
  at: Date;
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

/**
 * A memory item: the fields its filters read at the top, beside the item whole. Dates are BSON
 * dates, so they come back as dates, and a field the item does not have is absent, not null.
 */
interface ItemDoc {
  _id: string;
  agentId: string;
  kind: MemoryItemKind;
  status: MemoryItemStatus;
  slot?: string;
  entityId?: string;
  userId?: string;
  projectId?: string;
  threadId?: string;
  recordedAt: Date;
  expiredAt?: Date;
  item: MemoryItem;
}

/** The fields of an item's scope a document keeps at the top */
const SCOPE_FIELDS = ['userId', 'projectId', 'threadId'] as const;

/** An entity with every name of it normalized in `names`, which entities are found by */
interface EntityDoc {
  _id: string;
  agentId: string;
  names: string[];
  entity: MemoryEntity;
}

/** The document of `item` but its `_id`, which a replace by id keeps */
function itemDoc(item: MemoryItem): Omit<ItemDoc, '_id'> {
  return {
    agentId: item.scope.agentId,
    kind: item.kind,
    status: item.status,
    ...(item.slot !== undefined && { slot: item.slot }),
    ...(item.entityId !== undefined && { entityId: item.entityId }),
    ...(item.scope.userId !== undefined && { userId: item.scope.userId }),
    ...(item.scope.projectId !== undefined && { projectId: item.scope.projectId }),
    ...(item.scope.threadId !== undefined && { threadId: item.scope.threadId }),
    recordedAt: item.recordedAt,
    ...(item.expiredAt !== undefined && { expiredAt: item.expiredAt }),
    item,
  };
}

/**
 * The batches `filter` finds versions in: of its agent, ids and paths, and holding a version of
 * a scope it sees (`visibleTo`) or of its exact `scope`, so a reader of one user's files does
 * not fetch every other user's. Versions are filtered again in process.
 */
function fileBatchQuery(filter: MemoryFileFilter): Filter<FileBatchDoc> {
  const scoped: Record<string, unknown> = {};
  for (const field of ['userId', 'projectId', 'threadId'] as const) {
    const seen = filter.visibleTo?.[field];
    const exact = filter.scope?.[field];
    if (filter.scope) {
      scoped[`scope.${field}`] = exact === undefined ? { $exists: false } : exact;
    } else if (filter.visibleTo) {
      scoped[`scope.${field}`] = seen === undefined ? { $exists: false } : { $in: [null, seen] };
    }
  }
  return {
    agentIds: filter.agentId,
    ...(filter.ids && { ids: { $in: filter.ids } }),
    ...(filter.paths && { paths: { $in: filter.paths } }),
    ...(filter.prefix !== undefined &&
      !filter.paths && {
        paths: { $regex: `^${filter.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      }),
    ...(Object.keys(scoped).length > 0 && {
      versions: { $elemMatch: { 'scope.agentId': filter.agentId, ...scoped } },
    }),
  } as Filter<FileBatchDoc>;
}

/**
 * The versions one change added, kept in one document so a reader sees all of them or none,
 * beside the fields its filters read
 */
interface FileBatchDoc {
  _id: string;
  agentIds: string[];
  ids: string[];
  paths: string[];
  versions: MemoryFileVersion[];
}

/**
 * A place a file version took: its scope and path, and its sequence, with the batch that took it
 * and when, so a place a writer took and never published is let go again
 */
interface FilePlaceDoc {
  _id: string;
  batchId: string;
  versionId: string;
  at: Date;
}

/** How long a place may wait for its batch before it is taken as left behind */
const ORPHAN_PLACE_MS = 60_000;

/** The id of the place `version` takes: its scope, path and sequence */
function filePlaceOf(version: MemoryFileVersion): string {
  return `${fileKeyOf(version.scope, version.path)}#${version.sequence}`;
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

/** First seen first, then by id, the order entities are found in */
function byFirstSeen(a: MemoryEntity, b: MemoryEntity): number {
  return (
    a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** An entry as a path walk reads it: no content, only where it hangs and what it is */
type EntrySkeleton = Pick<WithId<EntryDoc>, '_id' | 'parentId' | 'type' | 'createdAt'>;

const SKELETON = { _id: 1, parentId: 1, type: 1, createdAt: 1 } as const;

/** Entries written before trees one write of the chaining links */
const CHAIN_BATCH = 500;

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

/** How long a thread keeps the record of an entry a delete removed */
const REMOVED_KEPT_MS = 6 * LEASE_MS;

/** The most records of removed entries a thread keeps */
const REMOVED_KEPT = 1000;

const LEASE_FIRST_PAUSE_MS = 2;
const LEASE_MAX_PAUSE_MS = 50;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where a reference to `id` leads once the removed entries are gone: up through their parents to
 * the first entry not removed, null for the root or a cycle
 */
function survivor(
  removed: readonly RemovedEntry[] | null | undefined,
  id: string | null
): string | null {
  if (!removed?.length) return id;
  const parents = new Map(removed.map((entry) => [entry.id, entry.parentId]));
  const seen = new Set<string>();
  let current = id;
  while (current !== null && parents.has(current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return current;
}

function isRemoved(removed: readonly RemovedEntry[] | null | undefined, id: string): boolean {
  return removed?.some((entry) => entry.id === id) === true;
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

/**
 * Threads and entries in MongoDB, and memory items with their entities in `<prefix>items` and
 * `<prefix>entities`
 */
export class MongoDBAdapter
  extends BranchingMemoryAdapter
  implements MemoryItemAdapter, MemoryFileAdapter
{
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

  private get items(): MongoCollection<ItemDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<ItemDoc>(`${this.prefix}items`);
  }

  private get fileBatches(): MongoCollection<FileBatchDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<FileBatchDoc>(`${this.prefix}file_batches`);
  }

  private get filePlaces(): MongoCollection<FilePlaceDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<FilePlaceDoc>(`${this.prefix}file_places`);
  }

  private get entities(): MongoCollection<EntityDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<EntityDoc>(`${this.prefix}entities`);
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
      const entries = db.collection<EntryDoc>(`${this.prefix}entries`);
      await entries.createIndex({ threadId: 1, createdAt: 1, seq: 1 });
      await entries.createIndex({ threadId: 1, parentId: 1 });
      const items = db.collection<ItemDoc>(`${this.prefix}items`);
      await items.createIndex({ agentId: 1, slot: 1 });
      await items.createIndex({ agentId: 1, entityId: 1 });
      await items.createIndex({ agentId: 1, recordedAt: 1, _id: 1 });
      await items.createIndex({ agentId: 1, userId: 1 });
      const entities = db.collection<EntityDoc>(`${this.prefix}entities`);
      await entities.createIndex({ agentId: 1, names: 1 });
      const fileBatches = db.collection<FileBatchDoc>(`${this.prefix}file_batches`);
      await fileBatches.createIndex({ agentIds: 1 });
      await fileBatches.createIndex({ paths: 1 });
      await fileBatches.createIndex({ ids: 1 });

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

  async healthCheck(): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    try {
      await this.db.command({ ping: 1 });
      return this.success(undefined);
    } catch (err) {
      return this.failure(err instanceof Error ? err.message : String(err));
    }
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
   * thread has none. It walks back from the newest a batch at a time, checking the lease before
   * each, and marks each entry format 1 in the write that links it, so an attempt that loses the
   * lease leaves its progress for the next one.
   */
  private async ensureChained(lease: HeldLease): Promise<void> {
    if (lease.thread.chained) return;
    const unlinked = () =>
      this.entries
        .find({ threadId: lease.threadId, formatVersion: null }, { projection: { _id: 1 } })
        .sort({ createdAt: -1, seq: -1 });
    if (!lease.thread.activeLeafId) {
      const [newest] = await unlinked().limit(1).toArray();
      if (newest) {
        await this.commit(lease, { $set: { activeLeafId: newest._id } });
        lease.thread = { ...lease.thread, activeLeafId: newest._id };
      }
    }
    for (;;) {
      this.guard(lease);
      const batch = await unlinked()
        .limit(CHAIN_BATCH + 1)
        .toArray();
      if (batch.length === 0) break;
      await this.entries.bulkWrite(
        batch.slice(0, CHAIN_BATCH).map((entry, i) => ({
          updateOne: {
            filter: { _id: entry._id, formatVersion: null },
            update: { $set: { parentId: batch[i + 1]?._id ?? null, formatVersion: 1 } },
          },
        }))
      );
      if (batch.length <= CHAIN_BATCH) break;
    }
    await this.commit(lease, { $set: { chained: true } });
    lease.thread = { ...lease.thread, chained: true };
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
   * as the leaf, and a delete is recorded on the thread before it touches an entry, which every
   * later holder finishes (see {@link RemovedEntry}). A write
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
          await this.settleRemoved(lease);
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

  /**
   * Finishes the deletes recorded on the leased thread: moves the children of every removed entry
   * to its surviving ancestor and deletes the entry, again each time, so writes of a delete that
   * land late are repaired. Drops records older than {@link REMOVED_KEPT_MS}.
   */
  private async settleRemoved(lease: HeldLease): Promise<void> {
    const removed = lease.thread.removed ?? [];
    if (removed.length === 0) return;
    const { threadId } = lease;
    this.guard(lease);
    await this.entries.bulkWrite(
      removed.map(({ id }) => ({
        updateMany: {
          filter: { threadId, parentId: id },
          update: { $set: { parentId: survivor(removed, id) } },
        },
      }))
    );
    this.guard(lease);
    await this.entries.deleteMany({ threadId, _id: { $in: removed.map((entry) => entry.id) } });
    const oldest = Math.min(...removed.map((entry) => new Date(entry.at).getTime()));
    if (Date.now() - oldest > REMOVED_KEPT_MS) {
      await this.commit(lease, [
        {
          $set: {
            removed: {
              $filter: {
                input: { $ifNull: ['$removed', []] },
                cond: { $gt: ['$$this.at', { $subtract: ['$$NOW', REMOVED_KEPT_MS] }] },
              },
            },
          },
        },
      ]);
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
    update: UpdateFilter<ThreadDoc> | Document[],
    release = false
  ): Promise<void> {
    const released: UpdateFilter<ThreadDoc> | Document[] = Array.isArray(update)
      ? [...update, { $unset: 'lease' }]
      : { ...update, $unset: { lease: '' as const } };
    const result = await this.threads.updateOne(
      { _id: lease.threadId, 'lease.token': lease.token },
      release ? released : update
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
   * lease is moved under the parent the next attempt finds, inserted again when a clear that took
   * the lease meanwhile deleted it, and taken back when the add fails.
   */
  private async storeEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');

    const named = this.entryIdOf(entry);
    if (!named.success) return named;
    const id = named.data;
    const createdAt = this.entryTimestamp(entry);
    const { activate, parentId: askedParent, id: _asked, ...fields } = entry;
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
          const { removed } = lease.thread;
          const parentId =
            askedParent === undefined
              ? survivor(removed, lease.thread.activeLeafId ?? null)
              : askedParent;
          if (
            askedParent != null &&
            (isRemoved(removed, askedParent) ||
              !(await this.entries.findOne({ _id: askedParent, threadId: entry.threadId })))
          ) {
            return this.failure(`Parent entry ${askedParent} is not in thread ${entry.threadId}`);
          }
          this.guard(lease);
          const moved =
            inserted && (await this.entries.updateOne({ _id: id }, { $set: { parentId } }));
          if (!moved || moved.matchedCount === 0) {
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
   * looks a parent the cursor does not hold up by its id. A parent a delete removed before its
   * children moved leads on to the parent the thread recorded for it.
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
    let current: EntrySkeleton | undefined = await skeleton(startId);
    if (!current) return [];
    const cursor = this.entries
      .find({ threadId, createdAt: { $lte: current.createdAt } }, { projection: SKELETON })
      .sort({ createdAt: -1, seq: -1 })
      .batchSize(SKELETON_BATCH);
    const scanned = new Map<string, EntrySkeleton>();
    const seen = new Set<string>();
    const kept: string[] = [];
    let scanning = true;
    let removed: RemovedEntry[] | undefined;

    try {
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        if (entryTypeWanted(current.type ?? undefined, options.types)) {
          kept.push(current._id);
          if (options.limit && kept.length >= options.limit) break;
        }
        const parentId: string | null | undefined = current.parentId;
        if (!parentId) break;
        current = scanned.get(parentId);
        while (!current && scanning) {
          const next = await cursor.next();
          if (!next) scanning = false;
          else if (next._id === parentId) current = next;
          else scanned.set(next._id, next);
        }
        current ??= await skeleton(parentId);
        if (!current) {
          removed ??= (await this.threads.findOne({ _id: threadId }))?.removed ?? [];
          const resumed = survivor(removed, parentId);
          if (resumed !== null && resumed !== parentId) {
            current = scanned.get(resumed) ?? (await skeleton(resumed));
          }
        }
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
   * thread's when the leaf moves: a delete takes the same lease, so none can slip in between,
   * and one whose writes are still landing has recorded its entry as removed.
   */
  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');
    try {
      return await this.underLease(threadId, async (lease) => {
        await this.ensureChained(lease);
        if (
          leafId !== null &&
          (isRemoved(lease.thread.removed, leafId) ||
            !(await this.entries.findOne({ _id: leafId, threadId })))
        ) {
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

  async redactEntry(
    entryId: string,
    redaction: EntryRedaction
  ): Promise<MemoryResult<MemoryEntry | null>> {
    return this.redactThrough(entryId, redaction, async (entry) => {
      if (!this.db) return this.failure('Not connected');
      try {
        await this.entries.updateOne(
          { _id: entry.id },
          {
            $set: {
              message: entry.message,
              toolCalls: entry.toolCalls,
              toolResults: entry.toolResults,
              tokenCount: entry.tokenCount,
              metadata: entry.metadata,
            },
          }
        );
        return this.success(undefined);
      } catch (err) {
        return this.failure((err as Error).message);
      }
    });
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    return this.reported(await this.removeEntry(entryId), () => ({
      type: 'entry-deleted',
      entryId,
    }));
  }

  /**
   * Splices the entry out of its branch under the thread's write lease: records it as removed on
   * the thread together with the leaf moving to its parent when it was the entry, in one write
   * the lease fences, then moves its children to its parent and deletes it, and gives the lease
   * back in a write it fences too. When that fails the delete starts over, and the next holder of
   * the lease finishes it from the record, also when the entry is already gone (see
   * {@link RemovedEntry}).
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
          if (isRemoved(lease.thread.removed, entryId)) return this.success(undefined);
          const current = await this.entries.findOne({ _id: entryId });
          if (!current) return this.success(undefined);
          const parentId = survivor(lease.thread.removed, current.parentId ?? null);
          const leaf = lease.thread.activeLeafId ?? null;
          const activeLeafId = leaf === entryId ? parentId : leaf;
          await this.commit(lease, [
            {
              $set: {
                activeLeafId: { $literal: activeLeafId },
                removed: {
                  $slice: [
                    {
                      $concatArrays: [
                        { $ifNull: ['$removed', []] },
                        [
                          {
                            id: { $literal: entryId },
                            parentId: { $literal: parentId },
                            at: '$$NOW',
                          },
                        ],
                      ],
                    },
                    -REMOVED_KEPT,
                  ],
                },
              },
            },
          ]);
          lease.thread = {
            ...lease.thread,
            activeLeafId,
            removed: [...(lease.thread.removed ?? []), { id: entryId, parentId, at: new Date() }],
          };
          await this.settleRemoved(lease);
          await this.commit(lease, {}, true);
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

  /**
   * Deletes the thread's entries and its leaf under its write lease, so no append lands between.
   * It deletes only entries numbered up to the thread's count, so if the delete lands late it
   * leaves the entries added after it alone.
   */
  private async emptyThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      return await this.underLease(
        threadId,
        async (lease) => {
          this.guard(lease);
          await this.entries.deleteMany({
            threadId,
            $or: [
              { seq: { $lte: lease.thread.entrySeq ?? 0 } },
              { seq: { $exists: false } },
              { seq: { $type: 'null' } },
            ],
          });
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

  async putItem(item: MemoryItem): Promise<MemoryResult<MemoryItem>> {
    if (!this.db) return this.failure('Not connected');
    try {
      await this.items.replaceOne({ _id: item.id }, itemDoc(item), { upsert: true });
      return this.success(structuredClone(item));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getItem(itemId: string): Promise<MemoryResult<MemoryItem | null>> {
    if (!this.db) return this.failure('Not connected');
    try {
      const doc = await this.items.findOne({ _id: { $eq: itemId } });
      return this.success(doc ? doc.item : null);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Items `filter` finds, filtered in the database, oldest recorded first. An item whose
   * `expiredAt` is still ahead is found without `includeExpired`.
   */
  async findItems(filter: MemoryItemFilter): Promise<MemoryResult<MemoryItem[]>> {
    if (!this.db) return this.failure('Not connected');
    const conditions: Filter<ItemDoc>[] = [{ agentId: { $eq: filter.agentId } }];
    if (filter.ids) conditions.push({ _id: { $in: filter.ids } });
    if (filter.slots) conditions.push({ slot: { $in: filter.slots } });
    if (filter.entityIds) conditions.push({ entityId: { $in: filter.entityIds } });
    if (filter.kinds) conditions.push({ kind: { $in: filter.kinds } });
    if (filter.statuses) conditions.push({ status: { $in: filter.statuses } });
    for (const field of SCOPE_FIELDS) {
      const visible = filter.visibleTo?.[field];
      if (filter.visibleTo !== undefined) {
        conditions.push({
          [field]: visible === undefined ? { $exists: false } : { $in: [visible, null] },
        });
      }
      const exact = filter.scope?.[field];
      if (filter.scope !== undefined) {
        conditions.push({ [field]: exact === undefined ? { $exists: false } : { $eq: exact } });
      }
    }
    if (filter.includeExpired !== true) {
      conditions.push({
        $or: [{ expiredAt: { $exists: false } }, { expiredAt: { $gt: new Date() } }],
      });
    }
    try {
      const docs = await this.items
        .find({ $and: conditions })
        .sort({ recordedAt: 1, _id: 1 })
        .toArray();
      return this.success(docs.map((doc) => doc.item));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteItems(itemIds: string[]): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    if (itemIds.length === 0) return this.success(undefined);
    try {
      await this.items.deleteMany({ _id: { $in: itemIds } });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async countRetrieved(itemIds: string[], at: Date): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    if (itemIds.length === 0) return this.success(undefined);
    try {
      await this.items.updateMany(
        { _id: { $in: [...new Set(itemIds)] } },
        { $inc: { 'item.timesRetrieved': 1 }, $set: { 'item.lastRetrievedAt': new Date(at) } }
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Takes the place of each version (a document whose id is its scope, path and sequence, which
   * a second writer cannot insert again), then adds the versions in one document, so a reader
   * sees all of them or none. When a place is taken already, the places this call took are let
   * go again and nothing is added.
   */
  async putFileVersions(versions: MemoryFileVersion[]): Promise<MemoryResult<MemoryFileVersion[]>> {
    if (!this.db) return this.failure('Not connected');
    if (versions.length === 0) return this.success([]);
    const places = versions.map((version) => filePlaceOf(version));
    if (new Set(places).size !== places.length) return this.failure(MEMORY_FILE_CONFLICT);
    const batchId = `batch_${versions[0]!.id}`;
    let taken = 0;
    try {
      for (const [at, place] of places.entries()) {
        await this.takePlace(place, batchId, versions[at]!.id);
        taken++;
      }
      const held = await this.filePlaces.countDocuments({ _id: { $in: places }, batchId });
      if (held !== places.length) {
        await this.filePlaces.deleteMany({ _id: { $in: places }, batchId });
        return this.failure(MEMORY_FILE_CONFLICT);
      }
      await this.fileBatches.insertOne({
        _id: batchId,
        agentIds: [...new Set(versions.map((version) => version.scope.agentId))],
        ids: versions.map((version) => version.id),
        paths: [...new Set(versions.map((version) => version.path))],
        versions,
      });
      const kept = await this.filePlaces.countDocuments({ _id: { $in: places }, batchId });
      if (kept !== places.length) {
        await this.fileBatches.deleteOne({ _id: batchId });
        await this.filePlaces.deleteMany({ _id: { $in: places }, batchId });
        return this.failure(MEMORY_FILE_CONFLICT);
      }
      return this.success(versions.map((version) => structuredClone(version)));
    } catch (err) {
      await this.filePlaces
        .deleteMany({ _id: { $in: places.slice(0, taken) } })
        .catch(() => undefined);
      return isDuplicateKey(err)
        ? this.failure(MEMORY_FILE_CONFLICT)
        : this.failure((err as Error).message);
    }
  }

  async findFileHeads(filter: MemoryFileHeadFilter): Promise<MemoryResult<MemoryFileVersion[]>> {
    const { place, ...rest } = filter;
    const found = await this.findFileVersions(rest);
    return found.success ? this.success(fileHeads(found.data, place)) : found;
  }

  async findFileVersions(filter: MemoryFileFilter): Promise<MemoryResult<MemoryFileVersion[]>> {
    if (!this.db) return this.failure('Not connected');
    try {
      const batches = await this.fileBatches.find(fileBatchQuery(filter)).toArray();
      return this.success(
        batches
          .flatMap((batch) => batch.versions)
          .filter((version) => matchesFileFilter(version, filter))
          .sort(byFileVersion)
      );
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async withdrawFileVersions(ids: string[], at: Date): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    if (ids.length === 0) return this.success(undefined);
    try {
      await this.fileBatches.updateMany(
        { ids: { $in: ids } },
        { $set: { 'versions.$[version].withdrawn': { at } } },
        { arrayFilters: [{ 'version.id': { $in: ids } }] }
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async redactFileVersions(
    ids: string[],
    redaction: { content: string; sha256: string; at: Date; reason?: string }
  ): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    if (ids.length === 0) return this.success(undefined);
    try {
      await this.fileBatches.updateMany(
        { ids: { $in: ids } },
        {
          $set: {
            'versions.$[version].content': redaction.content,
            'versions.$[version].sha256': redaction.sha256,
            'versions.$[version].redacted': {
              at: redaction.at,
              ...(redaction.reason !== undefined && { reason: redaction.reason }),
            },
          },
        },
        { arrayFilters: [{ 'version.id': { $in: ids } }] }
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Deletes the versions out of their batches in place (`$pull`), so a redaction or another
   * deletion that lands meanwhile is never undone, then lets their places go
   */
  async deleteFileVersions(ids: string[]): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    if (ids.length === 0) return this.success(undefined);
    try {
      const batches = await this.fileBatches.find({ ids: { $in: ids } }).toArray();
      const gone = new Set(ids);
      const dropped = batches.flatMap((batch) =>
        batch.versions.filter((version) => gone.has(version.id))
      );
      await this.fileBatches.updateMany(
        { ids: { $in: ids } },
        { $pull: { versions: { id: { $in: ids } }, ids: { $in: ids } } }
      );
      await this.fileBatches.deleteMany({
        _id: { $in: batches.map((batch) => batch._id) },
        ids: { $size: 0 },
      });
      if (dropped.length > 0) {
        await this.filePlaces.deleteMany({
          _id: { $in: dropped.map((version) => filePlaceOf(version)) },
        });
      }
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /**
   * Takes `place` for version `versionId` of `batchId`. A place another batch took longer than
   * {@link ORPHAN_PLACE_MS} ago and holds no version in, as a writer that died before it
   * published or a deletion that died before it let its places go leave it, is let go and taken
   * again. Any other taken place is a conflict.
   */
  private async takePlace(place: string, batchId: string, versionId: string): Promise<void> {
    try {
      await this.filePlaces.insertOne({ _id: place, batchId, versionId, at: new Date() });
      return;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const held = await this.filePlaces.findOne({ _id: place });
      if (!held || Date.now() - held.at.getTime() < ORPHAN_PLACE_MS) throw err;
      const published = await this.fileBatches.findOne({
        _id: held.batchId,
        ids: held.versionId,
      });
      if (published) throw err;
      await this.filePlaces.deleteOne({ _id: place, batchId: held.batchId });
      await this.filePlaces.insertOne({ _id: place, batchId, versionId, at: new Date() });
    }
  }

  async putEntity(entity: MemoryEntity): Promise<MemoryResult<MemoryEntity>> {
    if (!this.db) return this.failure('Not connected');
    try {
      await this.entities.replaceOne(
        { _id: entity.id },
        { agentId: entity.scope.agentId, names: entityNames(entity), entity },
        { upsert: true }
      );
      return this.success(structuredClone(entity));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /** Entities `filter` finds, first seen first */
  async findEntities(filter: MemoryEntityFilter): Promise<MemoryResult<MemoryEntity[]>> {
    if (!this.db) return this.failure('Not connected');
    const conditions: Filter<EntityDoc>[] = [{ agentId: { $eq: filter.agentId } }];
    if (filter.ids) conditions.push({ _id: { $in: filter.ids } });
    if (filter.names) conditions.push({ names: { $in: filter.names } });
    try {
      const docs = await this.entities.find({ $and: conditions }).toArray();
      return this.success(docs.map((doc) => doc.entity).sort(byFirstSeen));
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEntities(entityIds: string[]): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');
    if (entityIds.length === 0) return this.success(undefined);
    try {
      await this.entities.deleteMany({ _id: { $in: entityIds } });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }
}
