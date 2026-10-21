import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  FindOneAndUpdateOptions,
  MongoClient as DriverClient,
  MongoClientOptions,
  WithId,
} from 'mongodb';
import { MongoDBAdapter } from '../adapters/mongodb';
import type { Message } from '@cogitator-ai/types';

interface StoredDoc extends Document {
  _id: string;
}

type CursorSurface = Pick<
  FindCursor<WithId<StoredDoc>>,
  'sort' | 'limit' | 'batchSize' | 'toArray' | 'next' | 'close'
>;
type CollectionSurface = Pick<
  Collection<StoredDoc>,
  | 'createIndex'
  | 'insertOne'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany'
  | 'bulkWrite'
> & {
  findOne(filter: Filter<StoredDoc>): Promise<WithId<StoredDoc> | null>;
  find(filter: Filter<StoredDoc>, options?: Document): CursorSurface;
  findOneAndUpdate(
    filter: Filter<StoredDoc>,
    update: Document | Document[],
    options: FindOneAndUpdateOptions
  ): Promise<WithId<StoredDoc> | null>;
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
  findOneAndUpdate: vi
    .fn<CollectionSurface['findOneAndUpdate']>()
    .mockResolvedValue({ _id: 'thread_123', entrySeq: 0 } as WithId<StoredDoc>),
  updateOne: vi.fn<CollectionSurface['updateOne']>().mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  }),
  updateMany: vi.fn<CollectionSurface['updateMany']>().mockResolvedValue({
    acknowledged: true,
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0,
    upsertedId: null,
  }),
  deleteOne: vi.fn<CollectionSurface['deleteOne']>().mockResolvedValue(deleted),
  deleteMany: vi
    .fn<CollectionSurface['deleteMany']>()
    .mockResolvedValue({ ...deleted, deletedCount: 5 }),
  bulkWrite: vi.fn<CollectionSurface['bulkWrite']>(),
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
  let position = 0;
  return {
    sort: vi.fn<CursorSurface['sort']>().mockReturnThis(),
    limit: vi.fn<CursorSurface['limit']>().mockReturnThis(),
    batchSize: vi.fn<CursorSurface['batchSize']>().mockReturnThis(),
    toArray: vi.fn<CursorSurface['toArray']>().mockResolvedValue(docs),
    next: vi.fn<CursorSurface['next']>(async () => docs[position++] ?? null),
    close: vi.fn<CursorSurface['close']>().mockResolvedValue(undefined),
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
    mockCollection.findOne.mockReset();
    mockCollection.findOneAndUpdate.mockReset();
    mockCollection.updateOne.mockReset();
    mockCollection.updateOne.mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    });
    mockCollection.find.mockReturnValue(cursorOver([]));
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.findOneAndUpdate.mockResolvedValue({ _id: 'thread_123', entrySeq: 1 });

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
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ agentId: 1, updatedAt: 1, _id: 1 });
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ updatedAt: 1, _id: 1 });
      expect(mockCollection.createIndex).toHaveBeenCalledWith({
        threadId: 1,
        createdAt: 1,
        seq: 1,
      });
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ threadId: 1, parentId: 1 });
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
        chained: true,
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

    it('merges thread metadata in the database, in one atomic update', async () => {
      const now = new Date();
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({
        _id: 'thread_123',
        agentId: 'agent1',
        metadata: { a: 1, b: 2 },
        createdAt: now,
        updatedAt: now,
        entrySeq: 4,
      });

      const result = await adapter.updateThread('thread_123', { b: 2, 'x.y': '$z' });

      expect(result).toEqual({
        success: true,
        data: {
          id: 'thread_123',
          agentId: 'agent1',
          metadata: { a: 1, b: 2 },
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'thread_123' },
        [
          {
            $set: {
              metadata: {
                $mergeObjects: [
                  { $ifNull: ['$metadata', {}] },
                  { $literal: { b: 2, 'x.y': '$z' } },
                ],
              },
              updatedAt: { $literal: expect.any(Date) },
            },
          },
        ],
        { returnDocument: 'after' }
      );
    });

    it('returns error for updating non-existent thread', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce(null);

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes the thread, then its entries', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: 'thread_123' });
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({ threadId: 'thread_123' });
      expect(mockCollection.deleteOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockCollection.deleteMany.mock.invocationCallOrder[0] ?? 0
      );
    });
  });

  describe('entry operations', () => {
    const thread = {
      _id: 'thread_123',
      agentId: 'agent1',
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
      chained: true,
    };

    beforeEach(() => {
      mockCollection.findOne.mockResolvedValue(thread);
    });

    /** The lease token the adapter took on the thread with its `n`th `findOneAndUpdate` */
    function leaseToken(n = 0): string {
      const update = mockCollection.findOneAndUpdate.mock.calls[n]?.[1];
      const token = Array.isArray(update) ? update[0]?.$set?.lease?.token?.$literal : undefined;
      if (typeof token !== 'string') throw new Error('No lease was taken');
      return token;
    }

    it('numbers the entries of a thread in the order they are added, under its write lease', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({
        ...thread,
        entrySeq: 7,
        activeLeafId: 'entry_before',
      });

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 1,
      });

      expect(result.success).toBe(true);
      const [filter, update, options] = mockCollection.findOneAndUpdate.mock.calls[0] ?? [];
      expect(filter).toEqual({
        _id: 'thread_123',
        $or: [{ lease: null }, { $expr: { $lt: ['$lease.until', '$$NOW'] } }],
      });
      expect(update).toEqual([
        {
          $set: {
            lease: { token: { $literal: leaseToken() }, until: { $add: ['$$NOW', 5000] } },
            entrySeq: { $add: [{ $ifNull: ['$entrySeq', 0] }, 1] },
          },
        },
      ]);
      expect(options).toEqual({ returnDocument: 'after' });
      const inserted = mockCollection.insertOne.mock.calls[0]?.[0];
      expect(inserted).toEqual(expect.objectContaining({ seq: 7, parentId: 'entry_before' }));
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'thread_123', 'lease.token': leaseToken() },
        { $set: { activeLeafId: inserted?._id }, $unset: { lease: '' } }
      );
      expect(mockCollection.insertOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockCollection.updateOne.mock.invocationCallOrder[0]!
      );
    });

    it('starts a new root for parentId null, also when the thread has a leaf', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({
        ...thread,
        entrySeq: 2,
        activeLeafId: 'entry_leaf',
      });

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'root' },
        tokenCount: 1,
        parentId: null,
      });

      expect(result.success && result.data.parentId).toBeNull();
      expect(mockCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: null })
      );
    });

    it('waits while another writer holds the lease, then adds', async () => {
      mockCollection.findOneAndUpdate
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...thread, entrySeq: 1 });

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 1,
      });

      expect(result.success).toBe(true);
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
    });

    it('refuses an entry for a thread that does not exist', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce(null);
      mockCollection.findOne.mockResolvedValue(null);

      const result = await adapter.addEntry({
        threadId: 'missing',
        message: { role: 'user', content: 'orphan' },
        tokenCount: 1,
      });

      expect(result).toEqual({ success: false, error: 'Thread not found: missing' });
      expect(mockCollection.insertOne).not.toHaveBeenCalled();
    });

    it('takes the entry back when the thread was deleted while it was added', async () => {
      mockCollection.findOneAndUpdate
        .mockResolvedValueOnce({ ...thread, entrySeq: 1 })
        .mockResolvedValueOnce(null);
      mockCollection.updateOne.mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });
      mockCollection.findOne.mockResolvedValue(null);

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'late' },
        tokenCount: 1,
      });

      expect(result).toEqual({ success: false, error: 'Thread not found: thread_123' });
      const inserted = mockCollection.insertOne.mock.calls[0]?.[0];
      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: inserted?._id });
    });

    it('moves its entry under the leaf it finds after its lease was taken over', async () => {
      mockCollection.findOneAndUpdate
        .mockResolvedValueOnce({ ...thread, entrySeq: 1, activeLeafId: 'entry_a' })
        .mockResolvedValueOnce({ ...thread, entrySeq: 2, activeLeafId: 'entry_b' });
      mockCollection.updateOne.mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 1,
      });

      expect(result.success && [result.data.parentId, result.data.seq]).toEqual(['entry_b', 1]);
      const inserted = mockCollection.insertOne.mock.calls[0]?.[0];
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: inserted?._id },
        { $set: { parentId: 'entry_b' } }
      );
      expect(mockCollection.updateOne).toHaveBeenLastCalledWith(
        { _id: 'thread_123', 'lease.token': leaseToken(1) },
        { $set: { activeLeafId: inserted?._id }, $unset: { lease: '' } }
      );
    });

    /** The `removed` stage of the pipeline update `n` of the thread, as a delete records it */
    function recordedRemoval(n = 0): unknown {
      const update = mockCollection.updateOne.mock.calls[n]?.[1];
      return Array.isArray(update) ? update[0]?.$set : undefined;
    }

    it('records a delete on the thread, fenced by the lease, before it touches any entry', async () => {
      const entry = { _id: 'entry_123', threadId: 'thread_123', parentId: 'entry_parent' };
      mockCollection.findOne.mockResolvedValue(entry);
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({
        ...thread,
        activeLeafId: 'entry_123',
      });

      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockCollection.updateOne.mock.calls[0]?.[0]).toEqual({
        _id: 'thread_123',
        'lease.token': leaseToken(),
      });
      expect(recordedRemoval()).toEqual({
        activeLeafId: { $literal: 'entry_parent' },
        removed: {
          $slice: [
            {
              $concatArrays: [
                { $ifNull: ['$removed', []] },
                [
                  {
                    id: { $literal: 'entry_123' },
                    parentId: { $literal: 'entry_parent' },
                    at: '$$NOW',
                  },
                ],
              ],
            },
            -1000,
          ],
        },
      });
      expect(mockCollection.bulkWrite).toHaveBeenCalledWith([
        {
          updateMany: {
            filter: { threadId: 'thread_123', parentId: 'entry_123' },
            update: { $set: { parentId: 'entry_parent' } },
          },
        },
      ]);
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({
        threadId: 'thread_123',
        _id: { $in: ['entry_123'] },
      });
      const [recorded, released] = mockCollection.updateOne.mock.invocationCallOrder;
      const [children] = mockCollection.bulkWrite.mock.invocationCallOrder;
      const [removed] = mockCollection.deleteMany.mock.invocationCallOrder;
      expect(recorded).toBeLessThan(children!);
      expect(children).toBeLessThan(removed!);
      expect(removed).toBeLessThan(released!);
      expect(mockCollection.deleteOne).not.toHaveBeenCalled();
    });

    it('finishes a delete another writer recorded before it does anything else', async () => {
      const removed = [
        { id: 'entry_late', parentId: 'entry_gone_too', at: new Date() },
        { id: 'entry_gone_too', parentId: 'entry_root', at: new Date() },
      ];
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({
        ...thread,
        entrySeq: 3,
        activeLeafId: 'entry_root',
        removed,
      });

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'after' },
        tokenCount: 1,
      });

      expect(result.success && result.data.parentId).toBe('entry_root');
      expect(mockCollection.bulkWrite).toHaveBeenCalledWith([
        {
          updateMany: {
            filter: { threadId: 'thread_123', parentId: 'entry_late' },
            update: { $set: { parentId: 'entry_root' } },
          },
        },
        {
          updateMany: {
            filter: { threadId: 'thread_123', parentId: 'entry_gone_too' },
            update: { $set: { parentId: 'entry_root' } },
          },
        },
      ]);
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({
        threadId: 'thread_123',
        _id: { $in: ['entry_late', 'entry_gone_too'] },
      });
      expect(mockCollection.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockCollection.insertOne.mock.invocationCallOrder[0]!
      );
    });

    it('refuses to check out or append under an entry a delete recorded, though it still exists', async () => {
      const entry = {
        _id: 'entry_late',
        threadId: 'thread_123',
        message: { role: 'user', content: 'late' },
        tokenCount: 1,
        createdAt: new Date(0),
      };
      const leased = {
        ...thread,
        activeLeafId: 'entry_root',
        removed: [{ id: 'entry_late', parentId: 'entry_root', at: new Date() }],
      };
      mockCollection.findOne.mockResolvedValue(entry);
      mockCollection.findOneAndUpdate.mockResolvedValue(leased);

      const checkedOut = await adapter.checkout('thread_123', 'entry_late');
      const appended = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'x' },
        tokenCount: 1,
        parentId: 'entry_late',
      });

      expect(checkedOut).toEqual({
        success: false,
        error: 'Entry entry_late is not in thread thread_123',
      });
      expect(appended).toEqual({
        success: false,
        error: 'Parent entry entry_late is not in thread thread_123',
      });
      expect(mockCollection.insertOne).not.toHaveBeenCalled();
    });

    const unmatched = {
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    } as const;

    it('inserts its entry again when a clear deleted it while its publish was held up', async () => {
      mockCollection.findOneAndUpdate
        .mockResolvedValueOnce({ ...thread, entrySeq: 1, activeLeafId: 'entry_a' })
        .mockResolvedValueOnce({ ...thread, entrySeq: 2, activeLeafId: null });
      mockCollection.updateOne
        .mockResolvedValueOnce(unmatched)
        .mockResolvedValueOnce(unmatched)
        .mockResolvedValueOnce(unmatched);

      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message: { role: 'user', content: 'Hello' },
        tokenCount: 1,
      });

      expect(result.success && result.data.parentId).toBeNull();
      const [first, second] = mockCollection.insertOne.mock.calls.map(([doc]) => doc);
      expect(first).toMatchObject({ parentId: 'entry_a', seq: 1 });
      expect(second).toMatchObject({ _id: first?._id, parentId: null, seq: 1 });
      expect(mockCollection.updateOne).toHaveBeenLastCalledWith(
        { _id: 'thread_123', 'lease.token': leaseToken(1) },
        { $set: { activeLeafId: first?._id }, $unset: { lease: '' } }
      );
    });

    it('finishes a delete from its record when the delete lost the lease after the entry went', async () => {
      const entry = { _id: 'entry_123', threadId: 'thread_123', parentId: 'entry_parent' };
      const record = { id: 'entry_123', parentId: 'entry_parent', at: new Date() };
      mockCollection.findOne.mockResolvedValueOnce(entry).mockResolvedValue(entry);
      mockCollection.findOneAndUpdate
        .mockResolvedValueOnce({ ...thread, activeLeafId: 'entry_123' })
        .mockResolvedValueOnce({ ...thread, activeLeafId: 'entry_parent', removed: [record] });
      mockCollection.updateOne
        .mockResolvedValueOnce({ ...unmatched, matchedCount: 1 })
        .mockResolvedValueOnce(unmatched);

      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(mockCollection.updateOne.mock.calls[1]).toEqual([
        { _id: 'thread_123', 'lease.token': leaseToken(0) },
        { $unset: { lease: '' } },
      ]);
      const reparented = {
        updateMany: {
          filter: { threadId: 'thread_123', parentId: 'entry_123' },
          update: { $set: { parentId: 'entry_parent' } },
        },
      };
      expect(mockCollection.bulkWrite.mock.calls).toEqual([[[reparented]], [[reparented]]]);
      expect(mockCollection.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('chains a big thread from before trees in batches that survive a lost lease', async () => {
      let clock = 0;
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const legacy = Array.from({ length: 1600 }, (_, i) => ({
        _id: `old_${String(i).padStart(4, '0')}`,
        threadId: 'thread_123',
        createdAt: new Date(i * 1000),
        parentId: undefined as string | null | undefined,
        formatVersion: undefined as number | undefined,
      }));
      mockCollection.find.mockImplementation(() => {
        let limit = Infinity;
        const cursor = {
          ...cursorOver([]),
          toArray: vi.fn<CursorSurface['toArray']>(async () => {
            const unlinked = legacy.filter((doc) => doc.formatVersion === undefined).reverse();
            const read = unlinked.slice(0, limit).map(({ _id }) => ({ _id }));
            clock += read.length * 1.5;
            return read;
          }),
        };
        cursor.sort.mockReturnValue(cursor as unknown as ReturnType<CursorSurface['sort']>);
        cursor.limit.mockImplementation((n: number) => {
          limit = n;
          return cursor as unknown as ReturnType<CursorSurface['limit']>;
        });
        return cursor;
      });
      mockCollection.bulkWrite.mockImplementation(async (operations) => {
        for (const operation of operations) {
          if (!('updateOne' in operation)) continue;
          const doc = legacy.find((stored) => stored._id === operation.updateOne.filter._id);
          const update = operation.updateOne.update as {
            $set: { parentId: string | null; formatVersion: number };
          };
          if (doc && doc.formatVersion === undefined) Object.assign(doc, update.$set);
        }
        return {} as Awaited<ReturnType<CollectionSurface['bulkWrite']>>;
      });
      const unchained = { ...thread, chained: false };
      mockCollection.findOne.mockResolvedValue(unchained);
      mockCollection.findOneAndUpdate.mockResolvedValue(unchained);

      const result = await adapter.getThread('thread_123');
      now.mockRestore();

      expect(result.success).toBe(true);
      expect(mockCollection.findOneAndUpdate.mock.calls.length).toBeGreaterThan(1);
      expect(mockCollection.bulkWrite).toHaveBeenCalledTimes(4);
      expect(legacy.every((doc) => doc.formatVersion === 1)).toBe(true);
      expect(legacy.map((doc) => doc.parentId)).toEqual([
        null,
        ...legacy.slice(0, -1).map((doc) => doc._id),
      ]);
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'thread_123', 'lease.token': leaseToken(0) },
        { $set: { activeLeafId: 'old_1599' } }
      );
    });

    it('refuses to check out an entry deleted after it was looked up', async () => {
      const entry = {
        _id: 'entry_gone',
        threadId: 'thread_123',
        message: { role: 'user', content: 'gone' },
        tokenCount: 1,
        createdAt: new Date(0),
      };
      mockCollection.findOne.mockResolvedValueOnce(entry).mockResolvedValue(null);
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({ ...thread });

      const result = await adapter.checkout('thread_123', 'entry_gone');

      expect(result).toEqual({
        success: false,
        error: 'Entry entry_gone is not in thread thread_123',
      });
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'thread_123', 'lease.token': leaseToken() },
        { $unset: { lease: '' } }
      );
    });

    it('walks a path over skeletons and reads only the entries it keeps in full', async () => {
      const at = new Date(0);
      const skeleton = (id: string, parentId: string | null) => ({
        _id: id,
        parentId,
        type: 'message',
        createdAt: at,
      });
      const full = (id: string) => ({
        ...skeleton(id, null),
        threadId: 'thread_123',
        message: { role: 'user', content: id },
        tokenCount: 1,
      });
      mockCollection.findOne.mockResolvedValue({ ...thread, activeLeafId: 'e3' });
      const scan = cursorOver([skeleton('e2', 'e1'), skeleton('e1', null)]);
      const fetched = cursorOver([full('e2'), full('e3')]);
      mockCollection.find
        .mockReturnValueOnce(cursorOver([skeleton('e3', 'e2')]))
        .mockReturnValueOnce(scan)
        .mockReturnValueOnce(fetched);

      const result = await adapter.getPath({ threadId: 'thread_123', limit: 2 });

      expect(result.success && result.data.map((entry) => entry.message.content)).toEqual([
        'e2',
        'e3',
      ]);
      const [start, scanned, read] = mockCollection.find.mock.calls;
      const projection = { _id: 1, parentId: 1, type: 1, createdAt: 1 };
      expect(start).toEqual([{ _id: 'e3', threadId: 'thread_123' }, { projection }]);
      expect(scanned).toEqual([
        { threadId: 'thread_123', createdAt: { $lte: at } },
        { projection },
      ]);
      expect(scan.batchSize).toHaveBeenCalledWith(500);
      expect(scan.next).toHaveBeenCalledTimes(1);
      expect(scan.close).toHaveBeenCalled();
      expect(read).toEqual([{ _id: { $in: ['e3', 'e2'] }, threadId: 'thread_123' }]);
    });

    it('looks a parent the scan does not hold up by its id', async () => {
      const at = new Date(1000);
      mockCollection.findOne.mockResolvedValue({ ...thread, activeLeafId: 'e2' });
      mockCollection.find
        .mockReturnValueOnce(
          cursorOver([{ _id: 'e2', parentId: 'later', type: 'message', createdAt: at }])
        )
        .mockReturnValueOnce(cursorOver([]))
        .mockReturnValueOnce(
          cursorOver([{ _id: 'later', parentId: null, type: 'message', createdAt: new Date(5000) }])
        );

      await adapter.getPath({ threadId: 'thread_123' });

      expect(mockCollection.find.mock.calls[2]).toEqual([
        { _id: 'later', threadId: 'thread_123' },
        { projection: { _id: 1, parentId: 1, type: 1, createdAt: 1 } },
      ]);
      expect(mockCollection.find.mock.calls[3]?.[0]).toEqual({
        _id: { $in: ['e2', 'later'] },
        threadId: 'thread_123',
      });
    });

    it('sorts entries by creation time, then by the order they were added', async () => {
      const cursor = cursorOver([]);
      mockCollection.find.mockReturnValueOnce(cursor);

      await adapter.getEntries({ threadId: 'thread_123' });

      expect(cursor.sort).toHaveBeenCalledWith({ createdAt: -1, seq: -1 });
    });

    it('refuses a limit that is not a whole number of 0 or more', async () => {
      expect((await adapter.getEntries({ threadId: 'thread_123', limit: -1 })).success).toBe(false);
      expect((await adapter.getEntries({ threadId: 'thread_123', limit: 2.5 })).success).toBe(
        false
      );
      expect(mockCollection.find).not.toHaveBeenCalled();
    });
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
        $and: [
          { threadId: { $eq: 'thread_123' }, createdAt: { $lt: before, $gt: after } },
          { $or: [{ type: { $in: ['message', 'tool_result'] } }, { type: null }] },
        ],
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
      mockCollection.findOne.mockResolvedValue({ _id: 'entry_123', threadId: 'thread_123' });
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({ ...thread });

      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({
        threadId: 'thread_123',
        _id: { $in: ['entry_123'] },
      });
    });

    it('clears the entries numbered so far under the lease, so a late clear spares newer ones', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({ ...thread, entrySeq: 9 });

      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockCollection.deleteMany).toHaveBeenCalledWith({
        threadId: 'thread_123',
        $or: [{ seq: { $lte: 9 } }, { seq: { $exists: false } }, { seq: { $type: 'null' } }],
      });
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: 'thread_123', 'lease.token': leaseToken() },
        { $set: { activeLeafId: null, chained: true }, $unset: { lease: '' } }
      );
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
      mockCollection.findOne.mockImplementation(async (filter) =>
        filter._id === 'thread_123'
          ? ({ _id: 'thread_123', chained: true } as WithId<StoredDoc>)
          : (stored.get(String(filter._id)) ?? null)
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
        type: 'message',
        parentId: null,
        seq: expect.any(Number),
        formatVersion: 2,
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
        type: 'message',
        parentId: null,
        formatVersion: 1,
      };

      expect(single.success && single.data).toEqual(expected);
      expect(listed.success && listed.data).toEqual([expected]);
    });
  });

  describe('listThreads', () => {
    const doc = (id: string, updatedAt: number) => ({
      _id: id,
      agentId: 'agent1',
      metadata: null,
      createdAt: new Date(0),
      updatedAt: new Date(updatedAt),
    });

    it('queries by agent, exact metadata values and update time, newest first', async () => {
      const cursor = cursorOver([doc('t2', 2000), doc('t1', 1000)]);
      mockCollection.find.mockReturnValueOnce(cursor);
      const updatedAfter = new Date(500);

      const result = await adapter.listThreads({
        agentId: 'agent1',
        metadata: { userId: 'u1', 'a.b': 1 },
        updatedAfter,
        limit: 2,
      });

      expect(mockCollection.find).toHaveBeenCalledWith({
        $and: [
          { agentId: { $eq: 'agent1' } },
          { updatedAt: { $gte: updatedAfter } },
          { 'metadata.userId': { $eq: 'u1', $not: { $type: 'array' } } },
          {
            $expr: {
              $eq: [
                { $getField: { field: { $literal: 'a.b' }, input: '$metadata' } },
                { $literal: 1 },
              ],
            },
          },
        ],
      });
      expect(cursor.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
      expect(cursor.limit).toHaveBeenCalledWith(3);
      expect(result.success && result.data.threads.map((t) => t.metadata)).toEqual([{}, {}]);
      expect(result.success && result.data.nextCursor).toBeUndefined();
    });

    it('continues after the cursor of the page before', async () => {
      mockCollection.find.mockReturnValueOnce(
        cursorOver([doc('t3', 3000), doc('t2', 3000), doc('t1', 1000)])
      );
      const first = await adapter.listThreads({ limit: 2, order: 'asc' });
      const cursor = first.success ? first.data.nextCursor : undefined;
      expect(cursor).toBeDefined();

      mockCollection.find.mockReturnValueOnce(cursorOver([]));
      await adapter.listThreads({ limit: 2, order: 'asc', ...(cursor && { cursor }) });

      const at = new Date(3000);
      expect(mockCollection.find).toHaveBeenLastCalledWith({
        $and: [{ $or: [{ updatedAt: { $gt: at } }, { updatedAt: at, _id: { $gt: 't2' } }] }],
      });
    });

    it('refuses bad options without querying', async () => {
      expect((await adapter.listThreads({ limit: 501 })).success).toBe(false);
      expect((await adapter.listThreads({ metadata: { "a'b": 'x' } })).success).toBe(false);
      expect(mockCollection.find).not.toHaveBeenCalled();
    });
  });

  describe('provider', () => {
    it('returns mongodb as provider', () => {
      expect(adapter.provider).toBe('mongodb');
    });
  });
});
