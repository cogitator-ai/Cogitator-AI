import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Chunker,
  DocumentLoader,
  EmbeddingAdapter,
  EmbeddingService,
  RAGDocument,
} from '@cogitator-ai/types';
import { HybridSearch, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';
import { RAGPipelineBuilder } from '../rag-builder';
import { TextLoader } from '../loaders/text-loader';
import { documentId } from '../loaders/document-id';
import { chunkId } from '../chunkers/chunk-id';

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

describe('RAG ingest of unchanged and changed sources', () => {
  /** A source of several parts, as a loader of PDF pages or CSV rows returns them */
  class PartsLoader implements DocumentLoader {
    readonly supportedTypes = ['parts'];
    parts: string[] = [];
    load(source: string): Promise<RAGDocument[]> {
      return Promise.resolve(
        this.parts.map((content, part) => ({
          id: documentId(source, part),
          content,
          source,
          sourceType: 'text' as const,
          metadata: { part },
        }))
      );
    }
  }

  function counted(): EmbeddingService & { embedBatch: ReturnType<typeof vi.fn> } {
    return {
      dimensions: VOCABULARY.length,
      model: 'bag-of-words',
      embed: async (text) => vectorOf(text),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(vectorOf)),
    };
  }

  function partsPipeline(
    store: EmbeddingAdapter,
    loader: PartsLoader,
    embedding: EmbeddingService,
    chunkSize = 60,
    configure: (builder: RAGPipelineBuilder) => RAGPipelineBuilder = (builder) => builder
  ) {
    return configure(
      new RAGPipelineBuilder()
        .withLoader(loader)
        .withEmbeddingService(embedding)
        .withEmbeddingAdapter(store)
        .withConfig({
          chunking: { strategy: 'recursive', chunkSize, chunkOverlap: 0 },
          retrieval: { strategy: 'similarity', topK: 20, threshold: 0 },
        })
    ).build();
  }

  const embeddedTexts = (embedding: ReturnType<typeof counted>) =>
    embedding.embedBatch.mock.calls.flatMap(([texts]) => texts as string[]);

  async function contents(store: InMemoryEmbeddingAdapter): Promise<string[]> {
    const found = await store.search({ vector: vectorOf('x'), threshold: -1, limit: 100 });
    if (!found.success) throw new Error(found.error);
    return found.data.map((result) => result.content).sort();
  }

  let store: InMemoryEmbeddingAdapter;
  let loader: PartsLoader;
  let embedding: ReturnType<typeof counted>;

  beforeEach(() => {
    store = new InMemoryEmbeddingAdapter();
    loader = new PartsLoader();
    embedding = counted();
  });

  it('leaves an unchanged source as stored, embedding and writing nothing', async () => {
    loader.parts = ['Cats sleep all day.', 'Dogs love walks.'];
    const rag = partsPipeline(store, loader, embedding);
    await rag.ingest('book');
    embedding.embedBatch.mockClear();
    const add = vi.spyOn(store, 'addEmbedding');
    const remove = vi.spyOn(store, 'deleteByFilter');

    const again = await rag.ingest('book');

    expect(again).toEqual({ documents: 2, chunks: 0, unchanged: 2 });
    expect(embedding.embedBatch).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await contents(store)).toEqual(['Cats sleep all day.', 'Dogs love walks.']);
  });

  it('embeds only the changed part of a source and keeps the vectors of the rest', async () => {
    loader.parts = ['Cats sleep all day.', 'Dogs love walks.', 'Tea at five.'];
    const rag = partsPipeline(store, loader, embedding);
    await rag.ingest('book');
    embedding.embedBatch.mockClear();

    loader.parts = ['Cats sleep all day.', 'Dogs love long walks in Rome.', 'Tea at five.'];
    const again = await rag.ingest('book');

    expect(again).toMatchObject({ documents: 3, unchanged: 0 });
    expect(embeddedTexts(embedding)).toEqual(['Dogs love long walks in Rome.']);
    expect(await contents(store)).toEqual([
      'Cats sleep all day.',
      'Dogs love long walks in Rome.',
      'Tea at five.',
    ]);
  });

  it('writes the new chunks of a changed source before deleting the old ones', async () => {
    loader.parts = ['Cats sleep all day.'];
    const rag = partsPipeline(store, loader, embedding);
    await rag.ingest('book');
    const order: string[] = [];
    const add = store.addEmbedding.bind(store);
    vi.spyOn(store, 'addEmbedding').mockImplementation(async (embedding) => {
      order.push(`add ${embedding.content}`);
      return add(embedding);
    });
    const remove = store.deleteByFilter.bind(store);
    vi.spyOn(store, 'deleteByFilter').mockImplementation(async (filter) => {
      order.push(`delete ${(await contents(store)).join(' | ')}`);
      return remove(filter);
    });

    loader.parts = ['Cats nap in Paris.'];
    await rag.ingest('book');

    expect(order).toEqual([
      'add Cats nap in Paris.',
      'delete Cats nap in Paris. | Cats sleep all day.',
    ]);
    expect(await contents(store)).toEqual(['Cats nap in Paris.']);
  });

  it('drops a part the source no longer has', async () => {
    loader.parts = ['Cats sleep all day.', 'Dogs love walks.'];
    const rag = partsPipeline(store, loader, embedding);
    await rag.ingest('book');

    loader.parts = ['Cats sleep all day.'];
    const again = await rag.ingest('book');

    expect(again.unchanged).toBe(0);
    expect(await contents(store)).toEqual(['Cats sleep all day.']);
  });

  it('embeds everything again when the chunking changes', async () => {
    loader.parts = ['Cats sleep all day. Dogs love walks.'];
    await partsPipeline(store, loader, embedding, 60).ingest('book');
    embedding.embedBatch.mockClear();

    await partsPipeline(store, loader, embedding, 20).ingest('book');

    expect(embedding.embedBatch).toHaveBeenCalled();
    expect((await contents(store)).length).toBeGreaterThan(1);
  });

  it('replaces chunks stored before generations', async () => {
    loader.parts = ['Cats sleep all day.'];
    const legacyDoc = documentId('book', 0);
    await store.addEmbedding({
      sourceId: chunkId(legacyDoc, 0),
      sourceType: 'document',
      vector: vectorOf('old cats'),
      content: 'old cats',
      metadata: { source: 'book', documentId: legacyDoc, order: 0 },
    });
    await store.addEmbedding({
      sourceId: chunkId(legacyDoc, 1),
      sourceType: 'document',
      vector: vectorOf('old dogs'),
      content: 'old dogs',
      metadata: { source: 'book', documentId: legacyDoc, order: 1 },
    });

    const result = await partsPipeline(store, loader, embedding).ingest('book');

    expect(result.unchanged).toBe(0);
    expect(await contents(store)).toEqual(['Cats sleep all day.']);
  });

  it('finishes a source an ingest stopped writing instead of taking it as unchanged', async () => {
    loader.parts = ['Cats sleep. Dogs walk. Tea at five. Coffee at nine. Rome in May.'];
    const rag = partsPipeline(store, loader, embedding, 12);
    const add = store.addEmbedding.bind(store);
    let calls = 0;
    vi.spyOn(store, 'addEmbedding').mockImplementation(async (chunk) => {
      calls++;
      if (calls === 2) return { success: false, error: 'store hiccup' };
      return add(chunk);
    });
    await expect(rag.ingest('book')).rejects.toThrow('store hiccup');
    vi.mocked(store.addEmbedding).mockRestore();

    const again = await rag.ingest('book');

    expect(again.unchanged).toBe(0);
    expect((await contents(store)).length).toBe(again.chunks);
  });

  it('never takes a source as unchanged with a chunker that has no fingerprint', async () => {
    let size = 10;
    const custom: Chunker = {
      chunk: (text, documentId) =>
        (text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []).map((content, order) => ({
          id: chunkId(documentId, order),
          documentId,
          content,
          startOffset: order * size,
          endOffset: order * size + content.length,
          order,
        })),
    };
    loader.parts = ['Cats sleep all day long.'];
    const rag = partsPipeline(store, loader, embedding, 60, (b) => b.withChunker(custom));
    await rag.ingest('book');

    size = 5;
    const again = await rag.ingest('book');

    expect(again.unchanged).toBe(0);
    expect(await contents(store)).toEqual(['Cats ', 'sleep', ' all ', 'day l', 'ong.'].sort());
  });

  it('fills the local keyword index of a new pipeline from an unchanged source', async () => {
    loader.parts = ['Cats sleep all day.', 'Tea at five.'];
    const hybrid = (builder: RAGPipelineBuilder) =>
      builder
        .withHybridSearch(
          new HybridSearch({ embeddingAdapter: store, embeddingService: embedding })
        )
        .withConfig({
          chunking: { strategy: 'recursive', chunkSize: 60, chunkOverlap: 0 },
          retrieval: { strategy: 'hybrid', topK: 5, threshold: 0 },
        });
    await partsPipeline(store, loader, embedding, 60, hybrid).ingest('book');

    const restarted = partsPipeline(store, loader, embedding, 60, hybrid);
    const again = await restarted.ingest('book');
    const results = await restarted.query('cats');

    expect(again.unchanged).toBe(2);
    const cats = results.find((r) => r.content.includes('Cats'));
    expect(cats?.metadata?.keywordScore).toBeGreaterThan(0);
  });

  it('replaces sources as before in a store without deleteByFilter, with a warning', async () => {
    const appendOnly = new Proxy(store, {
      get(target, property) {
        if (property === 'deleteByFilter') return undefined;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loader.parts = ['Cats sleep all day.'];
    const rag = partsPipeline(appendOnly, loader, embedding);
    await rag.ingest('book');
    await rag.ingest('book');
    const warned = warn.mock.calls.some(([text]) => String(text).includes('deleteByFilter'));
    warn.mockRestore();

    expect(warned).toBe(true);
  });

  it('keeps document metadata named like the ingest marks', async () => {
    loader.parts = ['Cats sleep all day.'];
    const withOwn: PartsLoader = Object.assign(Object.create(PartsLoader.prototype), loader, {
      load: async (source: string) =>
        (await loader.load(source)).map((doc) => ({
          ...doc,
          metadata: { ...doc.metadata, generation: 'v2 of the handbook', contentHash: 'abc' },
        })),
    });
    const rag = partsPipeline(store, withOwn, embedding);
    await rag.ingest('book');

    const found = await store.search({ vector: vectorOf('cats'), threshold: -1 });
    const stored = found.success ? found.data[0] : undefined;
    expect(stored?.metadata).toMatchObject({
      generation: 'v2 of the handbook',
      contentHash: 'abc',
    });
  });

  async function failingOnce(atCall: number, work: () => Promise<unknown>) {
    const add = store.addEmbedding.bind(store);
    let calls = 0;
    const spy = vi.spyOn(store, 'addEmbedding').mockImplementation(async (chunk) => {
      calls++;
      if (calls === atCall) return { success: false, error: 'store hiccup' };
      return add(chunk);
    });
    await expect(work()).rejects.toThrow('store hiccup');
    spy.mockRestore();
  }

  it('deletes what an update that stopped wrote once the next one succeeds', async () => {
    loader.parts = ['Cats sleep. Dogs walk. Tea at five.'];
    const rag = partsPipeline(store, loader, embedding, 12);
    await rag.ingest('book');

    loader.parts = ['Cats nap. Dogs run far. Tea at six. Rome in May.'];
    await failingOnce(3, () => rag.ingest('book'));
    loader.parts = ['Cats nap. Dogs run far. Tea at six. Rome in June.'];
    const done = await rag.ingest('book');

    expect((await contents(store)).length).toBe(done.chunks);
    expect(await rag.ingest('book')).toMatchObject({ unchanged: 1 });
  });

  it('deletes what an update that stopped wrote when the source went back to what is stored', async () => {
    loader.parts = ['Cats sleep. Dogs walk. Tea at five.'];
    const rag = partsPipeline(store, loader, embedding, 12);
    const first = await rag.ingest('book');
    const before = await contents(store);

    loader.parts = ['Cats nap. Dogs run far. Tea at six. Rome in May.'];
    await failingOnce(3, () => rag.ingest('book'));
    loader.parts = ['Cats sleep. Dogs walk. Tea at five.'];
    const again = await rag.ingest('book');

    expect(again.unchanged).toBe(1);
    expect(await contents(store)).toEqual(before);
    expect(before.length).toBe(first.chunks);
  });
});
