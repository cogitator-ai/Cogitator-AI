import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MultiQueryRetriever } from '../retrievers/multi-query-retriever';
import type { Retriever, RetrievalResult } from '@cogitator-ai/types';

describe('MultiQueryRetriever', () => {
  let mockBaseRetriever: Retriever;
  let mockExpandQuery: (query: string) => Promise<string[]>;
  let retriever: MultiQueryRetriever;

  const makeResult = (chunkId: string, score: number, documentId = 'doc-1'): RetrievalResult => ({
    chunkId,
    documentId,
    content: `Content of ${chunkId}`,
    score,
  });

  beforeEach(() => {
    mockExpandQuery = vi
      .fn()
      .mockResolvedValue(['expanded query 1', 'expanded query 2', 'expanded query 3']);

    mockBaseRetriever = {
      retrieve: vi.fn().mockImplementation((query: string) => {
        if (query === 'expanded query 1') {
          return Promise.resolve([makeResult('chunk-1', 0.95), makeResult('chunk-2', 0.8)]);
        }
        if (query === 'expanded query 2') {
          return Promise.resolve([makeResult('chunk-1', 0.9), makeResult('chunk-3', 0.85)]);
        }
        if (query === 'expanded query 3') {
          return Promise.resolve([makeResult('chunk-4', 0.7), makeResult('chunk-2', 0.75)]);
        }
        return Promise.resolve([]);
      }),
    };

    retriever = new MultiQueryRetriever({
      baseRetriever: mockBaseRetriever,
      expandQuery: mockExpandQuery,
    });
  });

  it('calls expandQuery with the original query', async () => {
    await retriever.retrieve('original query');
    expect(mockExpandQuery).toHaveBeenCalledWith('original query');
  });

  it('runs base retriever on each expanded query variant', async () => {
    await retriever.retrieve('original query');
    expect(mockBaseRetriever.retrieve).toHaveBeenCalledTimes(3);
    const calls = (mockBaseRetriever.retrieve as ReturnType<typeof vi.fn>).mock.calls;
    const queries = calls.map((c) => c[0]);
    expect(queries).toContain('expanded query 1');
    expect(queries).toContain('expanded query 2');
    expect(queries).toContain('expanded query 3');
  });

  it('deduplicates results by chunkId', async () => {
    const results = await retriever.retrieve('original query');
    const chunkIds = results.map((r) => r.chunkId);
    const uniqueIds = new Set(chunkIds);
    expect(chunkIds.length).toBe(uniqueIds.size);
  });

  it('keeps max score for duplicate chunks', async () => {
    const results = await retriever.retrieve('original query');
    const chunk1 = results.find((r) => r.chunkId === 'chunk-1');
    expect(chunk1?.score).toBe(0.95);

    const chunk2 = results.find((r) => r.chunkId === 'chunk-2');
    expect(chunk2?.score).toBe(0.8);
  });

  it('sorts results by score descending', async () => {
    const results = await retriever.retrieve('original query');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('respects topK option', async () => {
    const results = await retriever.retrieve('original query', { topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('passes retrieval options to base retriever', async () => {
    await retriever.retrieve('query', { topK: 5, threshold: 0.5 });
    expect(mockBaseRetriever.retrieve).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ topK: 5, threshold: 0.5 })
    );
  });

  it('returns all unique results when topK is larger', async () => {
    const results = await retriever.retrieve('original query', { topK: 100 });
    expect(results).toHaveLength(4);
  });

  it('handles empty expand results', async () => {
    (mockExpandQuery as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const results = await retriever.retrieve('query');
    expect(results).toEqual([]);
  });
});
