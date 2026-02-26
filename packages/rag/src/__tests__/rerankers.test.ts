import { describe, it, expect, vi } from 'vitest';
import { LLMReranker } from '../rerankers/llm-reranker';
import { CohereReranker } from '../rerankers/cohere-reranker';
import type { RetrievalResult } from '@cogitator-ai/types';

const sampleResults: RetrievalResult[] = [
  { chunkId: 'c1', documentId: 'd1', content: 'TypeScript is a language', score: 0.8 },
  { chunkId: 'c2', documentId: 'd2', content: 'Python is popular', score: 0.7 },
  { chunkId: 'c3', documentId: 'd3', content: 'JavaScript runs in browsers', score: 0.6 },
];

describe('LLMReranker', () => {
  it('reranks results using LLM scores', async () => {
    const generateFn = vi.fn().mockResolvedValue(
      JSON.stringify([
        { index: 0, score: 5 },
        { index: 1, score: 2 },
        { index: 2, score: 9 },
      ])
    );
    const reranker = new LLMReranker({ generateFn });
    const results = await reranker.rerank('JavaScript question', sampleResults);
    expect(results[0].chunkId).toBe('c3');
    expect(results[1].chunkId).toBe('c1');
  });

  it('respects topN', async () => {
    const generateFn = vi.fn().mockResolvedValue(
      JSON.stringify([
        { index: 0, score: 5 },
        { index: 1, score: 2 },
        { index: 2, score: 9 },
      ])
    );
    const reranker = new LLMReranker({ generateFn });
    const results = await reranker.rerank('query', sampleResults, 2);
    expect(results).toHaveLength(2);
  });

  it('falls back to original order on LLM failure', async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    const reranker = new LLMReranker({ generateFn });
    const results = await reranker.rerank('query', sampleResults);
    expect(results.map((r) => r.chunkId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('falls back on invalid JSON', async () => {
    const generateFn = vi.fn().mockResolvedValue('not json at all');
    const reranker = new LLMReranker({ generateFn });
    const results = await reranker.rerank('query', sampleResults);
    expect(results).toHaveLength(3);
  });

  it('returns empty array for empty results', async () => {
    const generateFn = vi.fn();
    const reranker = new LLMReranker({ generateFn });
    const results = await reranker.rerank('query', []);
    expect(results).toEqual([]);
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('clamps scores to [0, 1] range', async () => {
    const generateFn = vi.fn().mockResolvedValue(
      JSON.stringify([
        { index: 0, score: 15 },
        { index: 1, score: -3 },
      ])
    );
    const reranker = new LLMReranker({ generateFn });
    const results = await reranker.rerank('query', sampleResults);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('CohereReranker', () => {
  it('calls Cohere API with correct payload', async () => {
    const mockResponse = {
      results: [
        { index: 2, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.8 },
        { index: 1, relevance_score: 0.3 },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const reranker = new CohereReranker({ apiKey: 'test-key' });
    const results = await reranker.rerank('query', sampleResults, 2);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.cohere.com/v2/rerank',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      })
    );

    expect(results).toHaveLength(2);
    expect(results[0].chunkId).toBe('c3');
    expect(results[0].score).toBe(0.95);

    vi.unstubAllGlobals();
  });

  it('returns empty array for empty results', async () => {
    const reranker = new CohereReranker({ apiKey: 'test-key' });
    const results = await reranker.rerank('query', []);
    expect(results).toEqual([]);
  });

  it('filters out-of-bounds indices from API response', async () => {
    const mockResponse = {
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 99, relevance_score: 0.8 },
        { index: -1, relevance_score: 0.7 },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })
    );

    const reranker = new CohereReranker({ apiKey: 'test-key' });
    const results = await reranker.rerank('query', sampleResults);
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe('c1');

    vi.unstubAllGlobals();
  });

  it('throws on API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      })
    );

    const reranker = new CohereReranker({ apiKey: 'bad-key' });
    await expect(reranker.rerank('query', sampleResults)).rejects.toThrow();

    vi.unstubAllGlobals();
  });
});
