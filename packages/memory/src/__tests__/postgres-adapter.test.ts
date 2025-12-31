import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresAdapter } from '../adapters/postgres';
import type { Message } from '@cogitator-ai/types';

const mockPool = {
  query: vi.fn(),
  connect: vi.fn().mockResolvedValue({ release: vi.fn() }),
  end: vi.fn().mockResolvedValue(undefined),
};

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => mockPool),
  },
  Pool: vi.fn().mockImplementation(() => mockPool),
}));

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
    adapter = new PostgresAdapter({
      provider: 'postgres',
      connectionString: 'postgresql://localhost:5432/test',
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects and initializes schema', async () => {
      const newAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS cogitator');
    });

    it('uses custom schema name', async () => {
      vi.clearAllMocks();
      mockPool.query.mockResolvedValue({ rows: [] });

      const newAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
        schema: 'custom_schema',
      });

      await newAdapter.connect();

      expect(mockPool.query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS custom_schema');
    });

    it('disconnects and closes pool', async () => {
      await adapter.disconnect();

      expect(mockPool.end).toHaveBeenCalled();
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
      }
    });

    it('gets a thread', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'thread_123',
            agent_id: 'agent1',
            metadata: { key: 'value' },
            created_at: now,
            updated_at: now,
          },
        ],
      });

      const result = await adapter.getThread('thread_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('thread_123');
        expect(result.data?.agentId).toBe('agent1');
        expect(result.data?.createdAt).toBeInstanceOf(Date);
      }
    });

    it('returns null for non-existent thread', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.getThread('nonexistent');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it('updates thread metadata', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'thread_123',
            agent_id: 'agent1',
            metadata: { a: 1, b: 2 },
            created_at: now,
            updated_at: now,
          },
        ],
      });

      const result = await adapter.updateThread('thread_123', { b: 2 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual({ a: 1, b: 2 });
      }
    });

    it('returns error for updating non-existent thread', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.updateThread('nonexistent', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes thread', async () => {
      const result = await adapter.deleteThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'thread_123',
      ]);
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
      }
    });

    it('gets entries for thread', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: {},
            created_at: now,
          },
        ],
      });

      const result = await adapter.getEntries({ threadId: 'thread_123' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('entry_123');
      }
    });

    it('gets entries with time range filter', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({
        threadId: 'thread_123',
        after: new Date('2024-01-01'),
        before: new Date('2024-12-31'),
      });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('created_at <');
      expect(lastCall[0]).toContain('created_at >');
    });

    it('gets entries with limit', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getEntries({ threadId: 'thread_123', limit: 5 });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('LIMIT');
      expect(lastCall[1]).toContain(5);
    });

    it('gets single entry', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'entry_123',
            thread_id: 'thread_123',
            message: { role: 'user', content: 'Hello' },
            tool_calls: null,
            tool_results: null,
            token_count: 10,
            metadata: {},
            created_at: now,
          },
        ],
      });

      const result = await adapter.getEntry('entry_123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.id).toBe('entry_123');
      }
    });

    it('deletes entry', async () => {
      const result = await adapter.deleteEntry('entry_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'entry_123',
      ]);
    });

    it('clears thread entries', async () => {
      const result = await adapter.clearThread('thread_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
        'thread_123',
      ]);
    });
  });

  describe('fact operations', () => {
    it('adds a fact', async () => {
      const result = await adapter.addFact({
        agentId: 'agent1',
        content: 'User prefers dark mode',
        category: 'preferences',
        confidence: 0.9,
        source: 'inferred',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^fact_/);
        expect(result.data.content).toBe('User prefers dark mode');
      }
    });

    it('gets facts for agent', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'fact_123',
            agent_id: 'agent1',
            content: 'Test fact',
            category: 'general',
            confidence: 1.0,
            source: 'explicit',
            metadata: {},
            created_at: now,
            updated_at: now,
            expires_at: null,
          },
        ],
      });

      const result = await adapter.getFacts('agent1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].content).toBe('Test fact');
      }
    });

    it('gets facts by category', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.getFacts('agent1', 'preferences');

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('category = $2');
      expect(lastCall[1]).toContain('preferences');
    });

    it('updates a fact', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'fact_123',
            agent_id: 'agent1',
            content: 'Updated content',
            category: 'general',
            confidence: 0.8,
            source: 'explicit',
            metadata: {},
            created_at: now,
            updated_at: now,
            expires_at: null,
          },
        ],
      });

      const result = await adapter.updateFact('fact_123', {
        content: 'Updated content',
        confidence: 0.8,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toBe('Updated content');
      }
    });

    it('returns error for updating non-existent fact', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await adapter.updateFact('nonexistent', { content: 'test' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });

    it('deletes a fact', async () => {
      const result = await adapter.deleteFact('fact_123');

      expect(result.success).toBe(true);
    });

    it('searches facts', async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'fact_123',
            agent_id: 'agent1',
            content: 'User likes coffee',
            category: 'preferences',
            confidence: 0.9,
            source: 'inferred',
            metadata: {},
            created_at: now,
            updated_at: now,
            expires_at: null,
          },
        ],
      });

      const result = await adapter.searchFacts('agent1', 'coffee');

      expect(result.success).toBe(true);
      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('ILIKE');
      expect(lastCall[1]).toContain('%coffee%');
    });
  });

  describe('embedding operations', () => {
    it('adds an embedding', async () => {
      const result = await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'entry',
        vector: [0.1, 0.2, 0.3],
        content: 'Hello world',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^emb_/);
        expect(result.data.vector).toEqual([0.1, 0.2, 0.3]);
      }
    });

    it('searches embeddings by vector', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'emb_123',
            source_id: 'entry_123',
            source_type: 'entry',
            vector: [0.1, 0.2, 0.3],
            content: 'Test content',
            metadata: {},
            created_at: new Date().toISOString(),
            score: 0.95,
          },
        ],
      });

      const result = await adapter.search({
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        threshold: 0.7,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].score).toBe(0.95);
      }
    });

    it('requires vector for search', async () => {
      const result = await adapter.search({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('requires vector');
      }
    });

    it('filters search by source type', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await adapter.search({
        vector: [0.1, 0.2, 0.3],
        filter: { sourceType: 'fact' },
      });

      const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('source_type =');
      expect(lastCall[1]).toContain('fact');
    });

    it('deletes an embedding', async () => {
      const result = await adapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(true);
    });

    it('deletes embeddings by source', async () => {
      const result = await adapter.deleteBySource('entry_123');

      expect(result.success).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('source_id = $1'), [
        'entry_123',
      ]);
    });
  });

  describe('error handling', () => {
    it('returns error when not connected', async () => {
      const disconnectedAdapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString: 'postgresql://localhost:5432/test',
      });

      const result = await disconnectedAdapter.createThread('agent1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });
  });

  describe('provider', () => {
    it('returns postgres as provider', () => {
      expect(adapter.provider).toBe('postgres');
    });
  });

  describe('vector dimensions', () => {
    it('allows setting custom dimensions', () => {
      adapter.setVectorDimensions(1536);
    });
  });
});
