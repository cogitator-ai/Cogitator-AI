import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MongoDBAdapter } from '../adapters/mongodb';
import type { Message } from '@cogitator-ai/types';

const mockCollection = {
  createIndex: vi.fn().mockResolvedValue('index_name'),
  insertOne: vi.fn().mockResolvedValue({ insertedId: 'test-id' }),
  findOne: vi.fn(),
  find: vi.fn(),
  updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  deleteMany: vi.fn().mockResolvedValue({ deletedCount: 5 }),
};

const mockDb = {
  collection: vi.fn().mockReturnValue(mockCollection),
};

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  db: vi.fn().mockReturnValue(mockDb),
};

vi.mock('mongodb', () => {
  class MongoClient {
    connect = mockClient.connect;
    close = mockClient.close;
    db = mockClient.db;
  }
  return { MongoClient };
});

describe('MongoDBAdapter', () => {
  let adapter: MongoDBAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCollection.find.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    });
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
        toolResults: [{ toolCallId: 'call_1', result: { success: true } }],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.toolCalls).toHaveLength(1);
        expect(result.data.toolResults).toHaveLength(1);
      }
    });

    it('gets entries for thread', async () => {
      const now = new Date();
      mockCollection.find.mockReturnValueOnce({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            _id: 'entry_123',
            threadId: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tokenCount: 10,
            createdAt: now,
          },
        ]),
      });

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('entry_123');
      }
    });

    it('gets entries with time filter', async () => {
      const cursor = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      };
      mockCollection.find.mockReturnValueOnce(cursor);

      const before = new Date('2024-12-31');
      const after = new Date('2024-01-01');

      await adapter.getEntries({
        threadId: 'thread_123',
        before,
        after,
      });

      expect(mockCollection.find).toHaveBeenCalledWith({
        threadId: 'thread_123',
        createdAt: {
          $lt: before,
          $gt: after,
        },
      });
    });

    it('gets entries with limit', async () => {
      const cursor = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      };
      mockCollection.find.mockReturnValueOnce(cursor);

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      expect(cursor.limit).toHaveBeenCalledWith(5);
    });

    it('excludes tool calls when not requested', async () => {
      const now = new Date();
      mockCollection.find.mockReturnValueOnce({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            _id: 'entry_123',
            threadId: 'thread_123',
            message: { role: 'assistant', content: 'Done' },
            toolCalls: [{ id: 'call_1' }],
            toolResults: [{ toolCallId: 'call_1' }],
            tokenCount: 10,
            createdAt: now,
          },
        ]),
      });

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
      mockCollection.find.mockReturnValueOnce({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            _id: 'entry_123',
            threadId: 'thread_123',
            message: { role: 'assistant', content: 'Done' },
            toolCalls: [{ id: 'call_1' }],
            toolResults: [{ toolCallId: 'call_1' }],
            tokenCount: 10,
            createdAt: now,
          },
        ]),
      });

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

  describe('provider', () => {
    it('returns mongodb as provider', () => {
      expect(adapter.provider).toBe('mongodb');
    });
  });
});
