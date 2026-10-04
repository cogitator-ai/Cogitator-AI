# @cogitator-ai/rag

Retrieval-Augmented Generation pipeline for Cogitator AI agents. Load documents, chunk them, embed, retrieve, and rerank — all with a single builder API.

## Installation

```bash
pnpm add @cogitator-ai/rag

# Optional dependencies for specific loaders
pnpm add cheerio    # HTML and web page loading
pnpm add papaparse  # CSV loading
pnpm add pdf-parse  # PDF loading
```

`@cogitator-ai/memory` (optional peer) provides the embedding services, vector stores (`InMemoryEmbeddingAdapter`, `PostgresAdapter`, `QdrantAdapter`) and `HybridSearch` used below; any `EmbeddingService` / `EmbeddingAdapter` implementation works. Website docs: [RAG](https://cogitator.app/docs/rag), [Loaders](https://cogitator.app/docs/rag/loaders), [Chunking](https://cogitator.app/docs/rag/chunking), [Retrieval](https://cogitator.app/docs/rag/retrieval), [Reranking](https://cogitator.app/docs/rag/reranking).

## Features

- **7 Document Loaders** — Text, Markdown, JSON, CSV, HTML, PDF, Web pages
- **3 Chunking Strategies** — Fixed-size, recursive, semantic (embedding-based)
- **4 Retrieval Strategies** — Similarity, MMR, hybrid (BM25 + vector), multi-query
- **2 Rerankers** — LLM-based scoring, Cohere Rerank API
- **Pipeline Builder** — Fluent API to wire everything together
- **Agent Tools** — Drop-in `rag_search` and `rag_ingest` tools for Cogitator agents
- **Zod Validation** — Type-safe configuration with runtime checks

---

## Quick Start

```typescript
import { RAGPipelineBuilder, TextLoader } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, OpenAIEmbeddingService } from '@cogitator-ai/memory';

const pipeline = new RAGPipelineBuilder()
  .withLoader(new TextLoader())
  .withEmbeddingService(
    new OpenAIEmbeddingService({
      apiKey: process.env.OPENAI_API_KEY!,
    })
  )
  .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 500, chunkOverlap: 50 },
    retrieval: { strategy: 'similarity', topK: 5, threshold: 0.3 },
  })
  .build();

// ingest documents from a file or directory
const { documents, chunks } = await pipeline.ingest('./docs');

// query the knowledge base (options override the configured retrieval for this call)
const results = await pipeline.query('How does authentication work?', { topK: 3 });

for (const r of results) {
  console.log(`[${r.score.toFixed(3)}] ${r.source}: ${r.content.slice(0, 100)}...`);
}
```

Every stored chunk carries the document's loader metadata (e.g. Markdown frontmatter, PDF page numbers, CSV metadata columns, page title/URL) plus `documentId`, `source`, `sourceType`, `order`, `startOffset` and `endOffset`. Retrieval results expose the document path/URL as `result.source` and the rest in `result.metadata`.

---

## Document Loaders

| Loader           | Formats               | Optional Dep | Notes                                                  |
| ---------------- | --------------------- | ------------ | ------------------------------------------------------ |
| `TextLoader`     | `.txt`                | —            | Files and directories                                  |
| `MarkdownLoader` | `.md`, `.mdx`         | —            | Optional frontmatter -> metadata                       |
| `JSONLoader`     | `.json`               | —            | Configurable content field                             |
| `CSVLoader`      | `.csv`                | `papaparse`  | Column selection, `row` number in metadata             |
| `HTMLLoader`     | `.html`, `.htm`       | `cheerio`    | CSS selector, scripts/styles removed, block-aware text |
| `PDFLoader`      | `.pdf`                | `pdf-parse`  | Whole document or one document per page                |
| `WebLoader`      | `http://`, `https://` | `cheerio`    | HTML, plain text and JSON pages; SSRF-protected        |

Directory sources (`TextLoader`, `MarkdownLoader`) are loaded in sorted file-name order.

### WebLoader security

`WebLoader` blocks loopback, private, link-local, CGNAT, multicast and cloud-metadata addresses — including IPv4-mapped IPv6 forms and hostnames that **resolve** to such addresses. The check runs at connect time for every redirect hop, so DNS rebinding cannot bypass it. To ingest an intranet site, opt in explicitly:

```typescript
const intranet = new WebLoader({
  allowPrivateNetwork: true,
  headers: { Authorization: `Bearer ${process.env.WIKI_TOKEN}` },
  timeoutMs: 15_000,
  maxResponseBytes: 10 * 1024 * 1024,
});
```

Responses are decompressed (gzip, deflate, br), decoded using the declared charset, and limited to `maxResponseBytes` (50MB by default). Non-text content types are rejected.

```typescript
import { MarkdownLoader, WebLoader, CSVLoader, PDFLoader, JSONLoader } from '@cogitator-ai/rag';

const md = new MarkdownLoader({ stripFrontmatter: true });
const web = new WebLoader({ selector: 'article' });
const csv = new CSVLoader({ contentColumn: 'body', metadataColumns: ['title'] });
const pdf = new PDFLoader({ splitPages: true }); // one document per page
const json = new JSONLoader({ contentField: 'text' });
```

A pipeline has one loader; use `withChunker()` / `withRetriever()` on the builder to replace the chunker or retriever the config would create.

---

## Chunking Strategies

| Strategy    | Class              | Best For                               |
| ----------- | ------------------ | -------------------------------------- |
| `fixed`     | `FixedSizeChunker` | Simple, predictable chunk sizes        |
| `recursive` | `RecursiveChunker` | Respects paragraph/sentence boundaries |
| `semantic`  | `SemanticChunker`  | Groups semantically similar sentences  |

### Fixed-size

Splits text into chunks of exactly `chunkSize` characters with optional overlap.

```typescript
import { FixedSizeChunker } from '@cogitator-ai/rag';

const chunker = new FixedSizeChunker({ chunkSize: 500, chunkOverlap: 50 });
const chunks = chunker.chunk(text, documentId);
```

### Recursive

Splits on configurable separators (`\n\n`, `\n`, `. `, ` `) trying to keep paragraphs and sentences intact. Chunk offsets always point into the original text, chunks never exceed `chunkSize`, sentence punctuation is kept and overlap never produces a chunk fully contained in the previous one.

```typescript
import { RecursiveChunker } from '@cogitator-ai/rag';

const chunker = new RecursiveChunker({
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ['\n\n', '\n', '. ', ' '],
});
```

### Semantic

Uses embedding similarity between sentences (and blank-line separated blocks) to find natural breakpoints. Async — requires an `EmbeddingService`.

```typescript
import { SemanticChunker } from '@cogitator-ai/rag';

const chunker = new SemanticChunker({
  embeddingService,
  breakpointThreshold: 0.5,
  minChunkSize: 100,
  maxChunkSize: 2000,
});

const chunks = await chunker.chunk(text, documentId);
```

### Factory

```typescript
import { createChunker } from '@cogitator-ai/rag';

const chunker = createChunker(
  { strategy: 'recursive', chunkSize: 500, chunkOverlap: 50 },
  embeddingService
);
```

---

## Retrieval Strategies

| Strategy      | Class                 | Description                                                   |
| ------------- | --------------------- | ------------------------------------------------------------- |
| `similarity`  | `SimilarityRetriever` | Pure cosine similarity search                                 |
| `mmr`         | `MMRRetriever`        | Maximal Marginal Relevance — balances relevance and diversity |
| `hybrid`      | `HybridRetriever`     | Combines BM25 keyword search with vector search (RRF)         |
| `multi-query` | `MultiQueryRetriever` | Expands query into variants, merges results                   |

`RAGPipelineBuilder` builds the retriever matching `retrieval.strategy` when no custom `withRetriever()` is given:

```typescript
const pipeline = new RAGPipelineBuilder()
  .withLoader(loader)
  .withEmbeddingService(embeddingService)
  .withEmbeddingAdapter(embeddingAdapter)
  .withHybridSearch(new HybridSearch({ embeddingAdapter, embeddingService })) // 'hybrid'
  .withQueryExpander(expandWithLLM) // 'multi-query'
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 500, chunkOverlap: 50 },
    retrieval: { strategy: 'multi-query', multiQueryCount: 3, topK: 5 },
  })
  .build();
```

| Strategy      | Builder requirement                        | Config used                                                                                                     |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `similarity`  | —                                          | `topK`, `threshold`                                                                                             |
| `mmr`         | —                                          | `mmrLambda`, `topK`, `threshold`                                                                                |
| `hybrid`      | `withHybridSearch(hybridSearch, weights?)` | `topK`, `threshold`                                                                                             |
| `multi-query` | `withQueryExpander(fn)`                    | `multiQueryCount` (max variants), `topK`; base is hybrid when `withHybridSearch()` is set, similarity otherwise |

### Similarity

```typescript
import { SimilarityRetriever } from '@cogitator-ai/rag';

const retriever = new SimilarityRetriever({
  embeddingAdapter,
  embeddingService,
  defaultTopK: 10,
  defaultThreshold: 0.3,
});

const results = await retriever.retrieve('What is TypeScript?');
```

### MMR

Reduces redundancy by penalizing results that are too similar to already-selected ones. If the vector store does not return stored vectors (e.g. Qdrant), candidates are re-embedded to compute diversity.

```typescript
import { MMRRetriever } from '@cogitator-ai/rag';

const retriever = new MMRRetriever({
  embeddingAdapter,
  embeddingService,
  defaultLambda: 0.7, // 1.0 = pure relevance, 0.0 = pure diversity
  defaultTopK: 10,
});
```

### Hybrid

Requires `HybridSearch` from `@cogitator-ai/memory`. Chunks ingested through `RAGPipeline` are added to the HybridSearch BM25 index automatically (any retriever implementing `ChunkIndexer.indexChunk()` is notified on ingest), and keyword-only hits are mapped back to their chunk, document and metadata.

```typescript
import { HybridRetriever } from '@cogitator-ai/rag';
import { HybridSearch } from '@cogitator-ai/memory';

const retriever = new HybridRetriever({
  hybridSearch,
  defaultWeights: { bm25: 0.4, vector: 0.6 },
});
```

### Multi-Query

Generates query variations and merges results (best score per chunk). You provide the expansion function (typically an LLM call). The original query is always searched; variants are de-duplicated and capped by `defaultMaxQueries` / `multiQueryCount`. If expansion fails the original query is used alone; if every retrieval fails the error is thrown.

```typescript
import { MultiQueryRetriever } from '@cogitator-ai/rag';

const retriever = new MultiQueryRetriever({
  baseRetriever: similarityRetriever,
  expandQuery: async (query) => {
    const response = await llm.generate(
      `Generate 3 alternative phrasings for: "${query}". Return one per line.`
    );
    return response.split('\n').filter(Boolean);
  },
  defaultMaxQueries: 3,
});
```

### Factory

```typescript
import { createRetriever } from '@cogitator-ai/rag';

const retriever = createRetriever({
  strategy: 'mmr',
  embeddingAdapter,
  embeddingService,
  lambda: 0.7,
  topK: 10,
});
```

---

## Reranking

Rerankers rescore retrieval results for higher precision. Enable via pipeline config.

### LLM Reranker

Uses any LLM to score document relevance on a 0-10 scale.

```typescript
import { LLMReranker } from '@cogitator-ai/rag';

const reranker = new LLMReranker({
  generateFn: (prompt) => llm.generate(prompt),
});

const pipeline = new RAGPipelineBuilder()
  .withLoader(loader)
  .withEmbeddingService(embeddingService)
  .withEmbeddingAdapter(embeddingAdapter)
  .withReranker(reranker)
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 500, chunkOverlap: 50 },
    retrieval: { strategy: 'similarity', topK: 20 },
    reranking: { enabled: true, topN: 5 },
  })
  .build();
```

When the model's answer holds no ranking (a reasoning model that spent its token budget on reasoning returns empty content, for example) or `generateFn` throws, the reranker keeps the retrieval order and logs a warning. Pass `onError` to observe that fallback, or `strict: true` to make `rerank()` throw an `LLMRerankError` (with the raw answer in `response` and the original error in `cause`):

```typescript
const observed = new LLMReranker({
  generateFn: (prompt) => llm.generate(prompt),
  onError: (error, { query, response }) => logger.warn({ query, response }, error.message),
});

const strict = new LLMReranker({ generateFn: (prompt) => llm.generate(prompt), strict: true });
```

### Cohere Reranker

Uses the Cohere Rerank API (rerank-v3.5 by default).

```typescript
import { CohereReranker } from '@cogitator-ai/rag';

const reranker = new CohereReranker({
  apiKey: process.env.COHERE_API_KEY!,
  model: 'rerank-v3.5',
});
```

---

## Agent Integration

Use `ragTools()` to give a Cogitator agent access to your knowledge base.

```typescript
import { Agent, tool } from '@cogitator-ai/core';
import { RAGPipelineBuilder, TextLoader, ragTools } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, OpenAIEmbeddingService } from '@cogitator-ai/memory';

const pipeline = new RAGPipelineBuilder()
  .withLoader(new TextLoader())
  .withEmbeddingService(new OpenAIEmbeddingService({ apiKey: process.env.OPENAI_API_KEY! }))
  .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 400, chunkOverlap: 50 },
    retrieval: { strategy: 'similarity', topK: 3, threshold: 0.3 },
  })
  .build();

await pipeline.ingest('./knowledge-base');

const [ragSearch, ragIngest] = ragTools(pipeline, { allowedRoots: ['./knowledge-base'] });

const agent = new Agent({
  name: 'docs-assistant',
  model: 'openai/gpt-6.1-sol',
  instructions: 'Use rag_search to find information before answering.',
  tools: [tool(ragSearch), tool(ragIngest)],
});
```

`RAGTool` objects carry Zod parameter schemas and can be passed to `tool()` directly; `createSearchTool(pipeline)` and `createIngestTool(pipeline, options)` build them one at a time. `rag_search` falls back to the pipeline's configured `topK`/`threshold` when the model omits `limit`/`threshold`.

**Security:** `rag_ingest` reads whatever source the model passes. When the tool is exposed to an LLM, restrict it with `allowedRoots` (paths are canonicalized, so `..` traversal and symlink escapes are rejected) and `allowUrls: false` if web ingestion is not needed. URL ingestion goes through the SSRF-protected `WebLoader` when the pipeline uses one.

---

## Pipeline Stats

```typescript
const stats = pipeline.getStats();
console.log(stats.documentsIngested);
console.log(stats.chunksStored);
console.log(stats.queriesProcessed);
```

---

## Examples

See [`examples/rag/`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/examples/rag) for runnable examples:

- **01-basic-retrieval.ts** — Ingest documents and run semantic queries
- **02-chunking-strategies.ts** — Compare fixed, recursive, and semantic chunking
- **03-agent-with-rag.ts** — Full agent with RAG search tools

---

## Zod Schemas

```typescript
import {
  ChunkingStrategySchema,
  ChunkingConfigSchema,
  RetrievalStrategySchema,
  RetrievalConfigSchema,
  RerankingConfigSchema,
  RAGPipelineConfigSchema,
} from '@cogitator-ai/rag';
```

---

## License

MIT
