import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SimilarityRetriever } from '../retrievers/similarity-retriever';
import type { EmbeddingAdapter, EmbeddingService } from '@cogitator-ai/types';

describe('SimilarityRetriever', () => {
  let mockAdapter: EmbeddingAdapter;
  let mockEmbedding: EmbeddingService;
  let retriever: SimilarityRetriever;

  beforeEach(() => {
    mockAdapter = {
      search: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: 'emb-1',
            sourceId: 'chunk-1',
            sourceType: 'document',
            content: 'Relevant content',
            vector: [1, 0, 0],
            createdAt: new Date(),
            score: 0.95,
            metadata: { documentId: 'doc-1' },
          },
          {
            id: 'emb-2',
            sourceId: 'chunk-2',
            sourceType: 'document',
            content: 'Also relevant',
            vector: [0.9, 0.1, 0],
            createdAt: new Date(),
            score: 0.8,
            metadata: { documentId: 'doc-1' },
          },
        ],
      }),
      addEmbedding: vi.fn(),
      deleteEmbedding: vi.fn(),
      deleteBySource: vi.fn(),
    } as unknown as EmbeddingAdapter;

    mockEmbedding = {
      embed: vi.fn().mockResolvedValue([1, 0, 0]),
      embedBatch: vi.fn(),
      dimensions: 3,
      model: 'test',
    };

    retriever = new SimilarityRetriever({
      embeddingAdapter: mockAdapter,
      embeddingService: mockEmbedding,
    });
  });

  it('embeds query and searches adapter', async () => {
    const results = await retriever.retrieve('test query');
    expect(mockEmbedding.embed).toHaveBeenCalledWith('test query');
    expect(mockAdapter.search).toHaveBeenCalled();
    expect(results).toHaveLength(2);
  });

  it('maps adapter results to RetrievalResult format', async () => {
    const results = await retriever.retrieve('test');
    expect(results[0]).toMatchObject({
      chunkId: 'chunk-1',
      content: 'Relevant content',
      score: 0.95,
    });
  });

  it('passes topK and threshold to adapter', async () => {
    await retriever.retrieve('test', { topK: 5, threshold: 0.8 });
    expect(mockAdapter.search).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 5,
        threshold: 0.8,
      })
    );
  });

  it('uses default config when no options provided', async () => {
    const r = new SimilarityRetriever({
      embeddingAdapter: mockAdapter,
      embeddingService: mockEmbedding,
      defaultTopK: 20,
      defaultThreshold: 0.3,
    });
    await r.retrieve('test');
    expect(mockAdapter.search).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
        threshold: 0.3,
      })
    );
  });

  it('returns empty array when adapter returns no results', async () => {
    (mockAdapter.search as any).mockResolvedValue({ success: true, data: [] });
    const results = await retriever.retrieve('test');
    expect(results).toEqual([]);
  });

  it('throws when adapter returns error', async () => {
    (mockAdapter.search as any).mockResolvedValue({ success: false, error: 'Connection failed' });
    await expect(retriever.retrieve('test')).rejects.toThrow('Connection failed');
  });
});
