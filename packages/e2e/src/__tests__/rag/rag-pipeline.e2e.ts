import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RAGPipelineBuilder, RecursiveChunker, TextLoader } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, GoogleEmbeddingService } from '@cogitator-ai/memory';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const describeIf = GOOGLE_API_KEY ? describe : describe.skip;

describeIf('RAG Pipeline E2E', () => {
  const TEST_DIR = join(tmpdir(), 'cogitator-rag-e2e-' + Date.now());
  let embeddingAdapter: InMemoryEmbeddingAdapter;
  let embeddingService: GoogleEmbeddingService;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    embeddingAdapter = new InMemoryEmbeddingAdapter();
    embeddingService = new GoogleEmbeddingService({ apiKey: GOOGLE_API_KEY! });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('ingests documents and retrieves relevant results', async () => {
    writeFileSync(
      join(TEST_DIR, 'typescript.txt'),
      'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. It adds optional static typing and class-based object-oriented programming.'
    );
    writeFileSync(
      join(TEST_DIR, 'cooking.txt'),
      'Italian pasta is made from durum wheat semolina. The best carbonara uses guanciale, eggs, pecorino romano, and black pepper.'
    );
    writeFileSync(
      join(TEST_DIR, 'space.txt'),
      'The International Space Station orbits Earth at about 17,500 mph. It has been continuously occupied since November 2000.'
    );

    const pipeline = new RAGPipelineBuilder()
      .withLoader(new TextLoader())
      .withChunker(new RecursiveChunker({ chunkSize: 200, chunkOverlap: 20 }))
      .withEmbeddingService(embeddingService)
      .withEmbeddingAdapter(embeddingAdapter)
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 20 },
      })
      .build();

    const ingestResult = await pipeline.ingest(TEST_DIR);
    expect(ingestResult.documents).toBe(3);
    expect(ingestResult.chunks).toBeGreaterThan(0);

    const tsResults = await pipeline.query('What is TypeScript?', { topK: 3 });
    expect(tsResults.length).toBeGreaterThan(0);
    expect(tsResults[0].content.toLowerCase()).toContain('typescript');

    const cookResults = await pipeline.query('How to make pasta carbonara?', { topK: 3 });
    expect(cookResults.length).toBeGreaterThan(0);
    expect(cookResults[0].content.toLowerCase()).toMatch(/pasta|carbonara|italian/);

    const spaceResults = await pipeline.query('Tell me about the ISS', { topK: 3 });
    expect(spaceResults.length).toBeGreaterThan(0);
    expect(spaceResults[0].content.toLowerCase()).toMatch(/space|station|orbit/);
  }, 30000);

  it('reports stats after operations', async () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new TextLoader())
      .withChunker(new RecursiveChunker({ chunkSize: 200, chunkOverlap: 0 }))
      .withEmbeddingService(embeddingService)
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200 },
      })
      .build();

    const dir = join(TEST_DIR, 'stats-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test.txt'), 'This is a test document for stats verification.');

    await pipeline.ingest(dir);
    await pipeline.query('test');

    const stats = pipeline.getStats();
    expect(stats.documentsIngested).toBe(1);
    expect(stats.chunksStored).toBeGreaterThan(0);
    expect(stats.queriesProcessed).toBe(1);
  }, 15000);
});
