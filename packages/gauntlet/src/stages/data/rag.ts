import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Agent, tool } from '@cogitator-ai/core';
import {
  HybridSearch,
  OpenAIEmbeddingService,
  PostgresAdapter,
  unwrap,
} from '@cogitator-ai/memory';
import {
  LLMReranker,
  MarkdownLoader,
  RAGPipelineBuilder,
  createSearchTool,
} from '@cogitator-ai/rag';
import { OPENROUTER_BASE_URL } from '../../llm.js';
import { REPO_ROOT } from '../../packages.js';
import type { StageDefinition } from '../../runner/types.js';
import {
  EMBEDDING_MODEL,
  countPostgresEmbeddings,
  dropPostgresSchema,
  openRouterEmbeddings,
  textOf,
  uniqueSuffix,
} from './support.js';

/** The corpus: the memory section of our own documentation site. */
const DOCS_DIR = join(REPO_ROOT, 'packages/dashboard/content/docs/memory');

/** A fact stated once in the corpus (adapters.mdx) that a model is likely to get wrong unaided. */
const QUESTION =
  'In Cogitator, what vector dimension does the PostgresAdapter use by default when setVectorDimensions is not called?';
const ANSWER = /\b768\b/;

/** A passage that states the fact: the number next to the adapter or its setter. */
function statesAnswer(text: string): boolean {
  return ANSWER.test(text) && /PostgresAdapter|setVectorDimensions/.test(text);
}

/**
 * The RAG package end to end on real data: our Markdown docs are loaded, chunked, embedded
 * through OpenRouter, stored in pgvector, retrieved with hybrid search (vectors plus Postgres
 * full-text), reranked by the gauntlet model, and an agent answers a docs question through the
 * `rag_search` tool. Qdrant is covered separately by memory-qdrant.
 */
export const ragStage: StageDefinition = {
  id: 'rag',
  title: 'RAG over our docs',
  description:
    'Our memory docs are loaded, chunked, embedded, stored in pgvector, retrieved with hybrid search and an LLM reranker, and an agent answers a docs question through rag_search.',
  packages: [
    '@cogitator-ai/rag',
    '@cogitator-ai/memory',
    '@cogitator-ai/core',
    '@cogitator-ai/types',
  ],
  needs: ['handshake'],
  requires: [
    { kind: 'service', name: 'postgres' },
    {
      kind: 'env',
      name: 'OPENROUTER_API_KEY',
      why: `chunks are embedded with ${EMBEDDING_MODEL} through OpenRouter`,
    },
  ],
  timeoutMs: 180_000,
  async run(ctx) {
    const schema = `gauntlet_data_rag_${uniqueSuffix()}`;
    const connectionString = ctx.services.postgres;
    const embeddingService = openRouterEmbeddings();
    const store = new PostgresAdapter({
      provider: 'postgres',
      connectionString,
      schema,
      poolSize: 4,
    });
    store.setVectorDimensions(embeddingService.dimensions);
    ctx.onCleanup(async () => {
      await store.disconnect();
      await dropPostgresSchema(connectionString, schema);
    });

    await ctx.check('the embedding model answers with the advertised size', async (evidence) => {
      const [first, second] = await embeddingService.embedBatch(['vector store', 'thread store']);
      evidence('model', embeddingService.model);
      evidence('dimensions', first?.length);
      if (
        first?.length !== embeddingService.dimensions ||
        second?.length !== embeddingService.dimensions
      ) {
        throw new Error(
          `Got vectors of ${first?.length} and ${second?.length}, the service claims ${embeddingService.dimensions}`
        );
      }
      unwrap(await store.connect());
    });

    let rerankCalls = 0;
    const route = ctx.cogitator.route(ctx.model);
    const reranker = new LLMReranker({
      generateFn: async (prompt) => {
        rerankCalls += 1;
        const response = await route.backend.chat({
          model: route.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          signal: ctx.signal,
        });
        return response.content;
      },
    });

    const hybridSearch = new HybridSearch({
      embeddingAdapter: store,
      embeddingService,
      keywordAdapter: store,
    });
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new MarkdownLoader({ stripFrontmatter: true }))
      .withEmbeddingService(embeddingService)
      .withEmbeddingAdapter(store)
      .withHybridSearch(hybridSearch, { bm25: 0.5, vector: 0.5 })
      .withReranker(reranker)
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 900, chunkOverlap: 120 },
        retrieval: { strategy: 'hybrid', topK: 8, threshold: 0 },
        reranking: { enabled: true, topN: 3 },
      })
      .build();

    await ctx.check('ingests the docs into pgvector', async (evidence) => {
      const files = (await readdir(DOCS_DIR)).filter((file) => file.endsWith('.mdx'));
      const { documents, chunks } = await pipeline.ingest(DOCS_DIR);
      const rows = await countPostgresEmbeddings(connectionString, schema);
      evidence('files', files.length);
      evidence('documents', documents);
      evidence('chunks', chunks);
      evidence('rows', rows);
      if (documents !== files.length)
        throw new Error(`Ingested ${documents} documents from ${files.length} files`);
      if (chunks <= documents) throw new Error(`Only ${chunks} chunks for ${documents} documents`);
      if (rows !== chunks) throw new Error(`pgvector holds ${rows} rows for ${chunks} chunks`);
    });

    await ctx.check(
      'hybrid retrieval and the reranker surface the passage with the answer',
      async (evidence) => {
        const results = await pipeline.query(QUESTION);
        evidence('rerankCalls', rerankCalls);
        evidence(
          'top',
          results.map((result) => `${basename(result.source ?? '?')} ${result.score.toFixed(2)}`)
        );
        evidence('title', results[0]?.metadata?.title);
        if (rerankCalls !== 1)
          throw new Error(`The reranker ran ${rerankCalls} times, expected once`);
        if (results.length !== 3)
          throw new Error(`Got ${results.length} results after reranking to the top 3`);
        if ((results[0]?.score ?? 0) < 0.2) {
          throw new Error(
            `The top score ${results[0]?.score.toFixed(3)} is a fused retrieval score, not a reranker score: reranking failed and silently fell back to the retrieval order`
          );
        }
        const hit = results.find((result) => statesAnswer(result.content));
        evidence('answerFrom', hit ? basename(hit.source ?? '?') : null);
        if (!hit)
          throw new Error(
            'None of the top 3 passages states the default dimension of PostgresAdapter'
          );
        if (typeof hit.metadata?.title !== 'string')
          throw new Error('Frontmatter did not reach the chunk metadata');
      }
    );

    await ctx.check('an agent answers the docs question through rag_search', async (evidence) => {
      const agent = new Agent({
        name: 'docs-assistant',
        model: ctx.model,
        instructions:
          'You answer questions about the Cogitator framework. Always search the documentation with rag_search before answering, answer only from what it returns, and name the documentation file you used.',
        tools: [tool(createSearchTool(pipeline))],
        temperature: 0,
        maxIterations: 4,
      });
      const run = await ctx.cogitator.run(agent, { input: QUESTION, signal: ctx.signal });
      const searches = run.toolCalls.filter((call) => call.name === 'rag_search');
      const toolOutput = run.messages
        .filter((message) => message.role === 'tool')
        .map((message) => textOf(message.content))
        .join('\n');
      evidence(
        'searches',
        searches.map((call) => call.arguments.query)
      );
      evidence('output', run.output.slice(0, 240));
      if (searches.length === 0) throw new Error('The agent answered without calling rag_search');
      if (!statesAnswer(toolOutput))
        throw new Error('rag_search did not return the passage with the answer');
      if (!ANSWER.test(run.output)) throw new Error(`The answer does not state 768: ${run.output}`);
    });

    await ctx.check(
      'a smaller dimensions option is honoured through the gateway',
      async (evidence) => {
        const apiKey = process.env.OPENROUTER_API_KEY ?? '';
        const reduced = new OpenAIEmbeddingService({
          apiKey,
          baseUrl: OPENROUTER_BASE_URL,
          model: EMBEDDING_MODEL,
          dimensions: 512,
        });
        const vector = await reduced.embed('pgvector column size');
        evidence('claimed', reduced.dimensions);
        evidence('actual', vector.length);
        if (vector.length !== reduced.dimensions) {
          throw new Error(
            `The service reports ${reduced.dimensions} dimensions but returned ${vector.length}: it only sends "dimensions" for model ids starting with text-embedding-3, so the gateway id ${EMBEDDING_MODEL} silently gets the full size`
          );
        }
      }
    );
  },
};
