import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { HybridSearch, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';
import type {
  DocumentLoader,
  Embedding,
  EmbeddingAdapter,
  EmbeddingService,
  RAGDocument,
  Retriever,
  RetrievalResult,
} from '@cogitator-ai/types';
import packageJson from '../../package.json' with { type: 'json' };
import {
  VERSION,
  RAGPipeline,
  RAGPipelineBuilder,
  RecursiveChunker,
  SemanticChunker,
  MMRRetriever,
  MultiQueryRetriever,
  HybridRetriever,
  SimilarityRetriever,
  MarkdownLoader,
  TextLoader,
  HTMLLoader,
  createIngestTool,
  createSearchTool,
} from '../index';

const TMP = mkdtempSync(join(tmpdir(), 'cogitator-rag-audit-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const VOCAB = ['cat', 'dog', 'fish', 'car', 'road', 'engine', 'sun', 'moon', 'star', 'code'];

function bagOfWords(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const vector = VOCAB.map((term) => words.filter((w) => w.startsWith(term)).length);
  return vector.some((v) => v > 0) ? vector : VOCAB.map((_, i) => (i === 0 ? 0.001 : 0));
}

function bowService(): EmbeddingService & { embedBatch: ReturnType<typeof vi.fn> } {
  return {
    dimensions: VOCAB.length,
    model: 'bow',
    embed: vi.fn(async (text: string) => bagOfWords(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(bagOfWords)),
  };
}

function staticLoader(docs: RAGDocument[]): DocumentLoader {
  return { supportedTypes: ['text'], load: vi.fn(async () => docs) };
}

const doc = (id: string, content: string, metadata?: Record<string, unknown>): RAGDocument => ({
  id,
  content,
  source: `/kb/${id}.md`,
  sourceType: 'markdown',
  ...(metadata && { metadata }),
});

describe('package hygiene', () => {
  it('exports VERSION from package.json', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('uses explicit .js extensions for every relative import (Node ESM compatibility)', () => {
    const srcDir = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (entry === '__tests__') continue;
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const source = readFileSync(path, 'utf-8');
        for (const match of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
          if (!match[1]!.endsWith('.js')) offenders.push(`${path}: ${match[1]}`);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe('RecursiveChunker regressions', () => {
  it('keeps exact offsets with runs of consecutive separators', () => {
    const text = 'alpha\n\n\n\n\nbeta gamma\n\n\ndelta. epsilon zeta\n\n\n\n\n\neta theta iota';
    const chunks = new RecursiveChunker({ chunkSize: 20, chunkOverlap: 5 }).chunk(text, 'd');

    for (const chunk of chunks) {
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.content.length).toBeLessThanOrEqual(20);
      expect(chunk.content).toBe(chunk.content.trim());
    }
    const covered = new Set<number>();
    for (const c of chunks) for (let i = c.startOffset; i < c.endOffset; i++) covered.add(i);
    for (let i = 0; i < text.length; i++) {
      if (!/\s/.test(text[i]!)) expect(covered.has(i)).toBe(true);
    }
  });

  it('never loses content or emits chunks contained in the previous one (randomized)', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'lambdalambdalambdalambda'];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 300; run++) {
      let text = '';
      const target = rand(400) + 1;
      while (text.length < target) {
        const r = rand(10);
        text +=
          r < 6 ? words[rand(words.length)] : r < 7 ? '. ' : r < 8 ? '\n' : r < 9 ? '\n\n' : ' ';
      }
      const size = rand(60) + 5;
      const overlap = rand(size);
      const chunks = new RecursiveChunker({ chunkSize: size, chunkOverlap: overlap }).chunk(
        text,
        'd'
      );
      const covered = new Set<number>();
      chunks.forEach((c, i) => {
        expect(c.content).toBe(text.slice(c.startOffset, c.endOffset));
        expect(c.content.length).toBeLessThanOrEqual(size);
        if (i > 0) {
          expect(c.startOffset).toBeGreaterThan(chunks[i - 1]!.startOffset);
          expect(c.endOffset).toBeGreaterThan(chunks[i - 1]!.endOffset);
        }
        for (let k = c.startOffset; k < c.endOffset; k++) covered.add(k);
      });
      for (let k = 0; k < text.length; k++) {
        if (!/\s/.test(text[k]!)) expect(covered.has(k)).toBe(true);
      }
    }
  });

  it('keeps sentence punctuation when splitting on ". "', () => {
    const text = 'First sentence here. Second sentence here. Third one.';
    const chunks = new RecursiveChunker({
      chunkSize: 25,
      chunkOverlap: 0,
      separators: ['. ', ' ', ''],
    }).chunk(text, 'd');
    expect(chunks.map((c) => c.content)).toEqual([
      'First sentence here.',
      'Second sentence here.',
      'Third one.',
    ]);
  });
});

describe('SemanticChunker regressions', () => {
  it('splits on blank lines even without sentence punctuation', async () => {
    const service = bowService();
    const chunker = new SemanticChunker({
      embeddingService: service,
      breakpointThreshold: 0.9,
      minChunkSize: 1,
      maxChunkSize: 200,
    });
    const chunks = await chunker.chunk('# Cats\ncat cat cat\n\n# Engines\nengine car road', 'd');
    expect(chunks.map((c) => c.content)).toEqual([
      '# Cats\ncat cat cat',
      '# Engines\nengine car road',
    ]);
  });

  it('throws a clear error when the embedding service returns too few vectors', async () => {
    const service = bowService();
    service.embedBatch.mockResolvedValueOnce([[1]]);
    const chunker = new SemanticChunker({ embeddingService: service });
    await expect(chunker.chunk('One sentence. Two sentence. Three.', 'd')).rejects.toThrow(
      'Embedding count mismatch'
    );
  });
});

describe('RAGPipeline regressions', () => {
  it('does not let undefined query options override configured retrieval defaults', async () => {
    const retriever: Retriever = { retrieve: vi.fn(async () => []) };
    const pipeline = new RAGPipeline(
      {
        chunking: { strategy: 'fixed', chunkSize: 100, chunkOverlap: 0 },
        retrieval: { strategy: 'similarity', topK: 3, threshold: 0.4 },
      },
      {
        loader: staticLoader([]),
        chunker: new RecursiveChunker({ chunkSize: 100, chunkOverlap: 0 }),
        embeddingService: bowService(),
        embeddingAdapter: new InMemoryEmbeddingAdapter(),
        retriever,
      }
    );

    await createSearchTool(pipeline).execute({ query: 'cats' });
    expect(retriever.retrieve).toHaveBeenCalledWith(
      'cats',
      expect.objectContaining({ topK: 3, threshold: 0.4 })
    );
  });

  it('stores document metadata, source type and offsets with every chunk', async () => {
    const adapter = new InMemoryEmbeddingAdapter();
    const pipeline = new RAGPipelineBuilder()
      .withLoader(staticLoader([doc('d1', 'cat cat. dog dog.', { title: 'Pets', pageNumber: 2 })]))
      .withEmbeddingService(bowService())
      .withEmbeddingAdapter(adapter)
      .withConfig({ chunking: { strategy: 'recursive', chunkSize: 50, chunkOverlap: 0 } })
      .build();

    await pipeline.ingest('ignored');
    const [result] = await pipeline.query('cat');

    expect(result!.source).toBe('/kb/d1.md');
    expect(result!.metadata).toMatchObject({
      title: 'Pets',
      pageNumber: 2,
      documentId: 'd1',
      source: '/kb/d1.md',
      sourceType: 'markdown',
      order: 0,
      startOffset: 0,
    });
  });

  it('skips whitespace-only chunks from custom chunkers', async () => {
    const service = bowService();
    const pipeline = new RAGPipelineBuilder()
      .withLoader(staticLoader([doc('d1', 'cat')]))
      .withChunker({
        chunk: (text, documentId) => [
          { id: 'a', documentId, content: text, startOffset: 0, endOffset: 3, order: 0 },
          { id: 'b', documentId, content: '   ', startOffset: 3, endOffset: 6, order: 1 },
        ],
      })
      .withEmbeddingService(service)
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({ chunking: { strategy: 'fixed', chunkSize: 10, chunkOverlap: 0 } })
      .build();

    await expect(pipeline.ingest('x')).resolves.toEqual({ documents: 1, chunks: 1 });
    expect(service.embedBatch).toHaveBeenCalledWith(['cat']);
  });

  it('bounds concurrent vector-store writes', async () => {
    let inFlight = 0;
    let peak = 0;
    const adapter: EmbeddingAdapter = {
      addEmbedding: vi.fn(async (embedding: Omit<Embedding, 'id' | 'createdAt'>) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { success: true as const, data: { ...embedding, id: 'e', createdAt: new Date() } };
      }),
      search: vi.fn(),
      deleteEmbedding: vi.fn(),
      deleteBySource: vi.fn(),
    };
    const pipeline = new RAGPipelineBuilder()
      .withLoader(staticLoader([doc('d1', 'cat '.repeat(200))]))
      .withEmbeddingService(bowService())
      .withEmbeddingAdapter(adapter)
      .withConfig({ chunking: { strategy: 'fixed', chunkSize: 4, chunkOverlap: 0 } })
      .build();

    const { chunks } = await pipeline.ingest('x');
    expect(chunks).toBe(200);
    expect(peak).toBeLessThanOrEqual(16);
  });
});

describe('RAGPipelineBuilder retrieval strategies', () => {
  const base = () =>
    new RAGPipelineBuilder()
      .withLoader(
        staticLoader([
          doc('pets', 'cat cat cat. dog dog. fish.'),
          doc('cars', 'car road engine. engine engine.'),
          doc('sky', 'sun moon star. star star.'),
        ])
      )
      .withEmbeddingService(bowService())
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter());

  it('uses MMR with the configured lambda for strategy "mmr"', async () => {
    const pipeline = base()
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
        retrieval: { strategy: 'mmr', mmrLambda: 0.3, topK: 2 },
      })
      .build();
    await pipeline.ingest('x');

    const results = await pipeline.query('cat');
    expect(results).toHaveLength(2);
    expect(results[0]!.metadata).toHaveProperty('originalScore');
  });

  it('requires withHybridSearch() for strategy "hybrid"', () => {
    expect(() =>
      base()
        .withConfig({
          chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
          retrieval: { strategy: 'hybrid' },
        })
        .build()
    ).toThrow('withHybridSearch');
  });

  it('indexes ingested chunks into the hybrid BM25 index and maps keyword hits back to chunks', async () => {
    const service = bowService();
    const adapter = new InMemoryEmbeddingAdapter();
    const hybridSearch = new HybridSearch({ embeddingAdapter: adapter, embeddingService: service });
    const pipeline = new RAGPipelineBuilder()
      .withLoader(staticLoader([doc('kw', 'zebra xylophone quartz'), doc('pets', 'cat dog')]))
      .withEmbeddingService(service)
      .withEmbeddingAdapter(adapter)
      .withHybridSearch(hybridSearch)
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
        retrieval: { strategy: 'hybrid', topK: 5 },
      })
      .build();

    await pipeline.ingest('x');
    expect(hybridSearch.indexSize).toBe(2);

    const results = await pipeline.query('xylophone');
    const hit = results.find((r) => r.content.includes('xylophone'));
    expect(hit).toBeDefined();
    expect(hit!.documentId).toBe('kw');
    expect(hit!.source).toBe('/kb/kw.md');
    expect(hit!.metadata?.keywordScore).toBeGreaterThan(0);
  });

  it('requires withQueryExpander() for strategy "multi-query" and caps variants by multiQueryCount', async () => {
    expect(() =>
      base()
        .withConfig({
          chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
          retrieval: { strategy: 'multi-query', multiQueryCount: 1 },
        })
        .build()
    ).toThrow('withQueryExpander');

    const service = bowService();
    const pipeline = new RAGPipelineBuilder()
      .withLoader(staticLoader([doc('pets', 'cat dog'), doc('sky', 'sun moon')]))
      .withEmbeddingService(service)
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withQueryExpander(async () => ['moon', 'sun', 'star'])
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
        retrieval: { strategy: 'multi-query', multiQueryCount: 1, threshold: 0.1 },
      })
      .build();
    await pipeline.ingest('x');
    service.embed.mockClear();

    const results = await pipeline.query('cat');
    expect(service.embed.mock.calls.map((c) => c[0])).toEqual(['cat', 'moon']);
    expect(results.map((r) => r.documentId).sort()).toEqual(['pets', 'sky']);
  });
});

describe('Retriever regressions', () => {
  it('MMR re-embeds candidates when the store returns no vectors', async () => {
    const service = bowService();
    const stored = ['cat cat', 'cat cat', 'dog'].map((content, i) => ({
      id: `e${i}`,
      sourceId: `c${i}`,
      sourceType: 'document' as const,
      vector: [],
      content,
      createdAt: new Date(),
      metadata: { documentId: `d${i}`, source: `/kb/${i}` },
      score: 1 - i * 0.1,
    }));
    const adapter = {
      search: vi.fn(async () => ({ success: true as const, data: stored })),
    } as unknown as EmbeddingAdapter;

    const results = await new MMRRetriever({
      embeddingAdapter: adapter,
      embeddingService: service,
      defaultLambda: 0.5,
    }).retrieve('cat', { topK: 2 });

    expect(service.embedBatch).toHaveBeenCalledWith(['cat cat', 'cat cat', 'dog']);
    expect(results.map((r) => r.chunkId)).toEqual(['c0', 'c2']);
    expect(results[0]!.source).toBe('/kb/0');
  });

  it('similarity results expose the document source instead of the embedding source type', async () => {
    const adapter = {
      search: vi.fn(async () => ({
        success: true as const,
        data: [
          {
            id: 'e',
            sourceId: 'c',
            sourceType: 'document' as const,
            vector: [1],
            content: 'x',
            createdAt: new Date(),
            metadata: { documentId: 'd', source: 'https://example.com/a' },
            score: 0.9,
          },
        ],
      })),
    } as unknown as EmbeddingAdapter;
    const [result] = await new SimilarityRetriever({
      embeddingAdapter: adapter,
      embeddingService: bowService(),
    }).retrieve('x');
    expect(result!.source).toBe('https://example.com/a');
  });

  describe('MultiQueryRetriever', () => {
    const result = (chunkId: string, score: number): RetrievalResult => ({
      chunkId,
      documentId: 'd',
      content: chunkId,
      score,
    });

    it('falls back to the original query when expansion fails', async () => {
      const base: Retriever = { retrieve: vi.fn(async () => [result('a', 0.5)]) };
      const retriever = new MultiQueryRetriever({
        baseRetriever: base,
        expandQuery: async () => {
          throw new Error('llm down');
        },
      });
      await expect(retriever.retrieve('q')).resolves.toEqual([result('a', 0.5)]);
      expect(base.retrieve).toHaveBeenCalledTimes(1);
    });

    it('throws when every variant retrieval fails instead of returning an empty list', async () => {
      const retriever = new MultiQueryRetriever({
        baseRetriever: { retrieve: vi.fn(async () => Promise.reject(new Error('store down'))) },
        expandQuery: async () => ['v1'],
      });
      await expect(retriever.retrieve('q')).rejects.toThrow('store down');
    });

    it('deduplicates variants (case-insensitive, blank ones dropped) and caps them', async () => {
      const base: Retriever = { retrieve: vi.fn(async () => []) };
      const retriever = new MultiQueryRetriever({
        baseRetriever: base,
        expandQuery: async () => ['Q', ' ', 'v1', 'V1', 'v2', 'v3'],
        defaultMaxQueries: 2,
      });
      await retriever.retrieve('q');
      expect((base.retrieve as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
        'q',
        'v1',
        'v2',
      ]);
    });

    it('forwards chunk indexing to an indexing base retriever', () => {
      const hybrid = new HybridRetriever({
        hybridSearch: new HybridSearch({
          embeddingAdapter: new InMemoryEmbeddingAdapter(),
          embeddingService: bowService(),
        }),
      });
      const spy = vi.spyOn(hybrid, 'indexChunk');
      const multi = new MultiQueryRetriever({ baseRetriever: hybrid, expandQuery: async () => [] });
      const chunk = { embeddingId: 'e', chunkId: 'c', documentId: 'd', content: 'x', metadata: {} };
      multi.indexChunk(chunk);
      expect(spy).toHaveBeenCalledWith(chunk);
    });
  });
});

describe('Loader regressions', () => {
  it('HTMLLoader drops scripts/styles and separates blocks and table cells', async () => {
    const file = join(TMP, 'page.html');
    writeFileSync(
      file,
      '<html><head><title>T</title><script>var a=1</script></head><body>' +
        '<style>p{}</style><p>One<br>Two</p><table><tr><td>A</td><td>B</td></tr></table>' +
        '<noscript>enable js</noscript></body></html>'
    );
    const [page] = await new HTMLLoader().load(file);
    expect(page!.content).toBe('One\nTwo\n\nA B');
    expect(page!.metadata?.title).toBe('T');
  });

  it('MarkdownLoader unquotes frontmatter values and loads directories in sorted order', async () => {
    const dir = join(TMP, 'md');
    mkdirSync(dir);
    writeFileSync(join(dir, 'b.md'), '---\ntitle: "Quoted Title"\nauthor: \'Ann\'\n---\nBody B');
    writeFileSync(join(dir, 'a.md'), 'Body A');
    const docs = await new MarkdownLoader({ stripFrontmatter: true }).load(dir);
    expect(docs.map((d) => d.content)).toEqual(['Body A', 'Body B']);
    expect(docs[1]!.metadata).toEqual({ title: 'Quoted Title', author: 'Ann' });
  });

  it('TextLoader loads directories in sorted order', async () => {
    const dir = join(TMP, 'txt');
    mkdirSync(dir);
    writeFileSync(join(dir, 'z.txt'), 'Z');
    writeFileSync(join(dir, 'm.txt'), 'M');
    const docs = await new TextLoader().load(dir);
    expect(docs.map((d) => d.content)).toEqual(['M', 'Z']);
  });

  it('CSVLoader works when papaparse only has a default export (Node ESM interop)', async () => {
    const real = await import('papaparse');
    const parse = (real as { parse?: typeof real.parse }).parse ?? real.default.parse;
    vi.resetModules();
    vi.doMock('papaparse', () => ({ default: { parse } }));
    try {
      const { CSVLoader } = await import('../loaders/csv-loader');
      const file = join(TMP, 'interop.csv');
      writeFileSync(file, 'text,tag\nhello,x\n');
      const docs = await new CSVLoader({ metadataColumns: ['tag'] }).load(file);
      expect(docs).toHaveLength(1);
      expect(docs[0]!.content).toBe('hello');
      expect(docs[0]!.metadata).toEqual({ tag: 'x', row: 1 });
    } finally {
      vi.doUnmock('papaparse');
      vi.resetModules();
    }
  });
});

describe('createIngestTool allowedRoots', () => {
  const kb = join(TMP, 'kb');
  const outside = join(TMP, 'secret');
  mkdirSync(kb, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(kb, 'ok.txt'), 'fine');
  writeFileSync(join(outside, 'secret.txt'), 'token');
  symlinkSync(join(outside, 'secret.txt'), join(kb, 'link.txt'));

  const pipeline = {
    ingest: vi.fn(async () => ({ documents: 1, chunks: 1 })),
  } as unknown as RAGPipeline;

  it('allows sources inside the allowed roots', async () => {
    const tool = createIngestTool(pipeline, { allowedRoots: [kb] });
    await expect(tool.execute({ source: join(kb, 'ok.txt') })).resolves.toMatchObject({
      success: true,
    });
  });

  it('rejects paths outside the roots, traversal and symlink escapes', async () => {
    const tool = createIngestTool(pipeline, { allowedRoots: [kb] });
    for (const source of [
      join(outside, 'secret.txt'),
      join(kb, '..', 'secret'),
      join(kb, 'link.txt'),
    ]) {
      await expect(tool.execute({ source })).resolves.toEqual({
        success: false,
        error: expect.stringContaining('outside the allowed directories'),
      });
    }
  });

  it('can forbid URL sources', async () => {
    const tool = createIngestTool(pipeline, { allowUrls: false });
    await expect(tool.execute({ source: 'https://example.com' })).resolves.toEqual({
      success: false,
      error: 'URL sources are not allowed',
    });
  });
});
