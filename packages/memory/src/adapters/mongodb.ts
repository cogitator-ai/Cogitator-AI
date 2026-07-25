import type {
  Thread,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryResult,
  MongoDBAdapterConfig,
  MemoryProvider,
} from '@cogitator-ai/types';
import { BaseMemoryAdapter } from './base';

interface MongoClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  db(name?: string): Db;
}

interface Db {
  collection<T = Document>(name: string): Collection<T>;
}

interface Collection<T = Document> {
  createIndex(keys: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<string>;
  insertOne(doc: T): Promise<{ insertedId: unknown }>;
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>): Cursor<T>;
  updateOne(
    filter: Record<string, unknown>,
    update: { $set: Partial<T> }
  ): Promise<{ modifiedCount: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
}

interface Cursor<T> {
  sort(sort: Record<string, 1 | -1>): Cursor<T>;
  limit(n: number): Cursor<T>;
  toArray(): Promise<T[]>;
}

interface Document {
  _id?: unknown;
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
  private db: Db | null = null;
  private uri: string;
  private database: string;
  private prefix: string;

  constructor(config: MongoDBAdapterConfig) {
    super();
    this.uri = config.uri;
    this.database = config.database ?? 'cogitator';
    this.prefix = config.collectionPrefix ?? 'memory_';
  }

  private get threads(): Collection<ThreadDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<ThreadDoc>(`${this.prefix}threads`);
  }

  private get entries(): Collection<EntryDoc> {
    if (!this.db) throw new Error('Not connected');
    return this.db.collection<EntryDoc>(`${this.prefix}entries`);
  }

  async connect(): Promise<MemoryResult<void>> {
    if (this.client) return this.success(undefined);

    let MongoClient: new (uri: string) => MongoClient;
    try {
      const mongodb = await import('mongodb');
      MongoClient = mongodb.MongoClient as unknown as new (uri: string) => MongoClient;
    } catch {
      return this.failure('mongodb not installed. Run: pnpm add mongodb');
    }

    try {
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.db = this.client.db(this.database);

      await this.threads.createIndex({ agentId: 1 });
      await this.entries.createIndex({ threadId: 1 });
      await this.entries.createIndex({ createdAt: 1 });

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

    const thread: Thread = {
      id: threadId ?? this.generateId('thread'),
      agentId,
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await this.threads.insertOne({
        _id: thread.id,
        agentId: thread.agentId,
        metadata: thread.metadata,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
      return this.success(thread);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return this.failure(`Thread already exists: ${thread.id}`);
      }
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
      createdAt: new Date(),
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
      const filter: Record<string, unknown> = { threadId: options.threadId };

      if (options.before || options.after) {
        filter.createdAt = {};
        if (options.before) (filter.createdAt as Record<string, Date>).$lt = options.before;
        if (options.after) (filter.createdAt as Record<string, Date>).$gt = options.after;
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
