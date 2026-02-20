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
await pipeline.ingest('./docs');

// query the knowledge base
const results = await pipeline.query('How does authentication work?');

for (const r of results) {
  console.log(`[${r.score.toFixed(3)}] ${r.content.slice(0, 100)}...`);
}
```

---

## Document Loaders

| Loader           | Formats               | Optional Dep | Notes                         |
| ---------------- | --------------------- | ------------ | ----------------------------- |
| `TextLoader`     | `.txt`                | —            | Files and directories         |
| `MarkdownLoader` | `.md`                 | —            | Strips frontmatter by default |
| `JSONLoader`     | `.json`               | —            | Configurable JSON path        |
| `CSVLoader`      | `.csv`                | `papaparse`  | Column selection, row mapping |
| `HTMLLoader`     | `.html`, `.htm`       | `cheerio`    | CSS selector support          |
| `PDFLoader`      | `.pdf`                | `pdf-parse`  | Text extraction from PDFs     |
| `WebLoader`      | `http://`, `https://` | `cheerio`    | Fetches and parses web pages  |

```typescript
import { MarkdownLoader, WebLoader, CSVLoader } from '@cogitator-ai/rag';

const md = new MarkdownLoader({ stripFrontmatter: true });
const web = new WebLoader({ selector: 'article' });
const csv = new CSVLoader({ columns: ['title', 'body'] });
```

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

Splits on configurable separators (`\n\n`, `\n`, `. `, ` `) trying to keep paragraphs and sentences intact.

```typescript
import { RecursiveChunker } from '@cogitator-ai/rag';

const chunker = new RecursiveChunker({
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ['\n\n', '\n', '. ', ' '],
});
```

### Semantic

Uses embedding similarity between sentences to find natural breakpoints. Async — requires an `EmbeddingService`.

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

Reduces redundancy by penalizing results that are too similar to already-selected ones.

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

Requires `HybridSearch` from `@cogitator-ai/memory`.

```typescript
import { HybridRetriever } from '@cogitator-ai/rag';
import { HybridSearch } from '@cogitator-ai/memory';

const retriever = new HybridRetriever({
  hybridSearch,
  defaultWeights: { bm25: 0.4, vector: 0.6 },
});
```

### Multi-Query

Generates query variations and merges results. You provide the expansion function (typically an LLM call).

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
import { RAGPipelineBuilder, TextLoader, createSearchTool } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, OpenAIEmbeddingService } from '@cogitator-ai/memory';
import { z } from 'zod';

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

const ragSearch = createSearchTool(pipeline);

const searchKB = tool({
  name: ragSearch.name,
  description: ragSearch.description,
  parameters: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().int().positive().optional(),
    threshold: z.number().min(0).max(1).optional(),
  }),
  execute: async (params) => ragSearch.execute(params),
});

const agent = new Agent({
  name: 'docs-assistant',
  model: 'gpt-4o',
  instructions: 'Use rag_search to find information before answering.',
  tools: [searchKB],
});
```

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

See [`examples/rag/`](../../examples/rag/) for runnable examples:

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
