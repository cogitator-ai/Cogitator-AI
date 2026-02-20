import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MMRRetriever } from '../retrievers/mmr-retriever';

describe('MMRRetriever', () => {
  const makeAdapter = (data: any[]) => ({
    search: vi.fn().mockResolvedValue({ success: true, data }),
    addEmbedding: vi.fn(),
    deleteEmbedding: vi.fn(),
    deleteBySource: vi.fn(),
  });

  const makeEmbedding = (vec: number[]) => ({
    embed: vi.fn().mockResolvedValue(vec),
    embedBatch: vi.fn(),
    dimensions: vec.length,
    model: 'test',
  });

  it('returns topK results', async () => {
    const candidates = [
      {
        id: '1',
        sourceId: 'c1',
        sourceType: 'document',
        content: 'A',
        vector: [1, 0, 0],
        score: 0.9,
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: '2',
        sourceId: 'c2',
        sourceType: 'document',
        content: 'B',
        vector: [0.9, 0.1, 0],
        score: 0.8,
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: '3',
        sourceId: 'c3',
        sourceType: 'document',
        content: 'C',
        vector: [0, 1, 0],
        score: 0.7,
        createdAt: new Date(),
        metadata: {},
      },
    ];
    const retriever = new MMRRetriever({
      embeddingAdapter: makeAdapter(candidates) as any,
      embeddingService: makeEmbedding([1, 0, 0]),
    });
    const results = await retriever.retrieve('query', { topK: 2 });
    expect(results).toHaveLength(2);
  });

  it('diversifies results (not just top similarity)', async () => {
    const candidates = [
      {
        id: '1',
        sourceId: 'c1',
        sourceType: 'document',
        content: 'Almost same A',
        vector: [1, 0, 0],
        score: 0.95,
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: '2',
        sourceId: 'c2',
        sourceType: 'document',
        content: 'Almost same B',
        vector: [0.99, 0.01, 0],
        score: 0.94,
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: '3',
        sourceId: 'c3',
        sourceType: 'document',
        content: 'Diverse C',
        vector: [0, 1, 0],
        score: 0.5,
        createdAt: new Date(),
        metadata: {},
      },
    ];
    const retriever = new MMRRetriever({
      embeddingAdapter: makeAdapter(candidates) as any,
      embeddingService: makeEmbedding([1, 0, 0]),
      defaultLambda: 0.5,
    });
    const results = await retriever.retrieve('query', { topK: 2 });
    const ids = results.map((r) => r.chunkId);
    expect(ids).toContain('c1');
    expect(ids).toContain('c3');
  });

  it('lambda=1.0 behaves like pure similarity', async () => {
    const candidates = [
      {
        id: '1',
        sourceId: 'c1',
        sourceType: 'document',
        content: 'A',
        vector: [1, 0, 0],
        score: 0.95,
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: '2',
        sourceId: 'c2',
        sourceType: 'document',
        content: 'B',
        vector: [0.99, 0.01, 0],
        score: 0.93,
        createdAt: new Date(),
        metadata: {},
      },
      {
        id: '3',
        sourceId: 'c3',
        sourceType: 'document',
        content: 'C',
        vector: [0, 1, 0],
        score: 0.5,
        createdAt: new Date(),
        metadata: {},
      },
    ];
    const retriever = new MMRRetriever({
      embeddingAdapter: makeAdapter(candidates) as any,
      embeddingService: makeEmbedding([1, 0, 0]),
      defaultLambda: 1.0,
    });
    const results = await retriever.retrieve('query', { topK: 2 });
    expect(results[0].chunkId).toBe('c1');
    expect(results[1].chunkId).toBe('c2');
  });

  it('returns empty for no candidates', async () => {
    const retriever = new MMRRetriever({
      embeddingAdapter: makeAdapter([]) as any,
      embeddingService: makeEmbedding([1, 0, 0]),
    });
    const results = await retriever.retrieve('query');
    expect(results).toEqual([]);
  });

  it('maps results to RetrievalResult format', async () => {
    const candidates = [
      {
        id: '1',
        sourceId: 'c1',
        sourceType: 'document',
        content: 'Content A',
        vector: [1, 0, 0],
        score: 0.9,
        createdAt: new Date(),
        metadata: { documentId: 'doc-1' },
      },
    ];
    const retriever = new MMRRetriever({
      embeddingAdapter: makeAdapter(candidates) as any,
      embeddingService: makeEmbedding([1, 0, 0]),
    });
    const results = await retriever.retrieve('query', { topK: 1 });
    expect(results[0]).toMatchObject({
      chunkId: 'c1',
      content: 'Content A',
      score: expect.any(Number),
    });
  });
});
