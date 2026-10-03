# Memory System

> Pluggable memory adapters with semantic search, facts, and knowledge graph support

## Overview

The `@cogitator-ai/memory` package provides conversation persistence for agents. It separates storage backends (adapters) from context assembly (`ContextBuilder`) so you can swap adapters without changing agent code.

More detail on the website: [Memory](https://cogitator.app/docs/memory), [Adapters](https://cogitator.app/docs/memory/adapters), [Embeddings](https://cogitator.app/docs/memory/embeddings), [Hybrid Search](https://cogitator.app/docs/memory/hybrid-search), [Knowledge Graphs](https://cogitator.app/docs/memory/knowledge-graphs).

```
┌──────────────────────────────────────────────────────────────┐
│                        ContextBuilder                        │
│                                                              │
│  systemPrompt ──► facts ──► semantic context ──► history    │
│                                        ▲                     │
│                                  token budget               │
└───────────────────────────────────────┬──────────────────────┘
                                        │
              ┌───────────────┬─────────┴──────────┬──────────────┐
              ▼               ▼                    ▼              ▼
        MemoryAdapter    FactAdapter       EmbeddingAdapter    GraphAdapter
              │               │                    │                │
   InMemory, Redis,       Postgres         Postgres, Qdrant,   PostgresGraph,
   Postgres, SQLite,                       InMemoryEmbedding   SQLiteGraph
   MongoDB
```

### MemoryResult

Adapter methods do not throw for expected failures; they return `MemoryResult<T>` (`{ success: true, data }` or `{ success: false, error }`). Check `result.success`, or use `unwrap()` to get the data and throw on failure:

```typescript
import { InMemoryAdapter, unwrap } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter({ provider: 'memory' });
unwrap(await memory.connect());

const thread = unwrap(await memory.createThread('agent-1', { title: 'Support chat' }));
unwrap(
  await memory.addEntry({
    threadId: thread.id,
    message: { role: 'user', content: 'Hello!' },
    tokenCount: 2,
  })
);

const result = await memory.getEntries({ threadId: thread.id, limit: 20 });
if (result.success) {
  console.log(result.data.map((e) => e.message.content));
} else {
  console.error(result.error);
}
```

---

## Adapters

### InMemoryAdapter (default)

In-process Map storage. Zero dependencies. Resets on process restart.

```typescript
import { InMemoryAdapter } from '@cogitator-ai/memory';

const adapter = new InMemoryAdapter({ provider: 'memory', maxEntries: 10000 });
await adapter.connect();
```

### RedisAdapter

Redis-backed storage with TTL. Supports standalone and cluster mode via `@cogitator-ai/redis`.

```typescript
import { RedisAdapter } from '@cogitator-ai/memory';

const standalone = new RedisAdapter({
  provider: 'redis',
  url: 'redis://localhost:6379',
  ttl: 86400, // default: 24 hours
  keyPrefix: 'cogitator:', // default
});

const cluster = new RedisAdapter({
  provider: 'redis',
  cluster: {
    nodes: [
      { host: 'redis-1', port: 6379 },
      { host: 'redis-2', port: 6379 },
    ],
  },
});

await standalone.connect();
```

In cluster mode the key prefix must contain a hash tag so multi-key commands hit one slot; the default is `{cogitator}:` and a prefix without one is wrapped (`app:` becomes `{app}:`).

### PostgresAdapter

Postgres with full feature set: threads, entries, facts, vector embeddings (pgvector).

Implements `MemoryAdapter + FactAdapter + EmbeddingAdapter + KeywordSearchAdapter`.

```typescript
import { PostgresAdapter } from '@cogitator-ai/memory';

const adapter = new PostgresAdapter({
  provider: 'postgres',
  connectionString: 'postgres://localhost/cogitator',
  schema: 'cogitator', // default
  poolSize: 10,
});

await adapter.connect(); // creates tables automatically
```

**Tables created (schema `cogitator`):**

| Table                  | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `cogitator.threads`    | Conversation sessions                    |
| `cogitator.entries`    | Memory entries (messages + token counts) |
| `cogitator.facts`      | Long-term agent knowledge                |
| `cogitator.embeddings` | Vector embeddings (ivfflat + GIN index)  |

Vector dimensions default to 768 (nomic-embed-text). Override with `adapter.setVectorDimensions(1536)` before connecting (it throws after `connect()`). The `embeddings` table also gets a generated `content_tsv` column with a GIN index for keyword search.

### SQLiteAdapter

File-based storage. Ideal for local development and single-server deployments.

```typescript
import { SQLiteAdapter } from '@cogitator-ai/memory';

const adapter = new SQLiteAdapter({
  provider: 'sqlite',
  path: './data/memory.db',
  walMode: true, // default, better concurrency (ignored for ':memory:')
});

await adapter.connect();
```

### MongoDBAdapter

```typescript
import { MongoDBAdapter } from '@cogitator-ai/memory';

const adapter = new MongoDBAdapter({
  provider: 'mongodb',
  uri: 'mongodb://localhost:27017',
  database: 'cogitator', // default
  collectionPrefix: 'memory_', // default
});

await adapter.connect();
```

### QdrantAdapter

Vector store only: implements `EmbeddingAdapter`, not `MemoryAdapter`, so pair it with a conversation adapter. Requires `@qdrant/js-client-rest`.

```typescript
import { QdrantAdapter } from '@cogitator-ai/memory';

const adapter = new QdrantAdapter({
  provider: 'qdrant',
  url: 'http://localhost:6333',
  apiKey: process.env.QDRANT_API_KEY,
  collection: 'cogitator', // default
  dimensions: 1536, // required
});

await adapter.connect();
```

### InMemoryEmbeddingAdapter

In-process `EmbeddingAdapter` + `KeywordSearchAdapter` for tests and small workloads:

```typescript
import { InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';

const embeddings = new InMemoryEmbeddingAdapter();
```

### Factories

`createMemoryAdapter(config)` builds a conversation adapter from a config with `provider: 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb'`; `createEmbeddingAdapter({ provider: 'qdrant', ... })` builds the Qdrant vector store. Both lazy-load the backend's driver.

---

## Core Interfaces

### MemoryAdapter

All adapters implement this interface:

```typescript
interface MemoryAdapter {
  readonly provider: MemoryProvider;

  // Thread management
  createThread(
    agentId: string,
    metadata?: Record<string, unknown>,
    threadId?: string
  ): Promise<MemoryResult<Thread>>;
  getThread(threadId: string): Promise<MemoryResult<Thread | null>>;
  updateThread(threadId: string, metadata: Record<string, unknown>): Promise<MemoryResult<Thread>>;
  deleteThread(threadId: string): Promise<MemoryResult<void>>;

  // Entry management
  addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;

  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}
```

Calling `createThread` with an existing `threadId` is an upsert in every adapter: stored entries and `createdAt` are kept, only the metadata is updated.

### Key Types

```typescript
interface Thread {
  id: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryEntry {
  id: string;
  threadId: string;
  message: Message;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  tokenCount: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

interface MemoryQueryOptions {
  threadId: string;
  limit?: number;
  before?: Date;
  after?: Date;
  includeToolCalls?: boolean;
}

type MemoryResult<T> = { success: true; data: T } | { success: false; error: string };
```

### FactAdapter (Postgres only)

For an SQLite-backed fact store with history, see `CoreFactsStore`.

Long-term knowledge storage — user preferences, learned facts, domain knowledge.

```typescript
interface FactAdapter {
  addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>>;
  getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>>;
  updateFact(
    factId: string,
    updates: Partial<Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt'>>
  ): Promise<MemoryResult<Fact>>;
  deleteFact(factId: string): Promise<MemoryResult<void>>;
  searchFacts(agentId: string, query: string): Promise<MemoryResult<Fact[]>>;
}

interface Fact {
  id: string;
  agentId: string;
  content: string;
  category: string;
  confidence: number;
  source: 'user' | 'inferred' | 'system';
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}
```

### EmbeddingAdapter

Implemented by `PostgresAdapter` (pgvector), `QdrantAdapter` and `InMemoryEmbeddingAdapter`.

```typescript
interface EmbeddingAdapter {
  addEmbedding(embedding: Omit<Embedding, 'id' | 'createdAt'>): Promise<MemoryResult<Embedding>>;
  search(options: SemanticSearchOptions): Promise<MemoryResult<(Embedding & { score: number })[]>>;
  deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>>;
  deleteBySource(sourceId: string): Promise<MemoryResult<void>>;
}

interface Embedding {
  id: string;
  sourceId: string;
  sourceType: 'message' | 'fact' | 'document';
  vector: number[];
  content: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

interface SemanticSearchOptions {
  query?: string;
  vector?: number[];
  limit?: number;
  threshold?: number;
  filter?: {
    sourceType?: Embedding['sourceType'];
    threadId?: string;
    agentId?: string;
    userId?: string;
  };
}
```

`filter.threadId` / `filter.agentId` / `filter.userId` match the embedding's `metadata.threadId` / `metadata.agentId` / `metadata.userId` (in Qdrant these are the same `metadata.*` payload keys). Semantic context is scoped per agent: embeddings whose `metadata.agentId` belongs to another agent are never injected, while embeddings without an `agentId` (shared documents) are visible to every agent.

---

## Context Building

`ContextBuilder` assembles messages for the LLM from stored history while respecting token limits.

```typescript
import { ContextBuilder } from '@cogitator-ai/memory';

const builder = new ContextBuilder(
  {
    maxTokens: 128_000,
    reserveTokens: 4000, // headroom for output
    strategy: 'hybrid', // 'recent' | 'relevant' | 'hybrid'
    includeSystemPrompt: true,
    includeFacts: true, // requires factAdapter
    includeSemanticContext: true, // requires embeddingAdapter + embeddingService
  },
  {
    memoryAdapter: postgresAdapter,
    factAdapter: postgresAdapter, // optional
    embeddingAdapter: postgresAdapter, // optional
    embeddingService, // optional
    // graphContextBuilder, // optional, for includeGraphContext
  }
);

const context = await builder.build({
  threadId: 'thread_abc123',
  agentId: 'agent_xyz',
  userId: 'alice', // optional: leave out other users' facts and embeddings
  systemPrompt: 'You are a helpful assistant.',
  currentInput: 'What did we discuss yesterday?', // used for semantic retrieval
});

// context.messages — ready to send to LLM
// context.tokenCount — tokens used
// context.truncated — whether history was cut
// context.facts — facts included in system prompt
// context.semanticResults — embeddings included
// context.graphContext — graph nodes/edges, when includeGraphContext is on
```

Facts (up to 10% of the budget), semantic context (top 5 embeddings scoring ≥ 0.7, up to 10%) and graph context (up to 15%) are merged into the system message. The rest of the budget is filled with conversation entries by the strategy.

### Strategies

| Strategy   | Behavior                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `recent`   | Most recent entries that fit the token budget                                                                |
| `relevant` | Entries selected by semantic similarity to `currentInput`                                                    |
| `hybrid`   | Up to 30% of the budget on older entries (outside the last 10) scoring above 0.6, the rest on recent entries |

`relevant` and `hybrid` need an `embeddingService` and a `currentInput`; without them (or, for `hybrid`, with 10 entries or fewer) they fall back to `recent`. Selected messages are always returned in chronological order.

### ContextBuilderConfig

```typescript
interface ContextBuilderConfig {
  maxTokens: number;
  reserveTokens?: number; // default: 10% of maxTokens (min 100)
  strategy: ContextStrategy;
  includeSystemPrompt?: boolean; // default: true
  includeFacts?: boolean; // default: false
  includeSemanticContext?: boolean; // default: false
  includeGraphContext?: boolean; // default: false
  graphContextOptions?: GraphContextOptions; // maxNodes, maxEdges, maxDepth, includeInferred, entityTypes, userId
}
```

---

## Embedding Services

```typescript
import { createEmbeddingService } from '@cogitator-ai/memory';

const openai = createEmbeddingService({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // default
  dimensions: 768, // optional, text-embedding-3-* only
});

const ollama = createEmbeddingService({
  provider: 'ollama',
  model: 'nomic-embed-text', // default
  baseUrl: 'http://localhost:11434', // optional
});

const google = createEmbeddingService({
  provider: 'google',
  apiKey: process.env.GOOGLE_API_KEY!,
  model: 'gemini-embedding-001', // default
});

const vector = await openai.embed('hello world');
const vectors = await openai.embedBatch(['text1', 'text2']);
console.log(openai.dimensions, ollama.dimensions, google.dimensions); // 768, 768, 3072
```

Default dimensions: OpenAI `text-embedding-3-small` 1536 (`-3-large` 3072), Ollama `nomic-embed-text` 768, Google `gemini-embedding-001` 3072. The classes `OpenAIEmbeddingService`, `OllamaEmbeddingService` and `GoogleEmbeddingService` take the same config.

---

## Hybrid Search

BM25 keyword search + vector search fused with Reciprocal Rank Fusion.

```typescript
import { HybridSearch, unwrap } from '@cogitator-ai/memory';

const search = new HybridSearch({
  embeddingAdapter: postgresAdapter,
  embeddingService,
  keywordAdapter: postgresAdapter, // PostgresAdapter implements KeywordSearchAdapter
  defaultWeights: { bm25: 0.3, vector: 0.7 },
});

const results = unwrap(
  await search.search({
    query: 'user preferences about dark mode',
    strategy: 'hybrid', // 'vector' | 'keyword' | 'hybrid'
    limit: 10,
    threshold: 0.5,
  })
);
// SearchResult[] with score, vectorScore, keywordScore
```

Without a `keywordAdapter`, keyword search uses a local `BM25Index`.

---

## Configuration (via CogitatorConfig)

The runtime builds its adapter from `memory.adapter`, which it supports for `'memory'`, `'redis'` (requires `redis.url`) and `'postgres'` (requires `postgres.connectionString`). Other values log a warning and leave memory off: for SQLite, MongoDB or a Redis cluster, connect the adapter yourself and assign it with `cog.memory = adapter` (such runs load the last 20 entries, since the context builder is only created from the `memory` config).

```typescript
interface MemoryConfig {
  adapter?: 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant';

  inMemory?: {
    maxEntries?: number;
  };

  redis?: {
    url?: string;
    host?: string;
    port?: number;
    cluster?: { nodes: { host: string; port: number }[]; scaleReads?: 'master' | 'slave' | 'all' };
    keyPrefix?: string;
    ttl?: number; // default: 86400 (24h)
    password?: string;
  };

  postgres?: {
    connectionString: string;
    schema?: string; // default: 'cogitator'
    poolSize?: number; // default: 10
  };

  sqlite?: {
    path: string; // use ':memory:' for in-memory
    walMode?: boolean; // default: true
  };

  mongodb?: {
    uri: string;
    database?: string; // default: 'cogitator'
    collectionPrefix?: string; // default: 'memory_'
  };

  qdrant?: {
    url?: string; // default: 'http://localhost:6333'
    apiKey?: string;
    collection?: string; // default: 'cogitator'
    dimensions: number; // required — must match embedding model
  };

  embedding?: EmbeddingServiceConfig; // { provider: 'openai' | 'ollama' | 'google', apiKey?, model?, baseUrl?, dimensions? }

  contextBuilder?: Partial<ContextBuilderConfig>; // maxTokens defaults to 4000, strategy to 'recent'
}
```

With `contextBuilder` set, Postgres is used as the fact and embedding adapter automatically. The runtime creates the Postgres `embeddings` table with 768-dimensional vectors, so pick an embedding config that produces 768 dimensions (`dimensions: 768` for OpenAI `text-embedding-3-*` or Google, or Ollama `nomic-embed-text`). Without `contextBuilder`, a run loads the last 20 entries of the thread.

---

## Knowledge Graph (Advanced)

Entity–relationship graph (Postgres or SQLite) with LLM-assisted extraction (`LLMEntityExtractor`), inference rules (`GraphInferenceEngine`) and context retrieval (`GraphContextBuilder`).

```typescript
import { PostgresGraphAdapter, GraphContextBuilder, unwrap } from '@cogitator-ai/memory';
import pg from 'pg';

const graph = new PostgresGraphAdapter({
  pool: new pg.Pool({ connectionString: process.env.DATABASE_URL! }),
  schema: 'cogitator', // default
  vectorDimensions: 1536,
});

const alice = unwrap(
  await graph.addNode({
    agentId: 'agent_123',
    type: 'person',
    name: 'Alice',
    aliases: [],
    properties: { role: 'engineer' },
    confidence: 1,
    source: 'user',
  })
);

const project = unwrap(
  await graph.addNode({
    agentId: 'agent_123',
    type: 'concept',
    name: 'Recommendation model',
    aliases: [],
    properties: {},
    confidence: 1,
    source: 'user',
  })
);

unwrap(
  await graph.addEdge({
    agentId: 'agent_123',
    sourceNodeId: alice.id,
    targetNodeId: project.id,
    type: 'related_to',
    label: 'works on',
    weight: 1,
    bidirectional: false,
    properties: {},
    confidence: 1,
    source: 'user',
  })
);

const similar = unwrap(
  await graph.searchNodesSemantic({
    agentId: 'agent_123',
    vector: await embeddingService.embed('engineers on ML projects'),
    limit: 10,
  })
);

const graphContext = new GraphContextBuilder(graph, embeddingService, {
  maxNodes: 20,
  maxDepth: 2,
});
const context = await graphContext.buildContext('agent_123', 'who works on what projects?');
```

Tables (`graph_nodes`, `graph_edges`) are created on first use. Pass the `GraphContextBuilder` as `graphContextBuilder` to `ContextBuilder` with `includeGraphContext: true` to inject graph context into runs. See [Knowledge Graphs](https://cogitator.app/docs/memory/knowledge-graphs).

---

## Related: RAG Pipeline

For document ingestion (PDFs, web pages, code, CSV) with chunking and retrieval, see `@cogitator-ai/rag`. It builds on top of `EmbeddingAdapter` from this package.

```typescript
import { RAGPipelineBuilder, MarkdownLoader } from '@cogitator-ai/rag';

const rag = new RAGPipelineBuilder()
  .withLoader(new MarkdownLoader())
  .withEmbeddingService(embeddingService)
  .withEmbeddingAdapter(postgresAdapter) // EmbeddingAdapter from @cogitator-ai/memory
  .withConfig({ chunking: { strategy: 'recursive', chunkSize: 512, chunkOverlap: 64 } })
  .build();

await rag.ingest('./docs/');
const results = await rag.query('how does authentication work?');
```

See [RAG](https://cogitator.app/docs/rag).

---

## Usage with Cogitator

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { unwrap } from '@cogitator-ai/memory';

const cog = new Cogitator({
  llm: { defaultModel: 'openai/gpt-5.5' },
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY!, dimensions: 768 },
    contextBuilder: { maxTokens: 8000, strategy: 'hybrid', includeSemanticContext: true },
  },
});

const agent = new Agent({ name: 'assistant', instructions: 'You are helpful.' });

const result = await cog.run(agent, {
  input: 'Hello!',
  threadId: 'thread_user_123',
});

const memory = await cog.getMemory();
if (memory) {
  const history = unwrap(await memory.getEntries({ threadId: result.threadId }));
  console.log(history.length);
}
```

- A run with a `threadId` loads and saves its history; per run, `useMemory: false` disables memory, `loadHistory: false` / `saveHistory: false` skip loading or saving, and `onMemoryError` is called when a load or save fails.
- `await cog.getMemory()` connects and returns the adapter before any run (`undefined` when memory is not configured or could not connect); `cog.memory` returns it once connected, and assigning `cog.memory = adapter` plugs in an adapter you created yourself.
- Pass `userId` in run options to scope threads, facts and embeddings per user — see [Multiple Users](https://cogitator.app/docs/advanced/multi-user).
