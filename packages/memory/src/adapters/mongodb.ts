import type {
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  MongoDBAdapterConfig,
  MemoryProvider,
} from '@cogitator-ai/types';
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  MongoClient as DriverClient,
  WithId,
} from 'mongodb';
import { BaseMemoryAdapter } from './base';

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
}

interface MongoDatabase {
  collection<T extends Document>(name: string): MongoCollection<T>;
}

interface MongoClient extends Pick<DriverClient, 'connect' | 'close'> {
  db(name?: string): MongoDatabase;
}

interface ThreadDoc {
  _id: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface EntryDoc {
  _id: string;
  threadId: string;
  message: unknown;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  tokenCount: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export class MongoDBAdapter extends BaseMemoryAdapter {
  readonly provider: MemoryProvider = 'mongodb';

  private client: MongoClient | null = null;
  private db: MongoDatabase | null = null;
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

  async connect(): Promise<MemoryResult<void>> {
    if (this.client) return this.success(undefined);

    let MongoClient: typeof DriverClient;
    try {
      ({ MongoClient } = await import('mongodb'));
    } catch {
      return this.failure('mongodb not installed. Run: pnpm add mongodb');
    }

    try {
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.db = this.client.db(this.database);

      await this.threads.createIndex({ agentId: 1 });
      await this.entries.createIndex({ threadId: 1, createdAt: 1 });

      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async disconnect(): Promise<MemoryResult<void>> {
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
      if (!doc) return this.success(null);

      return this.success({
        id: doc._id,
        agentId: doc.agentId,
        metadata: doc.metadata,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async updateThread(
    threadId: string,
    metadata: Record<string, unknown>
  ): Promise<MemoryResult<Thread>> {
    if (!this.db) return this.failure('Not connected');

    const existing = await this.getThread(threadId);
    if (!existing.success) return existing;
    if (!existing.data) return this.failure(`Thread not found: ${threadId}`);

    const updated: Thread = {
      ...existing.data,
      metadata: { ...existing.data.metadata, ...metadata },
      updatedAt: new Date(),
    };

    try {
      await this.threads.updateOne(
        { _id: threadId },
        { $set: { metadata: updated.metadata, updatedAt: updated.updatedAt } }
      );
      return this.success(updated);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      await this.entries.deleteMany({ threadId });
      await this.threads.deleteOne({ _id: threadId });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryResult<MemoryEntry>> {
    if (!this.db) return this.failure('Not connected');

    const full: MemoryEntry = {
      ...entry,
      id: this.generateId('entry'),
      createdAt: this.nextEntryTimestamp(entry.threadId),
    };

    try {
      await this.entries.insertOne({
        _id: full.id,
        threadId: full.threadId,
        message: full.message,
        toolCalls: full.toolCalls,
        toolResults: full.toolResults,
        tokenCount: full.tokenCount,
        createdAt: full.createdAt,
        metadata: full.metadata,
      });
      return this.success(full);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const filter: Filter<EntryDoc> = { threadId: options.threadId };

      if (options.before || options.after) {
        const createdAt: { $lt?: Date; $gt?: Date } = {};
        if (options.before) createdAt.$lt = options.before;
        if (options.after) createdAt.$gt = options.after;
        filter.createdAt = createdAt;
      }

      let cursor = this.entries.find(filter).sort({ createdAt: -1 });
      if (options.limit) cursor = cursor.limit(options.limit);

      const docs = await cursor.toArray();
      docs.reverse();

      const entries: MemoryEntry[] = docs.map((doc) => ({
        id: doc._id,
        threadId: doc.threadId,
        message: doc.message as MemoryEntry['message'],
        toolCalls: options.includeToolCalls
          ? (doc.toolCalls as MemoryEntry['toolCalls'])
          : undefined,
        toolResults: options.includeToolCalls
          ? (doc.toolResults as MemoryEntry['toolResults'])
          : undefined,
        tokenCount: doc.tokenCount,
        createdAt: doc.createdAt,
        metadata: doc.metadata,
      }));

      return this.success(entries);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>> {
    if (!this.db) return this.failure('Not connected');

    try {
      const doc = await this.entries.findOne({ _id: entryId });
      if (!doc) return this.success(null);

      return this.success({
        id: doc._id,
        threadId: doc.threadId,
        message: doc.message as MemoryEntry['message'],
        toolCalls: doc.toolCalls as MemoryEntry['toolCalls'],
        toolResults: doc.toolResults as MemoryEntry['toolResults'],
        tokenCount: doc.tokenCount,
        createdAt: doc.createdAt,
        metadata: doc.metadata,
      });
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async deleteEntry(entryId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      await this.entries.deleteOne({ _id: entryId });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }

  async clearThread(threadId: string): Promise<MemoryResult<void>> {
    if (!this.db) return this.failure('Not connected');

    try {
      await this.entries.deleteMany({ threadId });
      return this.success(undefined);
    } catch (err) {
      return this.failure((err as Error).message);
    }
  }
}
