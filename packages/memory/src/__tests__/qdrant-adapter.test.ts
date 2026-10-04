import { describe, it, expect, expectTypeOf, beforeEach, afterEach, vi } from 'vitest';
import type { QdrantClient as RealQdrantClient, Schemas } from '@qdrant/js-client-rest';
import type { MemoryResult } from '@cogitator-ai/types';
import { QdrantAdapter } from '../adapters/qdrant';
import { createEmbeddingAdapter } from '../adapters/index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ClientSurface = Pick<
  RealQdrantClient,
  'getCollections' | 'createCollection' | 'upsert' | 'query' | 'delete'
>;

const updated: Schemas['UpdateResult'] = { operation_id: 1, status: 'completed' };

const mockClient = {
  getCollections: vi.fn<ClientSurface['getCollections']>(),
  createCollection: vi.fn<ClientSurface['createCollection']>().mockResolvedValue(true),
  upsert: vi.fn<ClientSurface['upsert']>().mockResolvedValue(updated),
  query: vi.fn<ClientSurface['query']>(),
  delete: vi.fn<ClientSurface['delete']>().mockResolvedValue(updated),
} satisfies ClientSurface;

vi.mock('@qdrant/js-client-rest', () => {
  class QdrantClient {
    constructor() {
      return mockClient;
    }
  }
  return { QdrantClient };
});

function upsertedPoints(): Schemas['PointStruct'][] {
  return mockClient.upsert.mock.calls.flatMap(([, operation]) =>
    'points' in operation ? operation.points : []
  );
}

function scored(
  id: string,
  score: number,
  payload: Record<string, unknown> | null
): Schemas['ScoredPoint'] {
  return { id, version: 1, score, payload };
}

describe('the mocked Qdrant client', () => {
  it('only stubs methods the real @qdrant/js-client-rest client has', async () => {
    const real =
      await vi.importActual<typeof import('@qdrant/js-client-rest')>('@qdrant/js-client-rest');
    const prototype = real.QdrantClient.prototype as unknown as Record<string, unknown>;
    for (const method of Object.keys(mockClient)) {
      expect(typeof prototype[method], `QdrantClient.${method}`).toBe('function');
    }
  });
});

describe('createEmbeddingAdapter', () => {
  it('returns an adapter typed with the connect and disconnect it must be called with', async () => {
    mockClient.getCollections.mockResolvedValue({ collections: [] });
    const adapter = await createEmbeddingAdapter({ provider: 'qdrant', dimensions: 8 });

    expectTypeOf(adapter.connect).returns.toEqualTypeOf<Promise<MemoryResult<void>>>();
    expectTypeOf(adapter.disconnect).returns.toEqualTypeOf<Promise<MemoryResult<void>>>();
    expect(await adapter.connect()).toEqual({ success: true, data: undefined });
    expect(await adapter.disconnect()).toEqual({ success: true, data: undefined });
  });
});

describe('QdrantAdapter', () => {
  let adapter: QdrantAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.getCollections.mockResolvedValue({ collections: [] });
    mockClient.query.mockResolvedValue({ points: [] });

    adapter = new QdrantAdapter({
      provider: 'qdrant',
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
        provider: 'qdrant',
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
        provider: 'qdrant',
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
        provider: 'qdrant',
        dimensions: 1536,
      });

      await newAdapter.connect();

      expect(mockClient.createCollection).toHaveBeenCalledWith('cogitator', expect.any(Object));
    });

    it('uses API key when provided', async () => {
      const newAdapter = new QdrantAdapter({
        provider: 'qdrant',
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
        sourceType: 'message',
        vector: Array(1536).fill(0.1),
        content: 'Test content',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^emb_/);
        expect(result.data.sourceId).toBe('entry_123');
        expect(result.data.sourceType).toBe('message');
        expect(result.data.content).toBe('Test content');
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }

      expect(mockClient.upsert).toHaveBeenCalledWith('test_collection', {
        points: [
          {
            id: expect.stringMatching(UUID_PATTERN),
            vector: expect.any(Array),
            payload: expect.objectContaining({
              embeddingId: expect.stringMatching(/^emb_/),
              sourceId: 'entry_123',
              sourceType: 'message',
              content: 'Test content',
            }),
          },
        ],
      });
    });

    it('stores the embedding under a UUID point id that Qdrant accepts', async () => {
      const first = await adapter.addEmbedding({
        sourceId: 'entry_1',
        sourceType: 'message',
        vector: [0.1, 0.2],
        content: 'First',
      });
      const second = await adapter.addEmbedding({
        sourceId: 'entry_2',
        sourceType: 'message',
        vector: [0.3, 0.4],
        content: 'Second',
      });

      const points = upsertedPoints();
      expect(points[0].id).toMatch(UUID_PATTERN);
      expect(points[1].id).toMatch(UUID_PATTERN);
      expect(points[0].id).not.toBe(points[1].id);
      expect(points[0].payload?.embeddingId).toBe(first.success && first.data.id);
      expect(points[1].payload?.embeddingId).toBe(second.success && second.data.id);
    });

    it('deletes the same point it stored for an embedding id', async () => {
      const added = await adapter.addEmbedding({
        sourceId: 'entry_1',
        sourceType: 'message',
        vector: [0.1, 0.2],
        content: 'First',
      });
      if (!added.success) throw new Error(added.error);

      await adapter.deleteEmbedding(added.data.id);

      const storedId = upsertedPoints()[0]?.id;
      expect(mockClient.delete).toHaveBeenCalledWith('test_collection', {
        wait: true,
        points: [storedId],
      });
    });

    it('includes metadata in payload', async () => {
      await adapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'message',
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
        provider: 'qdrant',
        url: 'http://localhost:6333',
        collection: 'test',
        dimensions: 1536,
      });

      const result = await disconnectedAdapter.addEmbedding({
        sourceId: 'entry_123',
        sourceType: 'message',
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
        sourceType: 'message',
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
      mockClient.query.mockResolvedValueOnce({
        points: [
          scored('6f1c2f8e-1d2b-5c3a-8e4f-0a1b2c3d4e5f', 0.95, {
            embeddingId: 'emb_123',
            sourceId: 'entry_123',
            sourceType: 'message',
            content: 'Similar content',
            createdAt: now.toISOString(),
            metadata: { category: 'test' },
          }),
        ],
      });

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
      await adapter.search({ vector: [0.1] });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: undefined,
        with_payload: true,
        filter: undefined,
      });
    });

    it('applies threshold', async () => {
      await adapter.search({
        vector: [0.1],
        threshold: 0.8,
      });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: 0.8,
        with_payload: true,
        filter: undefined,
      });
    });

    it('filters by sourceType', async () => {
      await adapter.search({
        vector: [0.1],
        filter: { sourceType: 'fact' },
      });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: undefined,
        with_payload: true,
        filter: {
          must: [{ key: 'sourceType', match: { value: 'fact' } }],
        },
      });
    });

    it('filters by user, letting through embeddings of no user', async () => {
      await adapter.search({ vector: [0.1], filter: { userId: 'alice' } });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: undefined,
        with_payload: true,
        filter: {
          must: [
            {
              should: [
                { key: 'metadata.userId', match: { value: 'alice' } },
                { is_empty: { key: 'metadata.userId' } },
              ],
            },
          ],
        },
      });
    });

    it('filters by threadId', async () => {
      await adapter.search({
        vector: [0.1],
        filter: { threadId: 'thread_123' },
      });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: undefined,
        with_payload: true,
        filter: {
          must: [{ key: 'metadata.threadId', match: { value: 'thread_123' } }],
        },
      });
    });

    it('filters by agentId', async () => {
      await adapter.search({
        vector: [0.1],
        filter: { agentId: 'agent_123' },
      });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: undefined,
        with_payload: true,
        filter: {
          must: [{ key: 'metadata.agentId', match: { value: 'agent_123' } }],
        },
      });
    });

    it('combines multiple filters', async () => {
      await adapter.search({
        vector: [0.1],
        filter: {
          sourceType: 'message',
          threadId: 'thread_123',
          agentId: 'agent_456',
        },
      });

      expect(mockClient.query).toHaveBeenCalledWith('test_collection', {
        query: [0.1],
        limit: 10,
        score_threshold: undefined,
        with_payload: true,
        filter: {
          must: [
            { key: 'sourceType', match: { value: 'message' } },
            { key: 'metadata.threadId', match: { value: 'thread_123' } },
            { key: 'metadata.agentId', match: { value: 'agent_456' } },
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
        provider: 'qdrant',
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
      mockClient.query.mockRejectedValueOnce(new Error('Search timeout'));

      const result = await adapter.search({ vector: [0.1] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Search timeout');
      }
    });

    it('returns empty vector in results', async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [
          scored('emb_123', 0.9, {
            sourceId: 'entry_123',
            sourceType: 'message',
            content: 'Test',
            createdAt: new Date().toISOString(),
          }),
        ],
      });

      const result = await adapter.search({ vector: [0.1] });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].vector).toEqual([]);
      }
    });

    it('maps a point without payload instead of failing the whole search', async () => {
      mockClient.query.mockResolvedValueOnce({ points: [scored('emb_1', 0.5, null)] });

      const result = await adapter.search({ vector: [0.1] });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0]).toMatchObject({ id: 'emb_1', score: 0.5, metadata: {} });
      }
    });
  });

  describe('deleteEmbedding', () => {
    it('deletes embedding by id', async () => {
      const result = await adapter.deleteEmbedding('emb_123');

      expect(result.success).toBe(true);
      expect(mockClient.delete).toHaveBeenCalledWith('test_collection', {
        wait: true,
        points: [expect.stringMatching(UUID_PATTERN)],
      });
    });

    it('returns error when not connected', async () => {
      const disconnectedAdapter = new QdrantAdapter({
        provider: 'qdrant',
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
        wait: true,
        filter: {
          must: [{ key: 'sourceId', match: { value: 'entry_123' } }],
        },
      });
    });

    it('returns error when not connected', async () => {
      const disconnectedAdapter = new QdrantAdapter({
        provider: 'qdrant',
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
        provider: 'qdrant',
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
        provider: 'qdrant',
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
