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
} from '@cogitator-ai/types';
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  FindOneAndUpdateOptions,
  MongoClient as DriverClient,
  UpdateFilter,
  WithId,
} from 'mongodb';
import { BaseMemoryAdapter } from './base';
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
  'createIndex' | 'insertOne' | 'updateOne' | 'deleteOne' | 'deleteMany'
> {
  findOne(filter: Filter<T>): Promise<WithId<T> | null>;
  find(filter: Filter<T>): MongoCursor<T>;
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
  };
}

function readThread(doc: WithId<ThreadDoc>): Thread {
  return {
    id: doc._id,
    agentId: doc.agentId,
    metadata: doc.metadata ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
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

export class MongoDBAdapter extends BaseMemoryAdapter {
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
        { $set: { agentId, metadata, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
      const stored = await this.threads.findOne({ _id: id });
      return this.success({
        id,
        agentId,
        metadata,
        createdAt: stored?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getThread(threadId: string): Promise<MemoryResult<Thread | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const doc = await this.threads.findOne({ _id: threadId });
      return this.success(doc ? readThread(doc) : null);
    } catch (err) {
      return this.failure((err as Error).message);
    }
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

    const full: MemoryEntry = {
      ...entry,
      id: this.generateId('entry'),
      createdAt: this.entryTimestamp(entry),
    };

    try {
      const thread = await this.threads.findOneAndUpdate(
        { _id: entry.threadId },
        { $inc: { entrySeq: 1 } },
        { returnDocument: 'after', projection: { entrySeq: 1 } }
      );
      if (!thread) return this.failure(`Thread not found: ${entry.threadId}`);

      await this.entries.insertOne({
        _id: full.id,
        threadId: full.threadId,
        message: full.message,
        toolCalls: full.toolCalls,
        toolResults: full.toolResults,
        tokenCount: full.tokenCount,
        createdAt: full.createdAt,
        metadata: full.metadata,
        seq: thread.entrySeq,
      });
      if (!(await this.threads.findOne({ _id: entry.threadId }))) {
        await this.entries.deleteOne({ _id: full.id });
        return this.failure(`Thread not found: ${entry.threadId}`);
      }
      return this.success(full);
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

      let cursor = this.entries.find(filter).sort({ createdAt: -1, seq: -1 });
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
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }
}
