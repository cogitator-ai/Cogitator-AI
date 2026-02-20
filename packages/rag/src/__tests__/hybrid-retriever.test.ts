import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HybridRetriever } from '../retrievers/hybrid-retriever';
import type { HybridSearch } from '@cogitator-ai/memory';

describe('HybridRetriever', () => {
  let mockHybridSearch: HybridSearch;
  let retriever: HybridRetriever;

  const searchResults = [
    {
      id: 'sr-1',
      sourceId: 'chunk-1',
      sourceType: 'document' as const,
      content: 'First result',
      score: 0.92,
      vectorScore: 0.95,
      keywordScore: 0.7,
      metadata: { documentId: 'doc-1' },
    },
    {
      id: 'sr-2',
      sourceId: 'chunk-2',
      sourceType: 'document' as const,
      content: 'Second result',
      score: 0.85,
      vectorScore: 0.8,
      keywordScore: 0.9,
      metadata: { documentId: 'doc-1' },
    },
  ];

  beforeEach(() => {
    mockHybridSearch = {
      search: vi.fn().mockResolvedValue({ success: true, data: searchResults }),
      indexDocument: vi.fn(),
      removeDocument: vi.fn(),
      clearIndex: vi.fn(),
    } as unknown as HybridSearch;

    retriever = new HybridRetriever({ hybridSearch: mockHybridSearch });
  });

  it('delegates to hybridSearch.search with strategy=hybrid', async () => {
    await retriever.retrieve('test query');
    expect(mockHybridSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'test query',
        strategy: 'hybrid',
      })
    );
  });

  it('maps SearchResult to RetrievalResult', async () => {
    const results = await retriever.retrieve('test');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      content: 'First result',
      score: 0.92,
    });
    expect(results[1]).toMatchObject({
      chunkId: 'chunk-2',
      documentId: 'doc-1',
      content: 'Second result',
      score: 0.85,
    });
  });

  it('passes topK as limit to search', async () => {
    await retriever.retrieve('test', { topK: 5 });
    expect(mockHybridSearch.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('passes threshold to search', async () => {
    await retriever.retrieve('test', { threshold: 0.7 });
    expect(mockHybridSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 0.7 })
    );
  });

  it('uses default weights when configured', async () => {
    const r = new HybridRetriever({
      hybridSearch: mockHybridSearch,
      defaultWeights: { bm25: 0.3, vector: 0.7 },
    });
    await r.retrieve('test');
    expect(mockHybridSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({
        weights: { bm25: 0.3, vector: 0.7 },
      })
    );
  });

  it('returns empty array when search returns no results', async () => {
    (mockHybridSearch.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [],
    });
    const results = await retriever.retrieve('test');
    expect(results).toEqual([]);
  });

  it('throws when search returns error', async () => {
    (mockHybridSearch.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'Search failed',
    });
    await expect(retriever.retrieve('test')).rejects.toThrow('Search failed');
  });

  it('uses sourceId as documentId fallback when metadata.documentId is missing', async () => {
    (mockHybridSearch.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'sr-3',
          sourceId: 'chunk-3',
          sourceType: 'document',
          content: 'No doc id',
          score: 0.8,
        },
      ],
    });
    const results = await retriever.retrieve('test');
    expect(results[0].documentId).toBe('chunk-3');
  });
});
