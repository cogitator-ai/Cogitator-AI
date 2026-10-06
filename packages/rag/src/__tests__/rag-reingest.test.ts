import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingService } from '@cogitator-ai/types';
import { HybridSearch, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';
import { RAGPipelineBuilder } from '../rag-builder';
import { TextLoader } from '../loaders/text-loader';

const VOCABULARY = ['cats', 'dogs', 'tea', 'coffee', 'alice', 'secret', 'paris', 'rome'];

function vectorOf(text: string): number[] {
  const words = text.toLowerCase().split(/\W+/);
  return VOCABULARY.map((word) => words.filter((w) => w === word).length + 0.01);
}

const embeddings: EmbeddingService = {
  dimensions: VOCABULARY.length,
  model: 'bag-of-words',
  embed: async (text) => vectorOf(text),
  embedBatch: async (texts) => texts.map(vectorOf),
};

function pipeline(
  store: InMemoryEmbeddingAdapter,
  options: {
    namespace?: string;
    strategy?: 'similarity' | 'hybrid' | 'mmr';
    keywordStore?: boolean;
  } = {}
) {
  const builder = new RAGPipelineBuilder();
  if (options.strategy === 'hybrid') {
    builder.withHybridSearch(
      new HybridSearch({
        embeddingAdapter: store,
        embeddingService: embeddings,
        ...(options.keywordStore && { keywordAdapter: store }),
      })
    );
  }
  return builder
    .withLoader(new TextLoader())
    .withEmbeddingService(embeddings)
    .withEmbeddingAdapter(store)
    .withConfig({
      chunking: { strategy: 'recursive', chunkSize: 60, chunkOverlap: 0 },
      retrieval: {
        strategy: options.strategy ?? 'similarity',
        topK: 20,
        threshold: 0,
        ...(options.strategy === 'mmr' && { mmrLambda: 0.5 }),
      },
      ...(options.namespace && { namespace: options.namespace }),
    })
    .build();
}

describe('RAG re-ingest and scoping', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cogitator-rag-'));
    file = join(dir, 'notes.txt');
    writeFileSync(
      file,
      'Cats sleep all day long in the sun.\n\nDogs love long walks in the park.\n\nTea is served at five in the afternoon.'
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the chunks of a source ingested again instead of duplicating them', async () => {
    const store = new InMemoryEmbeddingAdapter();
    const rag = pipeline(store);

    const first = await rag.ingest(file);
    const firstIds = (await rag.query('cats')).map((r) => r.documentId);
    await rag.ingest(file);

    expect(store.size).toBe(first.chunks);
    const results = await rag.query('cats');
    expect(results.filter((r) => r.content.includes('Cats'))).toHaveLength(1);
    expect(new Set(results.map((r) => r.documentId))).toEqual(new Set(firstIds));
  });

  it('drops text that was removed from the source', async () => {
    const store = new InMemoryEmbeddingAdapter();
    const rag = pipeline(store);
    await rag.ingest(file);

    writeFileSync(file, 'Coffee replaced tea in the afternoon.');
    await rag.ingest(file);

    const contents = (await rag.query('tea cats dogs coffee')).map((r) => r.content);
    expect(contents).toEqual(['Coffee replaced tea in the afternoon.']);
  });

  it('removes a source', async () => {
    const store = new InMemoryEmbeddingAdapter();
    const rag = pipeline(store);
    await rag.ingest(file);

    await rag.removeSource(file);

    expect(store.size).toBe(0);
    expect(await rag.query('cats')).toEqual([]);
  });

  it('keeps the keyword index of a hybrid retriever in step with re-ingest', async () => {
    const store = new InMemoryEmbeddingAdapter();
    const rag = pipeline(store, { strategy: 'hybrid' });
    await rag.ingest(file);

    writeFileSync(file, 'Rome is warm in summer.');
    await rag.ingest(file);

    const contents = (await rag.query('cats dogs tea rome')).map((r) => r.content);
    expect(contents).toEqual(['Rome is warm in summer.']);
  });

  it('never returns private memory stored in the same embedding store', async () => {
    const store = new InMemoryEmbeddingAdapter();
    await store.addEmbedding({
      sourceId: 'fact-1',
      sourceType: 'fact',
      vector: vectorOf('alice secret cats'),
      content: 'Alice told the bot a secret about her cats',
      metadata: { userId: 'alice' },
    });
    await store.addEmbedding({
      sourceId: 'msg-1',
      sourceType: 'message',
      vector: vectorOf('cats'),
      content: 'user: my cats are sick',
      metadata: { userId: 'bob', threadId: 't1' },
    });

    const variants = [
      { strategy: 'similarity' },
      { strategy: 'mmr' },
      { strategy: 'hybrid' },
      { strategy: 'hybrid', keywordStore: true },
    ] as const;
    for (const variant of variants) {
      const rag = pipeline(store, variant);
      await rag.ingest(file);
      const results = await rag.query('alice secret cats');
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => !r.content.includes('Alice'))).toBe(true);
      expect(results.every((r) => !r.content.includes('sick'))).toBe(true);
    }
  });

  it('keeps pipelines with different namespaces apart in one store', async () => {
    const store = new InMemoryEmbeddingAdapter();
    const docs = pipeline(store, { namespace: 'docs' });
    const wiki = pipeline(store, { namespace: 'wiki' });
    const other = join(dir, 'other.txt');
    writeFileSync(other, 'Paris has many cafes.');

    await docs.ingest(file);
    await wiki.ingest(other);
    await wiki.ingest(file);

    expect((await docs.query('paris')).some((r) => r.content.includes('Paris'))).toBe(false);
    expect((await wiki.query('paris')).some((r) => r.content.includes('Paris'))).toBe(true);
    await wiki.removeSource(file);
    expect((await docs.query('cats')).some((r) => r.content.includes('Cats'))).toBe(true);
  });
});
