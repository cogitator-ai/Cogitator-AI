import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  MongoClient as DriverClient,
  MongoClientOptions,
  WithId,
} from 'mongodb';
import { MongoDBAdapter } from '../adapters/mongodb';
import type { Message } from '@cogitator-ai/types';

interface StoredDoc extends Document {
  _id: string;
}

type CursorSurface = Pick<FindCursor<WithId<StoredDoc>>, 'sort' | 'limit' | 'toArray'>;
type CollectionSurface = Pick<
  Collection<StoredDoc>,
  'createIndex' | 'insertOne' | 'updateOne' | 'deleteOne' | 'deleteMany'
> & {
  findOne(filter: Filter<StoredDoc>): Promise<WithId<StoredDoc> | null>;
  find(filter: Filter<StoredDoc>): CursorSurface;
};
type ClientSurface = Pick<DriverClient, 'connect' | 'close'> & {
  db(name?: string): { collection(name: string): CollectionSurface };
};

const deleted = { acknowledged: true, deletedCount: 1 };

const mockCollection = {
  createIndex: vi.fn<CollectionSurface['createIndex']>().mockResolvedValue('index_name'),
  insertOne: vi
    .fn<CollectionSurface['insertOne']>()
    .mockResolvedValue({ acknowledged: true, insertedId: 'test-id' }),
  findOne: vi.fn<CollectionSurface['findOne']>(),
  find: vi.fn<CollectionSurface['find']>(),
  updateOne: vi.fn<CollectionSurface['updateOne']>().mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  }),
  deleteOne: vi.fn<CollectionSurface['deleteOne']>().mockResolvedValue(deleted),
  deleteMany: vi
    .fn<CollectionSurface['deleteMany']>()
    .mockResolvedValue({ ...deleted, deletedCount: 5 }),
} satisfies CollectionSurface;

const mockDb = {
  collection: vi.fn<(name: string) => CollectionSurface>().mockReturnValue(mockCollection),
} satisfies ReturnType<ClientSurface['db']>;

const mockClient = {
  connect: vi.fn<ClientSurface['connect']>(function (this: DriverClient) {
    return Promise.resolve(this);
  }),
  close: vi.fn<ClientSurface['close']>().mockResolvedValue(undefined),
  db: vi.fn<ClientSurface['db']>().mockReturnValue(mockDb),
} satisfies ClientSurface;

function cursorOver(docs: WithId<StoredDoc>[]) {
  return {
    sort: vi.fn<CursorSurface['sort']>().mockReturnThis(),
    limit: vi.fn<CursorSurface['limit']>().mockReturnThis(),
    toArray: vi.fn<CursorSurface['toArray']>().mockResolvedValue(docs),
  } satisfies CursorSurface;
}

const clientOptions: Array<MongoClientOptions | undefined> = [];
const { BSON } = await vi.importActual<typeof import('mongodb')>('mongodb');

vi.mock('mongodb', () => {
  class MongoClient {
    constructor(_uri: string, options?: MongoClientOptions) {
      clientOptions.push(options);
    }
    connect = mockClient.connect;
    close = mockClient.close;
    db = mockClient.db;
  }
  return { MongoClient };
});

describe('the mocked mongodb driver', () => {
  it('only stubs methods the real mongodb driver has', async () => {
    const real = await vi.importActual<typeof import('mongodb')>('mongodb');
    const prototypes: [string, object, object][] = [
      ['MongoClient', real.MongoClient.prototype, mockClient],
      ['Db', real.Db.prototype, mockDb],
      ['Collection', real.Collection.prototype, mockCollection],
      ['FindCursor', real.FindCursor.prototype, cursorOver([])],
    ];
    for (const [name, prototype, mock] of prototypes) {
      for (const method of Object.keys(mock)) {
        expect(typeof Reflect.get(prototype, method), `${name}.${method}`).toBe('function');
      }
    }
  });
});

describe('MongoDBAdapter', () => {
  let adapter: MongoDBAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCollection.find.mockReturnValue(cursorOver([]));
    mockCollection.findOne.mockResolvedValue(null);

    adapter = new MongoDBAdapter({
      provider: 'mongodb',
      uri: 'mongodb://localhost:27017',
      database: 'testdb',
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects and creates indexes', async () => {
      const newAdapter = new MongoDBAdapter({
        provider: 'mongodb',
        uri: 'mongodb://localhost:27017',
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockClient.connect).toHaveBeenCalled();
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ agentId: 1 });
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ threadId: 1, createdAt: 1 });
    });

    it('uses default database name', async () => {
      const newAdapter = new MongoDBAdapter({
        provider: 'mongodb',
        uri: 'mongodb://localhost:27017',
      });

      await newAdapter.connect();

      expect(mockClient.db).toHaveBeenCalledWith('cogitator');
    });

    it('uses custom database name', async () => {
      vi.clearAllMocks();
      const newAdapter = new MongoDBAdapter({
        provider: 'mongodb',
        uri: 'mongodb://localhost:27017',
        database: 'custom_db',
      });

      await newAdapter.connect();

      expect(mockClient.db).toHaveBeenCalledWith('custom_db');
    });

    it('uses custom collection prefix', async () => {
      vi.clearAllMocks();
      const newAdapter = new MongoDBAdapter({
        provider: 'mongodb',
        uri: 'mongodb://localhost:27017',
        collectionPrefix: 'custom_',
      });

      await newAdapter.connect();

      expect(mockDb.collection).toHaveBeenCalledWith('custom_threads');
      expect(mockDb.collection).toHaveBeenCalledWith('custom_entries');
    });

    it('disconnects and closes client', async () => {
      await adapter.disconnect();

      expect(mockClient.close).toHaveBeenCalled();
    });

    it('handles multiple connect calls', async () => {
      const result = await adapter.connect();

      expect(result.success).toBe(true);
    });
  });

  describe('thread operations', () => {
    it('creates a thread', async () => {
      const result = await adapter.createThread('agent1', { foo: 'bar' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^thread_/);
        expect(result.data.agentId).toBe('agent1');
        expect(result.data.metadata).toEqual({ foo: 'bar' });
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: expect.stringMatching(/^thread_/) },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({ createdAt: expect.any(Date) }),
        }),
        { upsert: true }
      );
    });

    it('creates thread with custom id', async () => {
      const result = await adapter.createThread('agent1', {}, 'custom-thread-id');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('custom-thread-id');
      }
    });

    it('gets a thread', async () => {
      const now = new Date();
      mockCollection.findOne.mockResolvedValueOnce({
        _id: 'thread_123',
        agentId: 'agent1',
        metadata: { key: 'value' },
        createdAt: now,
        updatedAt: now,
      });

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('thread_123');
        expect(result.data?.agentId).toBe('agent1');
        expect(result.data?.createdAt).toBe(now);
      }
      expect(mockCollection.findOne).toHaveBeenCalledWith({ _id: 'thread_123' });
    });

    it('returns null for non-existent thread', async () => {
      mockCollection.findOne.mockResolvedValueOnce(null);

      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const now = new Date();
      mockCollection.findOne.mockResolvedValueOnce({
        _id: 'thread_123',
        agentId: 'agent1',
        metadata: { a: 1 },
        createdAt: now,
        updatedAt: now,
      });

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'thread_123' },
        { $set: expect.objectContaining({ metadata: { a: 1, b: 2 } }) }
      );
    });

    it('returns error for updating non-existent thread', async () => {
      mockCollection.findOne.mockResolvedValueOnce(null);

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread and its entries', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({ threadId: 'thread_123' });
      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: 'thread_123' });
    });
  });

  describe('entry operations', () => {
    it('adds an entry', async () => {
      const message: Message = { role: 'user', content: 'Hello' };
      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message,
        tokenCount: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^entry_/);
        expect(result.data.message).toEqual(message);
        expect(result.data.tokenCount).toBe(10);
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }
    });

    it('adds entry with tool calls', async () => {
      const message: Message = { role: 'assistant', content: 'Running tool...' };
      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message,
        tokenCount: 15,
        toolCalls: [{ id: 'call_1', name: 'test_tool', arguments: { x: 1 } }],
        toolResults: [{ callId: 'call_1', name: 'test_tool', result: { success: true } }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.toolCalls).toHaveLength(1);
        expect(result.data.toolResults).toHaveLength(1);
      }
    });

    it('gets entries for thread', async () => {
      const now = new Date();
      mockCollection.find.mockReturnValueOnce(
        cursorOver([
          {
            _id: 'entry_123',
            threadId: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tokenCount: 10,
            createdAt: now,
          },
        ])
      );

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('entry_123');
      }
    });

    it('gets entries with time filter', async () => {
      const cursor = cursorOver([]);
      mockCollection.find.mockReturnValueOnce(cursor);

      const before = new Date('2024-12-31');
      const after = new Date('2024-01-01');

      await adapter.getEntries({
        threadId: 'thread_123',
        before,
        after,
      });

      expect(mockCollection.find).toHaveBeenCalledWith({
        threadId: { $eq: 'thread_123' },
        createdAt: {
          $lt: before,
          $gt: after,
        },
      });
    });

    it('gets entries with limit', async () => {
      const cursor = cursorOver([]);
      mockCollection.find.mockReturnValueOnce(cursor);

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      expect(cursor.limit).toHaveBeenCalledWith(5);
    });

    it('excludes tool calls when not requested', async () => {
      const now = new Date();
      mockCollection.find.mockReturnValueOnce(
        cursorOver([
          {
            _id: 'entry_123',
            threadId: 'thread_123',
            message: { role: 'assistant', content: 'Done' },
            toolCalls: [{ id: 'call_1' }],
            toolResults: [{ toolCallId: 'call_1' }],
            tokenCount: 10,
            createdAt: now,
          },
        ])
      );

      const result = await adapter.getEntries({
        threadId: 'thread_123',
        includeToolCalls: false,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].toolCalls).toBeUndefined();
        expect(result.data[0].toolResults).toBeUndefined();
      }
    });

    it('includes tool calls when requested', async () => {
      const now = new Date();
      mockCollection.find.mockReturnValueOnce(
        cursorOver([
          {
            _id: 'entry_123',
            threadId: 'thread_123',
            message: { role: 'assistant', content: 'Done' },
            toolCalls: [{ id: 'call_1' }],
            toolResults: [{ toolCallId: 'call_1' }],
            tokenCount: 10,
            createdAt: now,
          },
        ])
      );

      const result = await adapter.getEntries({
        threadId: 'thread_123',
        includeToolCalls: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].toolCalls).toBeDefined();
        expect(result.data[0].toolResults).toBeDefined();
      }
    });

    it('gets single entry', async () => {
      const now = new Date();
      mockCollection.findOne.mockResolvedValueOnce({
        _id: 'entry_123',
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 10,
        createdAt: now,
        metadata: { source: 'test' },
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('entry_123');
        expect(result.data?.metadata).toEqual({ source: 'test' });
      }
    });

    it('returns null for non-existent entry', async () => {
      mockCollection.findOne.mockResolvedValueOnce(null);

      const result = await adapter.getEntry('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('deletes entry', async () => {
      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: 'entry_123' });
    });

    it('clears thread entries', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({ threadId: 'thread_123' });
    });
  });

  describe('error handling', () => {
    it('returns error when not connected', async () => {
      const disconnectedAdapter = new MongoDBAdapter({
        provider: 'mongodb',
        uri: 'mongodb://localhost:27017',
      });

      const result = await disconnectedAdapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });

    it('handles connection errors', async () => {
      mockClient.connect.mockRejectedValueOnce(new Error('Connection refused'));

      const newAdapter = new MongoDBAdapter({
        provider: 'mongodb',
        uri: 'mongodb://invalid:27017',
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Connection refused');
      }
    });

    it('handles upsert errors', async () => {
      mockCollection.updateOne.mockRejectedValueOnce(new Error('Write conflict'));

      const result = await adapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Write conflict');
      }
    });

    it('handles query errors', async () => {
      mockCollection.findOne.mockRejectedValueOnce(new Error('Query timeout'));

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Query timeout');
      }
    });
  });

  describe('connection failures', () => {
    it('leaves the adapter disconnected after a failed connect, so the next connect retries', async () => {
      const fresh = new MongoDBAdapter({ provider: 'mongodb', uri: 'mongodb://down:27017' });
      vi.clearAllMocks();
      mockClient.connect
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const first = await fresh.connect();
      const second = await fresh.connect();

      expect(first).toEqual({ success: false, error: 'connect ECONNREFUSED' });
      expect(second).toEqual({ success: false, error: 'connect ECONNREFUSED' });
      expect(mockClient.connect).toHaveBeenCalledTimes(2);
      expect(mockClient.close).toHaveBeenCalledTimes(2);

      expect((await fresh.connect()).success).toBe(true);
      expect((await fresh.getThread('thread_1')).success).toBe(true);
      await fresh.disconnect();
    });

    it('closes the client when the indexes cannot be built', async () => {
      const fresh = new MongoDBAdapter({ provider: 'mongodb', uri: 'mongodb://localhost:27017' });
      mockCollection.createIndex.mockRejectedValueOnce(new Error('not authorized'));

      const result = await fresh.connect();

      expect(result).toEqual({ success: false, error: 'not authorized' });
      expect(mockClient.close).toHaveBeenCalledTimes(1);
      expect(await fresh.getThread('thread_1')).toEqual({
        success: false,
        error: 'Not connected',
      });
    });
  });

  describe('stored documents', () => {
    /** What the driver writes: BSON serialized with the client's or the operation's `ignoreUndefined`. */
    function asStored(doc: Document, operation?: { ignoreUndefined?: boolean }): Document {
      const ignoreUndefined =
        operation?.ignoreUndefined ?? clientOptions.at(-1)?.ignoreUndefined ?? false;
      return BSON.deserialize(BSON.serialize(doc, { ignoreUndefined }));
    }

    it('keeps fields the caller left undefined absent instead of storing null', async () => {
      const stored = new Map<string, WithId<StoredDoc>>();
      mockCollection.insertOne.mockImplementationOnce(async (doc, options) => {
        const id = String(doc._id);
        stored.set(id, { ...asStored(doc, options), _id: id });
        return { acknowledged: true, insertedId: id };
      });
      mockCollection.findOne.mockImplementationOnce(
        async (filter) => stored.get(String(filter._id)) ?? null
      );

      const written = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello', name: undefined },
        toolCalls: undefined,
        tokenCount: 2,
      });
      if (!written.success) throw new Error(written.error);
      const doc = stored.get(written.data.id);
      const read = await adapter.getEntry(written.data.id);

      expect(doc).toBeDefined();
      expect(Object.keys(doc ?? {})).not.toContain('toolCalls');
      expect(Object.keys(doc ?? {})).not.toContain('metadata');
      expect(read.success && read.data).toEqual({
        id: written.data.id,
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 2,
        createdAt: written.data.createdAt,
      });
    });

    it('keeps undefined thread metadata values absent', async () => {
      await adapter.createThread('agent1', { topic: 'dinner', channel: undefined }, 'thread_meta');

      const [, update, options] = mockCollection.updateOne.mock.calls[0] ?? [];
      const set = update && '$set' in update ? update.$set : undefined;
      const stored = asStored({ ...set }, options);

      expect(stored.metadata).toEqual({ topic: 'dinner' });
    });

    it('reads documents an earlier version stored with null optional fields as absent', async () => {
      const now = new Date();
      const legacy: WithId<StoredDoc> = {
        _id: 'entry_legacy',
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello', name: null, toolCallId: null },
        toolCalls: null,
        toolResults: null,
        tokenCount: 2,
        createdAt: now,
        metadata: null,
      };
      mockCollection.findOne.mockResolvedValueOnce(legacy);
      mockCollection.find.mockReturnValueOnce(cursorOver([legacy]));

      const single = await adapter.getEntry('entry_legacy');
      const listed = await adapter.getEntries({ threadId: 'thread_123', includeToolCalls: true });
      const expected = {
        id: 'entry_legacy',
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 2,
        createdAt: now,
      };

      expect(single.success && single.data).toEqual(expected);
      expect(listed.success && listed.data).toEqual([expected]);
    });
  });

  describe('provider', () => {
    it('returns mongodb as provider', () => {
      expect(adapter.provider).toBe('mongodb');
    });
  });
});
