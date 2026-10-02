import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import {
  RAGPipelineBuilder,
  MarkdownLoader,
  CSVLoader,
  WebLoader,
  SemanticChunker,
  LLMReranker,
  createSearchTool,
  createIngestTool,
} from '@cogitator-ai/rag';
import {
  InMemoryEmbeddingAdapter,
  HybridSearch,
  GoogleEmbeddingService,
} from '@cogitator-ai/memory';
import type { EmbeddingService } from '@cogitator-ai/types';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const VOCAB = [
  'typescript',
  'javascript',
  'pasta',
  'carbonara',
  'station',
  'orbit',
  'refund',
  'invoice',
  'password',
  'login',
];

function keywordEmbedding(): EmbeddingService {
  const embed = (text: string) => {
    const lower = text.toLowerCase();
    const vector = VOCAB.map((term) => lower.split(term).length - 1);
    return vector.some((v) => v > 0) ? vector : VOCAB.map(() => 0.01);
  };
  return {
    model: 'keyword-test',
    dimensions: VOCAB.length,
    embed: async (text) => embed(text),
    embedBatch: async (texts) => texts.map(embed),
  };
}

describe('RAG: loaders, strategies and tools (deterministic embeddings)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-rag-strategies-'));
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(
      join(dir, 'docs', 'billing.md'),
      '---\ntitle: "Billing FAQ"\nteam: finance\n---\n# Refunds\n\nA refund is issued within 5 days after the invoice is cancelled.\n\n# Invoices\n\nEvery invoice is emailed on the first day of the month.'
    );
    writeFileSync(
      join(dir, 'docs', 'account.md'),
      '---\ntitle: Account help\n---\nReset your password from the login page. The login page also supports passkeys.'
    );
    writeFileSync(
      join(dir, 'tickets.csv'),
      'body,priority\n"Customer asks about a refund for a duplicate invoice",high\n"User cannot login after password change",low\n'
    );

    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Space</title><script>track()</script></head><body>' +
          '<article><h1>ISS</h1><p>The space station keeps a low orbit around Earth.</p></article></body></html>'
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ingests markdown with frontmatter and returns cited, metadata-rich results', async () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new MarkdownLoader({ stripFrontmatter: true }))
      .withEmbeddingService(keywordEmbedding())
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 90, chunkOverlap: 10 },
        retrieval: { strategy: 'similarity', topK: 2, threshold: 0.1 },
      })
      .build();

    const ingested = await pipeline.ingest(join(dir, 'docs'));
    expect(ingested.documents).toBe(2);
    expect(ingested.chunks).toBeGreaterThanOrEqual(3);

    const [top] = await pipeline.query('how long does a refund take');
    expect(top!.content).toContain('refund is issued within 5 days');
    expect(top!.source).toBe(join(dir, 'docs', 'billing.md'));
    expect(top!.metadata).toMatchObject({ title: 'Billing FAQ', team: 'finance' });
  });

  it('retrieves CSV rows with their metadata columns', async () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new CSVLoader({ contentColumn: 'body', metadataColumns: ['priority'] }))
      .withEmbeddingService(keywordEmbedding())
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({
        chunking: { strategy: 'fixed', chunkSize: 200, chunkOverlap: 0 },
        retrieval: { strategy: 'similarity', topK: 1 },
      })
      .build();

    await pipeline.ingest(join(dir, 'tickets.csv'));
    const [top] = await pipeline.query('password login problem');
    expect(top!.content).toContain('cannot login');
    expect(top!.metadata).toMatchObject({ priority: 'low', row: 2 });
  });

  it('ingests a web page (scripts stripped) from an allowed private host', async () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new WebLoader({ allowPrivateNetwork: true, selector: 'article' }))
      .withEmbeddingService(keywordEmbedding())
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({ chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 } })
      .build();

    await pipeline.ingest(`${baseUrl}/iss`);
    const [top] = await pipeline.query('what orbit does the station keep');
    expect(top!.content).toBe('ISS\n\nThe space station keeps a low orbit around Earth.');
    expect(top!.metadata).toMatchObject({ title: 'Space', url: `${baseUrl}/iss` });

    await expect(new WebLoader().load(`${baseUrl}/iss`)).rejects.toThrow(/blocked/);
  });

  it('uses MMR to diversify near-duplicate results', async () => {
    const adapter = new InMemoryEmbeddingAdapter();
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new MarkdownLoader())
      .withEmbeddingService(keywordEmbedding())
      .withEmbeddingAdapter(adapter)
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 60, chunkOverlap: 0 },
        retrieval: { strategy: 'mmr', mmrLambda: 0.3, topK: 2 },
      })
      .build();

    const mmrDir = join(dir, 'mmr');
    mkdirSync(mmrDir);
    writeFileSync(join(mmrDir, 'a.md'), 'refund invoice refund.');
    writeFileSync(join(mmrDir, 'b.md'), 'refund invoice refund again.');
    writeFileSync(join(mmrDir, 'c.md'), 'refund policy for the login portal.');
    await pipeline.ingest(mmrDir);

    const results = await pipeline.query('refund');
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.content.includes('login'))).toBe(true);
  });

  it('finds exact keyword matches through the hybrid BM25 index', async () => {
    const service = keywordEmbedding();
    const adapter = new InMemoryEmbeddingAdapter();
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new MarkdownLoader())
      .withEmbeddingService(service)
      .withEmbeddingAdapter(adapter)
      .withHybridSearch(new HybridSearch({ embeddingAdapter: adapter, embeddingService: service }))
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
        retrieval: { strategy: 'hybrid', topK: 3 },
      })
      .build();

    const hybridDir = join(dir, 'hybrid');
    mkdirSync(hybridDir);
    writeFileSync(
      join(hybridDir, 'codes.md'),
      'Error code ZX-4471 means the invoice webhook timed out.'
    );
    writeFileSync(join(hybridDir, 'other.md'), 'Carbonara pasta needs guanciale.');
    await pipeline.ingest(hybridDir);

    const results = await pipeline.query('ZX-4471');
    expect(results[0]!.content).toContain('ZX-4471');
    expect(results[0]!.source).toBe(join(hybridDir, 'codes.md'));
    expect(results[0]!.metadata?.keywordScore).toBeGreaterThan(0);
  });

  it('exposes safe ingest/search tools', async () => {
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new MarkdownLoader())
      .withEmbeddingService(keywordEmbedding())
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 200, chunkOverlap: 0 },
        retrieval: { strategy: 'similarity', topK: 1, threshold: 0.1 },
      })
      .build();
    const ingest = createIngestTool(pipeline, { allowedRoots: [join(dir, 'docs')] });
    const search = createSearchTool(pipeline);

    await expect(ingest.execute({ source: join(dir, 'tickets.csv') })).resolves.toMatchObject({
      success: false,
    });
    await expect(ingest.execute({ source: join(dir, 'docs') })).resolves.toMatchObject({
      success: true,
      documents: 2,
    });

    const found = (await search.execute({ query: 'reset password' })) as {
      success: boolean;
      count: number;
      results: Array<{ content: string }>;
    };
    expect(found.success).toBe(true);
    expect(found.count).toBe(1);
    expect(found.results[0]!.content).toContain('Reset your password');
  });
});

const describeGoogle = GOOGLE_API_KEY ? describe : describe.skip;

describeGoogle('RAG: Gemini embeddings, semantic chunking, reranking and agent tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-rag-gemini-'));
  let cogitator: Cogitator;
  let embeddingService: GoogleEmbeddingService;

  beforeAll(() => {
    embeddingService = new GoogleEmbeddingService({ apiKey: GOOGLE_API_KEY! });
    cogitator = new Cogitator({
      llm: {
        defaultModel: 'google/gemini-3.5-flash-lite',
        providers: { google: { apiKey: GOOGLE_API_KEY! } },
      },
    });
    writeFileSync(
      join(dir, 'handbook.md'),
      [
        'Our office opens at 9am and closes at 6pm. On Fridays the office closes at 3pm.',
        'Parking is available in the underground garage. Visitors must register at the front desk.',
        'The cafeteria serves vegetarian lunch every Wednesday. Coffee is free all day.',
        'Expense reports are due on the 5th of each month. Late reports are paid in the next cycle.',
      ].join('\n\n')
    );
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await cogitator.close();
  });

  async function generate(prompt: string): Promise<string> {
    const agent = new Agent({
      name: 'rag-helper',
      model: 'google/gemini-3.5-flash-lite',
      instructions: '',
    });
    const result = await cogitator.run(agent, { input: prompt });
    return result.output;
  }

  it(
    'chunks semantically, reranks with an LLM and expands queries',
    { timeout: 180_000 },
    async () => {
      const pipeline = new RAGPipelineBuilder()
        .withLoader(new MarkdownLoader())
        .withChunker(
          new SemanticChunker({ embeddingService, breakpointThreshold: 0.75, minChunkSize: 40 })
        )
        .withEmbeddingService(embeddingService)
        .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
        .withReranker(new LLMReranker({ generateFn: generate }))
        .withQueryExpander(async (query) => {
          const text = await generate(
            `Rewrite this search query in 2 different ways. One per line, no numbering.\nQuery: ${query}`
          );
          return text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        })
        .withConfig({
          chunking: { strategy: 'semantic', chunkSize: 400 },
          retrieval: { strategy: 'multi-query', multiQueryCount: 2, topK: 3 },
          reranking: { enabled: true, topN: 1 },
        })
        .build();

      const { chunks } = await pipeline.ingest(join(dir, 'handbook.md'));
      expect(chunks).toBeGreaterThanOrEqual(2);

      const [top] = await pipeline.query('When can I leave the building at the end of the week?');
      expect(top!.content).toContain('Fridays');
      expect(top!.score).toBeGreaterThan(0.5);
    }
  );

  it(
    'lets an agent answer from the knowledge base with the rag_search tool',
    { timeout: 180_000 },
    async () => {
      const pipeline = new RAGPipelineBuilder()
        .withLoader(new MarkdownLoader())
        .withEmbeddingService(embeddingService)
        .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
        .withConfig({
          chunking: { strategy: 'recursive', chunkSize: 120, chunkOverlap: 0 },
          retrieval: { strategy: 'similarity', topK: 2 },
        })
        .build();
      await pipeline.ingest(join(dir, 'handbook.md'));

      const agent = new Agent({
        name: 'handbook-assistant',
        model: 'google/gemini-3.5-flash-lite',
        instructions:
          'Answer questions about the company handbook. Always call rag_search first and answer only from its results.',
        tools: [tool(createSearchTool(pipeline))],
      });

      const result = await cogitator.run(agent, { input: 'When are expense reports due?' });
      expect(result.toolCalls.some((call) => call.name === 'rag_search')).toBe(true);
      expect(result.output).toMatch(/5(th)?/);
    }
  );
});
