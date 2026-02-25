import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QdrantAdapter } from '../adapters/qdrant';

const mockClient = {
  getCollections: vi.fn(),
  createCollection: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  search: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@qdrant/js-client-rest', () => {
  class QdrantClient {
    getCollections = mockClient.getCollections;
    createCollection = mockClient.createCollection;
    upsert = mockClient.upsert;
    search = mockClient.search;
    delete = mockClient.delete;
  }
  return { QdrantClient };
});

describe('QdrantAdapter', () => {
  let adapter: QdrantAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.getCollections.mockResolvedValue({ collections: [] });
    mockClient.search.mockResolvedValue([]);

    adapter = new QdrantAdapter({
      url: 'http://localhost:6333',
      collection: 'test_collection',
      dimensions: 1536,
    });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('connect/disconnect', () => {
    it('connects and creates collection if not exists', async () => {
      vi.clearAllMocks();
      mockClient.getCollections.mockResolvedValue({ collections: [] });

      const newAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'new_collection',
        dimensions: 768,
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(true);
      expect(mockClient.getCollections).toHaveBeenCalled();
      expect(mockClient.createCollection).toHaveBeenCalledWith('new_collection', {
        vectors: { size: 768, distance: 'Cosine' },
      });
    });

    it('skips collection creation if exists', async () => {
      vi.clearAllMocks();
      mockClient.getCollections.mockResolvedValue({
        collections: [{ name: 'existing_collection' }],
      });

      const newAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'existing_collection',
        dimensions: 1536,
      });

      await newAdapter.connect();

      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });

    it('uses default URL and collection', async () => {
      vi.clearAllMocks();
      mockClient.getCollections.mockResolvedValue({ collections: [] });

      const newAdapter = new QdrantAdapter({
        dimensions: 1536,
      });

      await newAdapter.connect();

      expect(mockClient.createCollection).toHaveBeenCalledWith('cogitator', expect.any(Object));
    });

    it('uses API key when provided', async () => {
      const newAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        apiKey: 'test-api-key',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await newAdapter.connect();
      expect(result.success).toBe(true);
    });

    it('disconnects by clearing client', async () => {
      const result = await adapter.disconnect();

      expect(result.success).toBe(true);
    });

    it('handles multiple connect calls', async () => {
      const result = await adapter.connect();

      expect(result.success).toBe(true);
    });
  });

  describe('addEmbedding', () => {
    it('adds an embedding', async () => {
      const result = await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'entry',
        vector: Array(1536).fill(0.1),
        content: 'Test content',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^emb_/);
        expect(result.data.sourceId).toBe('entry_123');
        expect(result.data.sourceType).toBe('entry');
        expect(result.data.content).toBe('Test content');
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }

      expect(mockClient.upsert).toHaveBeenCalledWith('test_collection', {
        points: [
          {
            id: expect.stringMatching(/^emb_/),
            vector: expect.any(Array),
            payload: expect.objectContaining({
              sourceId: 'entry_123',
              sourceType: 'entry',
              content: 'Test content',
            }),
          },
        ],
      });
    });

    it('includes metadata in payload', async () => {
      await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'entry',
        vector: [0.1, 0.2],
        content: 'Test',
        metadata: { category: 'science', language: 'en' },
      });

      expect(mockClient.upsert).toHaveBeenCalledWith('test_collection', {
        points: [
          expect.objectContaining({
            payload: expect.objectContaining({
              metadata: { category: 'science', language: 'en' },
            }),
          }),
        ],
      });
    });

    it('returns error when not connected', async () => {
      const disconnectedAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await disconnectedAdapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'entry',
        vector: [0.1],
        content: 'Test',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });

    it('handles upsert errors', async () => {
      mockClient.upsert.mockRejectedValueOnce(new Error('Upsert failed'));

      const result = await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'entry',
        vector: [0.1],
        content: 'Test',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Upsert failed');
      }
    });
  });

  describe('search', () => {
    it('searches by vector', async () => {
      const now = new Date();
      mockClient.search.mockResolvedValueOnce([
        {
          id: 'emb_123',
          score: 0.95,
          payload: {
            embeddingId: 'emb_123',
            sourceId: 'entry_123',
            sourceType: 'entry',
            content: 'Similar content',
            createdAt: now.toISOString(),
            metadata: { category: 'test' },
          },
        },
      ]);

      const result = await adapter.search({
        vector: Array(1536).fill(0.1),
        limit: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('emb_123');
        expect(result.data[0].score).toBe(0.95);
        expect(result.data[0].content).toBe('Similar content');
        expect(result.data[0].metadata).toEqual({ category: 'test' });
      }
    });

    it('uses default limit', async () => {
      mockClient.search.mockResolvedValue([]);

      await adapter.search({ vector: [0.1] });

      expect(mockClient.search).toHaveBeenCalledWith('test_collection', {
        vector: [0.1],
        limit: 10,
        score_threshold: undefined,
        filter: undefined,
      });
    });

    it('applies threshold', async () => {
      mockClient.search.mockResolvedValue([]);

      await adapter.search({
        vector: [0.1],
        threshold: 0.8,
      });

      expect(mockClient.search).toHaveBeenCalledWith('test_collection', {
        vector: [0.1],
        limit: 10,
        score_threshold: 0.8,
        filter: undefined,
      });
    });

    it('filters by sourceType', async () => {
      mockClient.search.mockResolvedValue([]);

      await adapter.search({
        vector: [0.1],
        filter: { sourceType: 'fact' },
      });

      expect(mockClient.search).toHaveBeenCalledWith('test_collection', {
        vector: [0.1],
        limit: 10,
        score_threshold: undefined,
        filter: {
          must: [{ key: 'sourceType', match: { value: 'fact' } }],
        },
      });
    });

    it('filters by threadId', async () => {
      mockClient.search.mockResolvedValue([]);

      await adapter.search({
        vector: [0.1],
        filter: { threadId: 'thread_123' },
      });

      expect(mockClient.search).toHaveBeenCalledWith('test_collection', {
        vector: [0.1],
        limit: 10,
        score_threshold: undefined,
        filter: {
          must: [{ key: 'threadId', match: { value: 'thread_123' } }],
        },
      });
    });

    it('filters by agentId', async () => {
      mockClient.search.mockResolvedValue([]);

      await adapter.search({
        vector: [0.1],
        filter: { agentId: 'agent_123' },
      });

      expect(mockClient.search).toHaveBeenCalledWith('test_collection', {
        vector: [0.1],
        limit: 10,
        score_threshold: undefined,
        filter: {
          must: [{ key: 'agentId', match: { value: 'agent_123' } }],
        },
      });
    });

    it('combines multiple filters', async () => {
      mockClient.search.mockResolvedValue([]);

      await adapter.search({
        vector: [0.1],
        filter: {
          sourceType: 'entry',
          threadId: 'thread_123',
          agentId: 'agent_456',
        },
      });

      expect(mockClient.search).toHaveBeenCalledWith('test_collection', {
        vector: [0.1],
        limit: 10,
        score_threshold: undefined,
        filter: {
          must: [
            { key: 'sourceType', match: { value: 'entry' } },
            { key: 'threadId', match: { value: 'thread_123' } },
            { key: 'agentId', match: { value: 'agent_456' } },
          ],
        },
      });
    });

    it('returns error when vector is missing', async () => {
      const result = await adapter.search({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('vector is required');
      }
    });

    it('returns error when not connected', async () => {
      const disconnectedAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await disconnectedAdapter.search({ vector: [0.1] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Not connected');
      }
    });

    it('handles search errors', async () => {
      mockClient.search.mockRejectedValueOnce(new Error('Search timeout'));

      const result = await adapter.search({ vector: [0.1] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Search timeout');
      }
    });

    it('returns empty vector in results', async () => {
      mockClient.search.mockResolvedValueOnce([
        {
          id: 'emb_123',
          score: 0.9,
          payload: {
            sourceId: 'entry_123',
            sourceType: 'entry',
            content: 'Test',
            createdAt: new Date().toISOString(),
          },
        },
      ]);

      const result = await adapter.search({ vector: [0.1] });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].vector).toEqual([]);
      }
    });
  });

  describe('deleteEmbedding', () => {
    it('deletes embedding by id', async () => {
      const result = await adapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(true);
      expect(mockClient.delete).toHaveBeenCalledWith('test_collection', {
        points: ['emb_123'],
      });
    });

    it('returns error when not connected', async () => {
      const disconnectedAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await disconnectedAdapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(false);
    });

    it('handles delete errors', async () => {
      mockClient.delete.mockRejectedValueOnce(new Error('Delete failed'));

      const result = await adapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Delete failed');
      }
    });
  });

  describe('deleteBySource', () => {
    it('deletes all embeddings by sourceId', async () => {
      const result = await adapter.deleteBySource('entry_123');

      expect(result.success).toBe(true);
      expect(mockClient.delete).toHaveBeenCalledWith('test_collection', {
        filter: {
          must: [{ key: 'sourceId', match: { value: 'entry_123' } }],
        },
      });
    });

    it('returns error when not connected', async () => {
      const disconnectedAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await disconnectedAdapter.deleteBySource('entry_123');

      expect(result.success).toBe(false);
    });

    it('handles delete errors', async () => {
      mockClient.delete.mockRejectedValueOnce(new Error('Bulk delete failed'));

      const result = await adapter.deleteBySource('entry_123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Bulk delete failed');
      }
    });
  });

  describe('connection errors', () => {
    it('handles connection failures', async () => {
      mockClient.getCollections.mockRejectedValueOnce(new Error('Connection refused'));

      const newAdapter = new QdrantAdapter({
        url: 'http://invalid:6333',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Connection refused');
      }
    });

    it('handles collection creation errors', async () => {
      vi.clearAllMocks();
      mockClient.getCollections.mockResolvedValue({ collections: [] });
      mockClient.createCollection.mockRejectedValueOnce(new Error('Insufficient permissions'));

      const newAdapter = new QdrantAdapter({
        url: 'http://localhost:6333',
        collection: 'new_collection',
        dimensions: 1536,
      });

      const result = await newAdapter.connect();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Insufficient permissions');
      }
    });
  });
});
