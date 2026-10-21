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
type MongoCursor<T extends Document> = Pick<FindCursor<WithId<T>>, 'sort' | 'limit' | 'toArray'>;

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
  | 'aggregate'
  | 'collectionName'
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

/** Ancestors one `$graphLookup` of a path read walks */
const PATH_STEPS = 2000;

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
    const legacy = await this.entries
      .find({ threadId, formatVersion: null }, { projection: { _id: 1 } })
      .sort({ createdAt: 1, seq: 1, _id: 1 })
      .toArray();
    if (legacy.length > 0) {
      await this.entries.bulkWrite(
        legacy.map((entry, i) => ({
          updateOne: {
            filter: { _id: entry._id },
            update: { $set: { parentId: i === 0 ? null : legacy[i - 1]!._id } },
          },
        }))
      );
    }
    return this.threads
      .findOneAndUpdate(
        { _id: threadId, chained: { $ne: true } },
        {
          $set: {
            chained: true,
            ...(legacy.length > 0 && !doc.activeLeafId && { activeLeafId: legacy.at(-1)!._id }),
          },
        },
        { returnDocument: 'after' }
      )
      .then((updated) => updated ?? this.threads.findOne({ _id: threadId }));
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

  private async storeEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');

    const id = this.generateId('entry');
    const createdAt = this.entryTimestamp(entry);
    const { activate, parentId: askedParent, ...fields } = entry;
    const type = fields.type ?? (fields.message?.role === 'tool' ? 'tool_result' : 'message');
    const moves = activate !== false;

    try {
      if (!(await this.chainedThread(entry.threadId))) {
        return this.failure(`Thread not found: ${entry.threadId}`);
      }
      if (
        askedParent &&
        !(await this.entries.findOne({ _id: askedParent, threadId: entry.threadId }))
      ) {
        return this.failure(`Parent entry ${askedParent} is not in thread ${entry.threadId}`);
      }
      const before = await this.threads.findOneAndUpdate(
        { _id: entry.threadId },
        { $inc: { entrySeq: 1 }, ...(moves && { $set: { activeLeafId: id } }) },
        { returnDocument: 'before', projection: { entrySeq: 1, activeLeafId: 1 } }
      );
      if (!before) return this.failure(`Thread not found: ${entry.threadId}`);
      const parentId = askedParent === undefined ? (before.activeLeafId ?? null) : askedParent;
      const seq = (before.entrySeq ?? 0) + 1;

      try {
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
      } catch (err) {
        if (moves) {
          await this.threads.updateOne(
            { _id: entry.threadId, activeLeafId: id },
            { $set: { activeLeafId: before.activeLeafId ?? null } }
          );
        }
        throw err;
      }
      if (!(await this.threads.findOne({ _id: entry.threadId }))) {
        await this.entries.deleteOne({ _id: id });
        return this.failure(`Thread not found: ${entry.threadId}`);
      }
      return this.success({
        ...fields,
        id,
        createdAt,
        type,
        parentId,
        seq,
        formatVersion: MEMORY_ENTRY_FORMAT,
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  /** The path walked back with `$graphLookup`, a bounded number of ancestors at a time */
  override async getPath(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    const limitProblem = this.entryLimitProblem(options.limit);
    if (limitProblem) return this.failure(limitProblem);
    if (!this.db) return this.failure('Not connected');
    const start = await this.pathStart(options);
    if (!start.success) return start;

    try {
      const found: MemoryEntry[] = [];
      let next: string | null = start.data;
      while (next) {
        const [head] = await this.entries
          .aggregate<WithId<EntryDoc> & { ancestors: (WithId<EntryDoc> & { depth: number })[] }>([
            { $match: { _id: next, threadId: options.threadId } },
            {
              $graphLookup: {
                from: this.entries.collectionName,
                startWith: '$parentId',
                connectFromField: 'parentId',
                connectToField: '_id',
                as: 'ancestors',
                depthField: 'depth',
                maxDepth: PATH_STEPS - 1,
                restrictSearchWithMatch: { threadId: options.threadId },
              },
            },
          ])
          .toArray();
        if (!head) break;
        const { ancestors, ...first } = head;
        const walked = [first, ...ancestors.sort((a, b) => a.depth - b.depth)];
        for (const doc of walked) {
          if (!entryTypeWanted(doc.type ?? undefined, options.types)) continue;
          found.push(readEntry(doc, options.includeToolCalls === true));
          if (options.limit && found.length >= options.limit) return this.success(found.reverse());
        }
        const oldest = walked.at(-1)!;
        next = walked.length < PATH_STEPS ? null : (oldest.parentId ?? null);
      }
      return this.success(found.reverse());
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  protected async setActiveLeaf(
    threadId: string,
    leafId: string | null
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');
    try {
      const doc = await this.threads.findOneAndUpdate(
        { _id: threadId },
        { $set: { activeLeafId: leafId } },
        { returnDocument: 'after' }
      );
      return doc ? this.success(readThread(doc)) : this.failure(`Thread not found: ${threadId}`);
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

  private async removeEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const entry = await this.entries.findOne({ _id: entryId });
      if (!entry) return this.success(undefined);
      await this.chainedThread(entry.threadId);
      const current = (await this.entries.findOne({ _id: entryId })) ?? entry;
      const parentId = current.parentId ?? null;
      await this.entries.updateMany(
        { threadId: current.threadId, parentId: entryId },
        { $set: { parentId } }
      );
      await this.threads.updateOne(
        { _id: current.threadId, activeLeafId: entryId },
        { $set: { activeLeafId: parentId } }
      );
      await this.entries.deleteOne({ _id: entryId });
      return this.success(undefined);
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

  private async emptyThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      await this.entries.deleteMany({ threadId });
      await this.threads.updateOne(
        { _id: threadId },
        { $set: { activeLeafId: null, chained: true } }
      );
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }
}
