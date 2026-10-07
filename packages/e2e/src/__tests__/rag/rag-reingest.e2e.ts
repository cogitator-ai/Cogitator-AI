import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RAGPipelineBuilder, TextLoader } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, GoogleEmbeddingService } from '@cogitator-ai/memory';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const describeIf = GOOGLE_API_KEY ? describe : describe.skip;

describeIf('RAG re-ingest and scoping E2E', () => {
  const TEST_DIR = join(tmpdir(), 'cogitator-rag-reingest-e2e-' + Date.now());
  let embeddingService: GoogleEmbeddingService;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    embeddingService = new GoogleEmbeddingService({ apiKey: GOOGLE_API_KEY! });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('replaces an edited source and never returns private memory from the shared store', async () => {
    const file = join(TEST_DIR, 'policy.txt');
    writeFileSync(file, 'Employees get 20 vacation days per year. Requests go to the team lead.');
    const store = new InMemoryEmbeddingAdapter();
    const [secret] = await embeddingService.embedBatch(['Alice told the bot her vacation plans']);
    await store.addEmbedding({
      sourceId: 'fact-1',
      sourceType: 'fact',
      vector: secret!,
      content: 'Alice told the bot her vacation plans',
      metadata: { userId: 'alice' },
    });

    const pipeline = new RAGPipelineBuilder()
      .withLoader(new TextLoader())
      .withEmbeddingService(embeddingService)
      .withEmbeddingAdapter(store)
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 400, chunkOverlap: 0 },
        namespace: 'handbook',
      })
      .build();

    const first = await pipeline.ingest(file);
    await pipeline.ingest(file);
    expect(store.size).toBe(first.chunks + 1);

    writeFileSync(file, 'Employees get 25 vacation days per year. Requests go to HR.');
    await pipeline.ingest(file);

    const results = await pipeline.query('How many vacation days do employees get?', { topK: 5 });
    expect(results.map((r) => r.content)).toEqual([
      'Employees get 25 vacation days per year. Requests go to HR.',
    ]);
    expect(results.every((r) => r.metadata?.namespace === 'handbook')).toBe(true);
  }, 60000);
});
