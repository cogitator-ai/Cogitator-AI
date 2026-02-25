import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteAdapter } from '../adapters/sqlite';
import type { Message } from '@cogitator-ai/types';

const mockStmt = {
  run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
};

const mockDb = {
  prepare: vi.fn().mockReturnValue(mockStmt),
  exec: vi.fn(),
  close: vi.fn(),
  pragma: vi.fn(),
};

vi.mock('better-sqlite3', () => {
  class Database {
    prepare = mockDb.prepare;
    exec = mockDb.exec;
    close = mockDb.close;
    pragma = mockDb.pragma;
  }
  return { default: Database };
});

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStmt.get.mockReturnValue(undefined);
    mockStmt.all.mockReturnValue([]);

    adapter = new SQLiteAdapter({
      provider: 'sqlite',
      path: ':memory:',
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects and creates tables', async () => {
      const newAdapter = new SQLiteAdapter({
        provider: 'sqlite',
        path: ':memory:',
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS threads')
      );
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS entries')
      );
    });

    it('enables WAL mode for file databases', async () => {
      vi.clearAllMocks();
      const newAdapter = new SQLiteAdapter({
        provider: 'sqlite',
        path: '/tmp/test.db',
        walMode: true,
      });

      await newAdapter.connect();

      expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    });

    it('skips WAL mode for :memory: database', async () => {
      vi.clearAllMocks();
      const newAdapter = new SQLiteAdapter({
        provider: 'sqlite',
        path: ':memory:',
        walMode: true,
      });

      await newAdapter.connect();

      expect(mockDb.pragma).toHaveBeenCalledWith('foreign_keys = ON');
      expect(mockDb.pragma).not.toHaveBeenCalledWith('journal_mode = WAL');
    });

    it('can disable WAL mode', async () => {
      vi.clearAllMocks();
      const newAdapter = new SQLiteAdapter({
        provider: 'sqlite',
        path: '/tmp/test.db',
        walMode: false,
      });

      await newAdapter.connect();

      expect(mockDb.pragma).toHaveBeenCalledWith('foreign_keys = ON');
      expect(mockDb.pragma).not.toHaveBeenCalledWith('journal_mode = WAL');
    });

    it('disconnects and closes database', async () => {
      await adapter.disconnect();

      expect(mockDb.close).toHaveBeenCalled();
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
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO threads'));
    });

    it('creates thread with custom id', async () => {
      const result = await adapter.createThread('agent1', {}, 'custom-thread-id');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('custom-thread-id');
      }
    });

    it('gets a thread', async () => {
      const now = new Date().toISOString();
      mockStmt.get.mockReturnValueOnce({
        id: 'thread_123',
        agent_id: 'agent1',
        metadata: '{"key":"value"}',
        created_at: now,
        updated_at: now,
      });

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('thread_123');
        expect(result.data?.agentId).toBe('agent1');
        expect(result.data?.metadata).toEqual({ key: 'value' });
        expect(result.data?.createdAt).toBeInstanceOf(Date);
      }
    });

    it('returns null for non-existent thread', async () => {
      mockStmt.get.mockReturnValueOnce(undefined);

      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const now = new Date().toISOString();
      mockStmt.get.mockReturnValueOnce({
        id: 'thread_123',
        agent_id: 'agent1',
        metadata: '{"a":1}',
        created_at: now,
        updated_at: now,
      });

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE threads'));
    });

    it('returns error for updating non-existent thread', async () => {
      mockStmt.get.mockReturnValueOnce(undefined);

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread and its entries', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM entries'));
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM threads'));
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
      const message: Message = { role: 'assistant', content: 'Running...' };
      const result = await adapter.addEntry({
        threadId: 'thread_123',
        message,
        tokenCount: 15,
        toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
        toolResults: [{ toolCallId: 'call_1', result: 'ok' }],
        metadata: { source: 'test' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.toolCalls).toHaveLength(1);
        expect(result.data.toolResults).toHaveLength(1);
        expect(result.data.metadata).toEqual({ source: 'test' });
      }
    });

    it('gets entries for thread', async () => {
      const now = new Date().toISOString();
      mockStmt.all.mockReturnValueOnce([
        {
          id: 'entry_1',
          thread_id: 'thread_123',
          message: '{"role":"user","content":"Hello"}',
          tool_calls: null,
          tool_results: null,
          token_count: 10,
          created_at: now,
          metadata: null,
        },
        {
          id: 'entry_2',
          thread_id: 'thread_123',
          message: '{"role":"assistant","content":"Hi!"}',
          tool_calls: null,
          tool_results: null,
          token_count: 5,
          created_at: now,
          metadata: '{"source":"test"}',
        },
      ]);

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].message.role).toBe('user');
        expect(result.data[1].metadata).toEqual({ source: 'test' });
      }
    });

    it('gets entries with time filter', async () => {
      mockStmt.all.mockReturnValueOnce([]);

      await adapter.getEntries({
        threadId: 'thread_123',
        before: new Date('2024-12-31'),
        after: new Date('2024-01-01'),
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('created_at <'));
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('created_at >'));
    });

    it('gets entries with limit', async () => {
      mockStmt.all.mockReturnValueOnce([]);

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT'));
    });

    it('excludes tool calls when not requested', async () => {
      const now = new Date().toISOString();
      mockStmt.all.mockReturnValueOnce([
        {
          id: 'entry_123',
          thread_id: 'thread_123',
          message: '{"role":"assistant","content":"Done"}',
          tool_calls: '[{"id":"call_1"}]',
          tool_results: '[{"toolCallId":"call_1"}]',
          token_count: 10,
          created_at: now,
          metadata: null,
        },
      ]);

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
      const now = new Date().toISOString();
      mockStmt.all.mockReturnValueOnce([
        {
          id: 'entry_123',
          thread_id: 'thread_123',
          message: '{"role":"assistant","content":"Done"}',
          tool_calls: '[{"id":"call_1","name":"test","arguments":{}}]',
          tool_results: '[{"toolCallId":"call_1","result":"ok"}]',
          token_count: 10,
          created_at: now,
          metadata: null,
        },
      ]);

      const result = await adapter.getEntries({
        threadId: 'thread_123',
        includeToolCalls: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].toolCalls).toHaveLength(1);
        expect(result.data[0].toolResults).toHaveLength(1);
      }
    });

    it('gets single entry', async () => {
      const now = new Date().toISOString();
      mockStmt.get.mockReturnValueOnce({
        id: 'entry_123',
        thread_id: 'thread_123',
        message: '{"role":"user","content":"Hello"}',
        tool_calls: null,
        tool_results: null,
        token_count: 10,
        created_at: now,
        metadata: '{"source":"test"}',
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('entry_123');
        expect(result.data?.metadata).toEqual({ source: 'test' });
      }
    });

    it('returns null for non-existent entry', async () => {
      mockStmt.get.mockReturnValueOnce(undefined);

      const result = await adapter.getEntry('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('parses tool calls from JSON', async () => {
      const now = new Date().toISOString();
      mockStmt.get.mockReturnValueOnce({
        id: 'entry_123',
        thread_id: 'thread_123',
        message: '{"role":"assistant","content":"Running"}',
        tool_calls: '[{"id":"call_1","name":"calc","arguments":{"x":1}}]',
        tool_results: '[{"toolCallId":"call_1","result":{"value":2}}]',
        token_count: 15,
        created_at: now,
        metadata: null,
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.toolCalls?.[0].name).toBe('calc');
        expect(result.data?.toolResults?.[0].result).toEqual({ value: 2 });
      }
    });

    it('deletes entry', async () => {
      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM entries WHERE id')
      );
    });

    it('clears thread entries', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM entries WHERE thread_id')
      );
    });
  });

  describe('error handling', () => {
    it('returns error when not connected', async () => {
      const disconnectedAdapter = new SQLiteAdapter({
        provider: 'sqlite',
        path: ':memory:',
      });

      const result = await disconnectedAdapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });

    it('handles database errors', async () => {
      mockDb.prepare.mockImplementationOnce(() => {
        throw new Error('Database is locked');
      });

      const result = await adapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Database is locked');
      }
    });

    it('handles JSON parse errors gracefully', async () => {
      const now = new Date().toISOString();
      mockStmt.get.mockReturnValueOnce({
        id: 'entry_123',
        thread_id: 'thread_123',
        message: '{"role":"user","content":"test"}',
        tool_calls: 'invalid json',
        tool_results: null,
        token_count: 10,
        created_at: now,
        metadata: null,
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(false);
    });
  });

  describe('provider', () => {
    it('returns sqlite as provider', () => {
      expect(adapter.provider).toBe('sqlite');
    });
  });
});
