import { describe, it, expect, beforeEach } from 'vitest';
import { BM25Index } from '../search/bm25';
import { tokenize, getTermFrequency } from '../search/tokenizer';
import { reciprocalRankFusion, fuseSearchResults } from '../search/rrf';
import { HybridSearch } from '../search/hybrid-search';
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';
import type { EmbeddingService, SearchResult } from '@cogitator-ai/types';

describe('tokenizer', () => {
  it('tokenizes text with lowercase', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toEqual(['hello', 'world']);
  });

  it('removes stopwords by default', () => {
    const tokens = tokenize('The quick brown fox');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('removes punctuation', () => {
    const tokens = tokenize("Hello, world! How's it going?");
    expect(tokens.every((t) => /^[a-z]+$/.test(t))).toBe(true);
  });

  it('filters short tokens', () => {
    const tokens = tokenize('a ab abc abcd', { minLength: 3 });
    expect(tokens).not.toContain('ab');
    expect(tokens).toContain('abc');
    expect(tokens).toContain('abcd');
  });

  it('can keep stopwords', () => {
    const tokens = tokenize('The quick brown fox', { removeStopwords: false });
    expect(tokens).toContain('the');
  });

  it('calculates term frequency', () => {
    const freq = getTermFrequency(['hello', 'world', 'hello']);
    expect(freq.get('hello')).toBe(2);
    expect(freq.get('world')).toBe(1);
  });
});

describe('BM25Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  it('adds documents', () => {
    index.addDocument({ id: '1', content: 'hello world' });
    expect(index.size).toBe(1);
  });

  it('searches documents', () => {
    index.addDocument({ id: '1', content: 'hello world' });
    index.addDocument({ id: '2', content: 'goodbye world' });
    index.addDocument({ id: '3', content: 'hello there' });

    const results = index.search('hello');
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('1');
  });

  it('returns empty for no matches', () => {
    index.addDocument({ id: '1', content: 'hello world' });
    const results = index.search('xyz');
    expect(results.length).toBe(0);
  });

  it('removes documents', () => {
    index.addDocument({ id: '1', content: 'hello world' });
    expect(index.size).toBe(1);

    index.removeDocument('1');
    expect(index.size).toBe(0);

    const results = index.search('hello');
    expect(results.length).toBe(0);
  });

  it('updates document on re-add', () => {
    index.addDocument({ id: '1', content: 'hello world' });
    index.addDocument({ id: '1', content: 'goodbye world' });

    expect(index.size).toBe(1);

    const helloResults = index.search('hello');
    expect(helloResults.length).toBe(0);

    const goodbyeResults = index.search('goodbye');
    expect(goodbyeResults.length).toBe(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 20; i++) {
      index.addDocument({ id: String(i), content: `document ${i} test` });
    }

    const results = index.search('test', 5);
    expect(results.length).toBe(5);
  });

  it('scores longer matches higher', () => {
    index.addDocument({ id: '1', content: 'authentication' });
    index.addDocument({ id: '2', content: 'authentication flow implementation security' });

    const results = index.search('authentication flow');
    expect(results[0].id).toBe('2');
  });
});

describe('RRF (Reciprocal Rank Fusion)', () => {
  it('fuses two result sets', () => {
    const vectorResults: SearchResult[] = [
      { id: 'a', sourceId: 'a', sourceType: 'document', content: 'a', score: 0.9 },
      { id: 'b', sourceId: 'b', sourceType: 'document', content: 'b', score: 0.8 },
      { id: 'c', sourceId: 'c', sourceType: 'document', content: 'c', score: 0.7 },
    ];

    const keywordResults: SearchResult[] = [
      { id: 'b', sourceId: 'b', sourceType: 'document', content: 'b', score: 5.0 },
      { id: 'd', sourceId: 'd', sourceType: 'document', content: 'd', score: 4.0 },
      { id: 'a', sourceId: 'a', sourceType: 'document', content: 'a', score: 3.0 },
    ];

    const fused = fuseSearchResults(vectorResults, keywordResults, { bm25: 0.5, vector: 0.5 });

    expect(fused.length).toBe(4);
    expect(['a', 'b']).toContain(fused[0].id);
    expect(fused[0].vectorScore).toBeDefined();
    expect(fused[0].keywordScore).toBeDefined();
  });

  it('handles empty result sets', () => {
    const fused = fuseSearchResults([], [], { bm25: 0.5, vector: 0.5 });
    expect(fused.length).toBe(0);
  });

  it('respects weights', () => {
    const vector: SearchResult[] = [
      { id: 'a', sourceId: 'a', sourceType: 'document', content: 'a', score: 1.0 },
    ];
    const keyword: SearchResult[] = [
      { id: 'b', sourceId: 'b', sourceType: 'document', content: 'b', score: 1.0 },
    ];

    const vectorHeavy = fuseSearchResults(vector, keyword, { bm25: 0.1, vector: 0.9 });
    expect(vectorHeavy[0].id).toBe('a');

    const keywordHeavy = fuseSearchResults(vector, keyword, { bm25: 0.9, vector: 0.1 });
    expect(keywordHeavy[0].id).toBe('b');
  });
});

describe('InMemoryEmbeddingAdapter', () => {
  let adapter: InMemoryEmbeddingAdapter;

  beforeEach(() => {
    adapter = new InMemoryEmbeddingAdapter();
  });

  it('adds and retrieves embeddings', async () => {
    const result = await adapter.addEmbedding({
      sourceId: 'doc1',
      sourceType: 'document',
      vector: [1, 0, 0],
      content: 'hello world',
    });

    expect(result.success).toBe(true);
    expect(adapter.size).toBe(1);
  });

  it('performs vector search', async () => {
    await adapter.addEmbedding({
      sourceId: 'doc1',
      sourceType: 'document',
      vector: [1, 0, 0],
      content: 'hello world',
    });
    await adapter.addEmbedding({
      sourceId: 'doc2',
      sourceType: 'document',
      vector: [0, 1, 0],
      content: 'goodbye world',
    });

    const result = await adapter.search({
      vector: [1, 0, 0],
      threshold: 0.5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBe(1);
      expect(result.data[0].sourceId).toBe('doc1');
    }
  });

  it('performs keyword search', async () => {
    await adapter.addEmbedding({
      sourceId: 'doc1',
      sourceType: 'document',
      vector: [1, 0, 0],
      content: 'authentication flow implementation',
    });
    await adapter.addEmbedding({
      sourceId: 'doc2',
      sourceType: 'document',
      vector: [0, 1, 0],
      content: 'user registration process',
    });

    const result = await adapter.keywordSearch({
      query: 'authentication',
      limit: 10,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBe(1);
      expect(result.data[0].sourceId).toBe('doc1');
    }
  });
});

describe('HybridSearch', () => {
  let embeddingAdapter: InMemoryEmbeddingAdapter;
  let mockEmbeddingService: EmbeddingService;
  let hybridSearch: HybridSearch;

  beforeEach(async () => {
    embeddingAdapter = new InMemoryEmbeddingAdapter();
    mockEmbeddingService = {
      embed: async (text: string) => {
        if (text.includes('auth')) return [1, 0, 0];
        if (text.includes('user')) return [0, 1, 0];
        return [0, 0, 1];
      },
      embedBatch: async (texts: string[]) => texts.map(() => [0, 0, 1]),
      dimensions: 3,
      model: 'mock',
    };

    await embeddingAdapter.addEmbedding({
      sourceId: 'doc1',
      sourceType: 'document',
      vector: [1, 0, 0],
      content: 'authentication flow implementation',
    });
    await embeddingAdapter.addEmbedding({
      sourceId: 'doc2',
      sourceType: 'document',
      vector: [0, 1, 0],
      content: 'user registration process',
    });
    await embeddingAdapter.addEmbedding({
      sourceId: 'doc3',
      sourceType: 'document',
      vector: [0.7, 0.7, 0],
      content: 'authentication and user management',
    });

    hybridSearch = new HybridSearch({
      embeddingAdapter,
      embeddingService: mockEmbeddingService,
      keywordAdapter: embeddingAdapter,
    });
  });

  it('performs vector-only search', async () => {
    const result = await hybridSearch.search({
      query: 'auth system',
      strategy: 'vector',
      limit: 5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].sourceId).toBe('doc1');
    }
  });

  it('performs keyword-only search', async () => {
    const result = await hybridSearch.search({
      query: 'authentication',
      strategy: 'keyword',
      limit: 5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.some((r) => r.content.includes('authentication'))).toBe(true);
    }
  });

  it('performs hybrid search', async () => {
    const result = await hybridSearch.search({
      query: 'authentication',
      strategy: 'hybrid',
      weights: { bm25: 0.4, vector: 0.6 },
      limit: 5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
      const top = result.data[0];
      expect(top.vectorScore !== undefined || top.keywordScore !== undefined).toBe(true);
    }
  });

  it('uses local BM25 when no keyword adapter provided', async () => {
    const searchWithoutKeywordAdapter = new HybridSearch({
      embeddingAdapter,
      embeddingService: mockEmbeddingService,
    });

    searchWithoutKeywordAdapter.indexDocument('local1', 'test document content');
    searchWithoutKeywordAdapter.indexDocument('local2', 'another test file');

    const result = await searchWithoutKeywordAdapter.search({
      query: 'test',
      strategy: 'keyword',
      limit: 5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBe(2);
    }
  });
});
