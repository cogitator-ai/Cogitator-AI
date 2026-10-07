import { describe, it, expect } from 'vitest';
import type { EmbeddingService } from '@cogitator-ai/types';
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';
import { HybridSearch } from '../search/hybrid-search';

const embeddings: EmbeddingService = {
  dimensions: 2,
  model: 'fake',
  embed: async () => [1, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0]),
};

async function seeded(): Promise<InMemoryEmbeddingAdapter> {
  const store = new InMemoryEmbeddingAdapter();
  await store.addEmbedding({
    sourceId: 'c1',
    sourceType: 'document',
    vector: [1, 0],
    content: 'cats chapter one',
    metadata: { source: '/a.md', namespace: 'docs' },
  });
  await store.addEmbedding({
    sourceId: 'c2',
    sourceType: 'document',
    vector: [1, 0],
    content: 'cats chapter two',
    metadata: { source: '/b.md', namespace: 'docs' },
  });
  await store.addEmbedding({
    sourceId: 'f1',
    sourceType: 'fact',
    vector: [1, 0],
    content: 'cats are private',
    metadata: { source: '/a.md', userId: 'alice' },
  });
  return store;
}

describe('embedding metadata filters', () => {
  it('searches by metadata values', async () => {
    const store = await seeded();

    const found = await store.search({
      vector: [1, 0],
      threshold: 0,
      filter: { sourceType: 'document', metadata: { source: '/a.md' } },
    });

    expect(found.success && found.data.map((e) => e.sourceId)).toEqual(['c1']);
  });

  it('deletes only what a filter matches', async () => {
    const store = await seeded();

    const deleted = await store.deleteByFilter({
      sourceType: 'document',
      metadata: { source: '/a.md' },
    });

    expect(deleted.success).toBe(true);
    const left = await store.search({ vector: [1, 0], threshold: 0 });
    expect(left.success && left.data.map((e) => e.sourceId).sort()).toEqual(['c2', 'f1']);
    const keyword = await store.keywordSearch({ query: 'chapter' });
    expect(keyword.success && keyword.data.map((e) => e.sourceId)).toEqual(['c2']);
  });

  it('refuses a delete filter without conditions', async () => {
    const store = await seeded();

    const deleted = await store.deleteByFilter({ metadata: {} });

    expect(deleted.success).toBe(false);
    expect(store.size).toBe(3);
  });

  it('filters the local keyword index of HybridSearch by indexed metadata', async () => {
    const store = await seeded();
    const search = new HybridSearch({ embeddingAdapter: store, embeddingService: embeddings });
    search.indexDocument('k1', 'cats in the docs', { namespace: 'docs' });
    search.indexDocument('k2', 'cats in the wiki', { namespace: 'wiki' });

    const result = await search.search({
      query: 'cats',
      strategy: 'keyword',
      filter: { sourceType: 'document', metadata: { namespace: 'wiki' } },
    });

    expect(result.success && result.data.map((r) => r.id)).toEqual(['k2']);
  });
});
