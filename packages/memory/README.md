# @cogitator-ai/memory

Memory adapters for Cogitator AI agents. Supports in-memory, Redis (short-term), PostgreSQL with pgvector, SQLite and MongoDB (persistent), plus in-memory/pgvector/Qdrant embedding stores for semantic memory.

## Installation

```bash
pnpm add @cogitator-ai/memory

# Optional peer dependencies
pnpm add ioredis  # For Redis adapter
pnpm add pg       # For PostgreSQL adapter
pnpm add better-sqlite3  # For SQLite adapter and CoreFactsStore
pnpm add mongodb  # For MongoDB adapter
pnpm add @qdrant/js-client-rest  # For Qdrant embedding adapter
```

With `@cogitator-ai/core` you usually configure memory on the runtime (`new Cogitator({ memory: { adapter: 'postgres', postgres: { ... } } })`) and read it with `await cog.getMemory()`; the adapters below are for direct use. Website docs: [Memory](https://cogitator.app/docs/memory), [Adapters](https://cogitator.app/docs/memory/adapters), [Embeddings](https://cogitator.app/docs/memory/embeddings), [Hybrid Search](https://cogitator.app/docs/memory/hybrid-search), [Knowledge Graphs](https://cogitator.app/docs/memory/knowledge-graphs).

## Features

- **Multiple Adapters** - In-memory, Redis (standalone + cluster), PostgreSQL with pgvector, SQLite, MongoDB, Qdrant
- **Thread Management** - Create (idempotent upsert), update, delete conversation threads
- **Stable Ordering** - Entries keep insertion order even when saved within the same millisecond
- **Token Counting** - Estimate token usage without tiktoken dependency
- **Context Builder** - Token-aware context with `recent`, `relevant` (embedding-ranked) and `hybrid` strategies
- **Scoped Semantic Memory** - Embeddings tagged with `metadata.agentId` / `metadata.threadId` never leak to other agents
- **Sessions & Compaction** - `SessionManager` for channel sessions, `CompactionService` for summarizing long histories
- **Embedding Services** - OpenAI, Ollama and Google embedding integration
- **Semantic Search** - Vector similarity search with pgvector
- **Hybrid Search** - BM25 + Vector with Reciprocal Rank Fusion
- **Facts Storage** - Store and retrieve agent knowledge (`FactAdapter` on PostgreSQL, `CoreFactsStore` on SQLite)
- **Knowledge Graph** - Entity-relationship memory with multi-hop traversal
- **Zod Schemas** - Type-safe configuration validation

---

## Quick Start

```typescript
import { InMemoryAdapter, ContextBuilder, unwrap } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();

const thread = unwrap(await memory.createThread('agent-1', { topic: 'greeting' }));

await memory.addEntry({
  threadId: thread.id,
  message: { role: 'user', content: 'Hello!' },
  tokenCount: 2,
});

await memory.addEntry({
  threadId: thread.id,
  message: { role: 'assistant', content: 'Hi there!' },
  tokenCount: 3,
});

const builder = new ContextBuilder(
  { maxTokens: 4000, strategy: 'recent' },
  { memoryAdapter: memory }
);

const context = await builder.build({
  threadId: thread.id,
  agentId: 'agent-1',
  systemPrompt: 'You are helpful.',
});

console.log(context.messages);
```

Adapter calls return a `MemoryResult` — `{ success: true, data }` or `{ success: false, error }` — instead of throwing. `unwrap(result)` returns the data or throws an `Error` with the adapter's message; check `result.success` yourself where a failure is expected:

```typescript
const result = await memory.getThread('thread_123');
if (!result.success) {
  console.error('Memory unavailable:', result.error);
} else if (result.data) {
  console.log(result.data.metadata);
}
```

---

## Memory Adapters

### In-Memory Adapter

Fast, non-persistent storage for development and testing.

```typescript
import { InMemoryAdapter } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter({
  provider: 'memory',
  maxEntries: 1000,
});

await memory.connect();
```

### Redis Adapter

Persistent short-term memory with TTL support. Every write refreshes the TTL of the thread and its entry index, so active conversations do not expire mid-way; expired entries are pruned from the index on read. `getEntries({ limit })` reads only the newest `limit` entries. A failed `connect()` closes its client again, so an unreachable Redis does not keep the process alive.

```typescript
import { RedisAdapter } from '@cogitator-ai/memory';

const memory = new RedisAdapter({
  provider: 'redis',
  url: 'redis://localhost:6379',
  keyPrefix: 'cogitator:',
  ttl: 3600,
});

await memory.connect();
```

Redis Cluster is supported via `cluster: { nodes: [{ host, port }] }`. In cluster mode the key prefix is wrapped in a hash tag (`'{cogitator}:'` by default, `'myapp:'` becomes `'{myapp}:'`) so all keys of the adapter live in one slot.

### PostgreSQL Adapter

Long-term storage with vector search via pgvector.

```typescript
import { PostgresAdapter } from '@cogitator-ai/memory';

const memory = new PostgresAdapter({
  provider: 'postgres',
  connectionString: 'postgresql://localhost:5432/cogitator',
  schema: 'public',
  poolSize: 10,
  dimensions: 1536, // vector size of the embedding model, default 768
});

await memory.connect();
memory.vectorStatus(); // { available: true, dimensions: 1536 } or { available: false, reason }
```

On `connect()` the adapter creates its tables and an HNSW cosine index on the embeddings, which works from the first row on (no training data needed). An `ivfflat` index left by an earlier version is replaced on the first connect after upgrading, see the [adapters docs](https://cogitator.app/docs/memory/adapters) for building the new index ahead of time on a large table. `search()` raises `hnsw.ef_search` to the requested limit and, on pgvector 0.8+, uses iterative scans, so large limits and filters still get every matching row. Messages, tool calls, tool results and metadata are stored as `jsonb`.

pgvector is only needed for embeddings. Without it, `connect()` still succeeds and threads, entries and facts work, while embedding operations return a failed result naming the reason (also logged at connect). An existing `embeddings` table keeps its vector size: an adapter without `dimensions` adopts it, one configured for another size reports the mismatch through `vectorStatus()` and the failed results instead of failing each search with a Postgres error.

### SQLite Adapter

```typescript
import { SQLiteAdapter } from '@cogitator-ai/memory';

const memory = new SQLiteAdapter({
  provider: 'sqlite',
  path: './cogitator.db', // ':memory:' for an in-memory database
  walMode: true,
});

await memory.connect();
```

### MongoDB Adapter

```typescript
import { MongoDBAdapter } from '@cogitator-ai/memory';

const memory = new MongoDBAdapter({
  provider: 'mongodb',
  uri: 'mongodb://localhost:27017',
  database: 'cogitator',
});

await memory.connect();
```

Threads and entries live in the `<collectionPrefix>threads` and `<collectionPrefix>entries` collections (prefix `memory_` by default), indexed on `agentId` and `(threadId, createdAt)`. Fields left `undefined` are omitted from the stored documents, not stored as `null`. A failed `connect()` leaves the adapter disconnected, so a later `connect()` retries.

### Qdrant Adapter (Embedding)

```typescript
import { QdrantAdapter } from '@cogitator-ai/memory';

const embeddings = new QdrantAdapter({
  provider: 'qdrant',
  url: 'http://localhost:6333',
  collection: 'cogitator',
  dimensions: 1536,
});

await embeddings.connect();
```

`QdrantAdapter` is an `EmbeddingAdapter` (store and search vectors), not a thread store; pair it with one of the adapters above. Points are stored under a deterministic UUID derived from the embedding id (Qdrant accepts only integer and UUID point ids); the `emb_…` id stays in `payload.embeddingId` and is what `search` returns.

### Factory Function

```typescript
import { createMemoryAdapter, createEmbeddingAdapter } from '@cogitator-ai/memory';

const memory = await createMemoryAdapter({ provider: 'memory' });

const redis = await createMemoryAdapter({
  provider: 'redis',
  url: 'redis://localhost:6379',
});

const postgres = await createMemoryAdapter({
  provider: 'postgres',
  connectionString: 'postgresql://localhost:5432/db',
});

const sqlite = await createMemoryAdapter({
  provider: 'sqlite',
  path: './cogitator.db',
});

const qdrant = await createEmbeddingAdapter({
  provider: 'qdrant',
  dimensions: 1536,
});

await postgres.connect(); // the factories create adapters; connect them before use
await qdrant.connect(); // typed as ConnectableEmbeddingAdapter, no cast needed
```

`createMemoryAdapter` loads the adapter's driver lazily, so only the drivers you use need to be installed.

---

## MemoryAdapter Interface

All adapters implement the `MemoryAdapter` interface:

```typescript
interface MemoryAdapter {
  readonly provider: MemoryProvider;

  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;

  createThread(agentId: string, metadata?: Record<string, unknown>): Promise<MemoryResult<Thread>>;
  getThread(threadId: string): Promise<MemoryResult<Thread | null>>;
  updateThread(threadId: string, metadata: Record<string, unknown>): Promise<MemoryResult<Thread>>;
  deleteThread(threadId: string): Promise<MemoryResult<void>>;

  addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;
}
```

### Thread Operations

`createThread(agentId, metadata, threadId)` with an existing `threadId` is an upsert: entries and `createdAt` are kept and only the metadata is updated, so it is safe to call on every run.

```typescript
const thread = unwrap(
  await memory.createThread('agent-1', {
    topic: 'support',
    user: 'user-123',
  })
);

const found = unwrap(await memory.getThread(thread.id)); // Thread | null

await memory.updateThread(thread.id, {
  resolved: true,
});

await memory.deleteThread(thread.id);
```

### Entry Operations

```typescript
const entry = unwrap(
  await memory.addEntry({
    threadId: thread.id,
    message: { role: 'user', content: 'Hello' },
    tokenCount: 10,
  })
);

const entries = unwrap(
  await memory.getEntries({
    threadId: thread.id,
    limit: 50, // the most recent 50, oldest first
    includeToolCalls: true,
    // before / after: Date bounds
  })
);

const single = unwrap(await memory.getEntry(entry.id));

await memory.deleteEntry(entry.id);

await memory.clearThread(thread.id);
```

---

## Context Builder

Build token-aware conversation context from memory.

### Configuration

```typescript
interface ContextBuilderConfig {
  maxTokens: number;
  reserveTokens?: number;
  strategy: 'recent' | 'relevant' | 'hybrid';
  includeSystemPrompt?: boolean;
  includeFacts?: boolean;
  includeSemanticContext?: boolean;
  includeGraphContext?: boolean;
  graphContextOptions?: GraphContextOptions;
}
```

Strategies:

- `recent` - the newest messages that fit into the token budget, as one unbroken run: the window stops at the first message that does not fit, so a reply never appears without the message it answers
- `relevant` - messages ranked by embedding similarity to `currentInput` (requires `embeddingService`; falls back to `recent` without input), returned in chronological order
- `hybrid` - always keeps the latest messages and fills the remaining budget with the most relevant older ones

The system prompt is always kept and counted: history gets what it leaves of `maxTokens - reserveTokens`, and a prompt larger than that is still sent whole, with a note in `warnings`. Entries are counted by their text, tool call arguments and images rather than only by their saved `tokenCount`. `relevant` and `hybrid` score the newest 200 entries and embed each entry once per builder (vectors are cached by entry id).

### Basic Usage

```typescript
import { ContextBuilder } from '@cogitator-ai/memory';

const builder = new ContextBuilder(
  {
    maxTokens: 4000,
    reserveTokens: 400,
    strategy: 'recent',
    includeSystemPrompt: true,
  },
  { memoryAdapter: memory }
);

const context = await builder.build({
  threadId: 'thread_123',
  agentId: 'agent-1',
  systemPrompt: 'You are a helpful assistant.',
});

console.log(context.messages);
console.log(context.tokenCount);
console.log(context.truncated);
```

### With Facts and Semantic Search

```typescript
const builder = new ContextBuilder(
  {
    maxTokens: 8000,
    strategy: 'recent',
    includeFacts: true,
    includeSemanticContext: true,
  },
  {
    memoryAdapter: memory,
    factAdapter: factStore,
    embeddingAdapter: vectorStore,
    embeddingService: embeddings,
  }
);

const context = await builder.build({
  threadId: 'thread_123',
  agentId: 'agent-1',
  systemPrompt: 'You are an expert.',
  currentInput: 'What is machine learning?',
});

console.log(context.facts);
console.log(context.semanticResults);
```

Embedding stores also accept `filter.metadata` (exact metadata values) in `search`/`keywordSearch`, and `deleteByFilter({ sourceType?, agentId?, threadId?, metadata? })` deletes every matching embedding (a filter without conditions is refused). RAG re-ingest uses it to replace a source's chunks.

Semantic context is scoped by embedding metadata: entries with `metadata.agentId` set are only visible to that agent, entries without an `agentId` (shared documents, knowledge bases) are visible to everyone. Adapters filter `search`/`keywordSearch` by `filter.agentId` and `filter.threadId` through the same metadata fields.

### Built Context

```typescript
interface BuiltContext {
  messages: Message[];
  facts: Fact[];
  semanticResults: (Embedding & { score: number })[];
  graphContext?: GraphContext; // with includeGraphContext and a graph adapter
  tokenCount: number;
  truncated: boolean;
  errors?: ContextBuildError[]; // parts that failed to load and were left out
  warnings?: string[]; // budget problems, such as a system prompt over budget
  metadata: {
    originalMessageCount: number;
    includedMessageCount: number;
    factsIncluded: number;
    semanticResultsIncluded: number;
  };
}

interface ContextBuildError {
  source: 'history' | 'facts' | 'semantic' | 'graph' | 'relevance';
  error: Error;
}
```

`build()` does not throw when a part of the context fails to load (an unreachable store, an embedding API answering 429, a vector size mismatch): the part is left out and reported in `errors`. A failed relevance scoring falls back to the `recent` strategy.

---

## Sessions and Compaction

`SessionManager` maps channel conversations (user + channel + agent) onto memory threads. `CompactionService` replaces old history with an LLM summary placed before the most recent messages.

```typescript
import { createLLMBackend } from '@cogitator-ai/core';
import { InMemoryAdapter, SessionManager, CompactionService } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
const llm = createLLMBackend('google', {
  providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
});

const compaction = new CompactionService({
  adapter: memory,
  summarize: async (messages, { model, prompt } = {}) => {
    const response = await llm.chat({
      model: model ?? 'gemini-3.5-flash-lite',
      messages: [
        { role: 'system', content: prompt ?? 'Summarize this conversation in a few sentences.' },
        ...messages,
      ],
    });
    return response.content;
  },
});
const sessions = new SessionManager(memory, { compaction });

const session = await sessions.getOrCreate({
  userId: 'user-1',
  channelType: 'telegram',
  channelId: 'chat-42',
  agentId: 'assistant',
});

const all = await sessions.list();
const mine = await sessions.list({ userId: 'user-1', status: 'active', limit: 20 });

await sessions.compact(session.id, {
  strategy: 'summary',
  threshold: 8000,
  keepRecent: 10,
  summaryModel: 'gemini-3.5-flash',
  summaryPrompt: 'Keep names, decisions and open questions.',
});
```

`list()` works with or without a `userId` filter (sessions are tracked in an index thread). Using a session puts it back into the index if the index lost it and rewrites the index at most once per `indexRefreshInterval` (default one minute), so with Redis and a `ttl` the index lives as long as any session is active.

A thread is compacted once its entries hold `threshold` tokens or `messageThreshold` entries, whichever comes first (set at least one). The summary entry is dated just before the first kept entry and the kept entries are not rewritten, so a reply saved while the summary was being written keeps its place after its question. `addEntry` accepts an optional `createdAt` for this (`NewMemoryEntry`).

`compact()` requires the `compaction` option; without it use `CompactionService` directly. The summarizer (`SummarizeFn`) is called as `summarize(messages, options)`, where `options` is a `SummarizeOptions` `{ model?, prompt? }` filled from the `summaryModel` / `summaryPrompt` of the compaction config.

---

## Core Facts

`CoreFactsStore` keeps a small set of key/value facts about the user in SQLite (with history), formatted for a system prompt:

```typescript
import { CoreFactsStore } from '@cogitator-ai/memory';

const facts = new CoreFactsStore({ path: './facts.db' }); // or { db } to share a better-sqlite3 database
await facts.initialize();

await facts.set('name', 'Alice');
await facts.get('name'); // 'Alice'
await facts.getAll(); // { name: 'Alice' }
await facts.getHistory('name'); // [{ value, setAt }]
const prompt = await facts.formatForPrompt();
await facts.close();
```

---

## Token Counting

Simple token estimation without tiktoken dependency.

```typescript
import {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  countToolCallsTokens,
  countEntryTokens,
  truncateToTokens,
} from '@cogitator-ai/memory';

const tokens = countTokens('Hello, world!');

const msgTokens = countMessageTokens({ role: 'user', content: 'Hello!' });

const totalTokens = countMessagesTokens([
  { role: 'user', content: 'Hello!' },
  { role: 'assistant', content: 'Hi there!' },
]);

const truncated = truncateToTokens('Very long text...', 100);
```

`countMessageTokens` counts text, the names and JSON arguments of an assistant message's `toolCalls`, and images (85 tokens for `detail: 'low'`, otherwise an upper estimate of 1600, since the pixel size is unknown). `countEntryTokens` recounts a stored entry, including `entry.toolCalls`, and keeps the saved `tokenCount` when it is larger.

---

## Embedding Services

### OpenAI Embeddings

```typescript
import { OpenAIEmbeddingService, createEmbeddingService } from '@cogitator-ai/memory';

const embeddings = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // default
  dimensions: 512, // optional, sent to text-embedding-3 models (gateway ids like openai/text-embedding-3-small too)
});

// or through the factory
const viaFactory = createEmbeddingService({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

const vector = await embeddings.embed('Hello, world!');

const vectors = await embeddings.embedBatch(['Hello', 'World']);
```

For other models `dimensions` declares the size they return. When a response holds vectors of another size than the configured `dimensions`, `embed()` and `embedBatch()` throw instead of handing them to a store sized for it.

### Ollama Embeddings

```typescript
import { OllamaEmbeddingService, createEmbeddingService } from '@cogitator-ai/memory';

const embeddings = new OllamaEmbeddingService({
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:11434',
});

const viaFactory = createEmbeddingService({
  provider: 'ollama',
  model: 'nomic-embed-text',
});

const vector = await embeddings.embed('Hello, world!');
```

### Google Embeddings

```typescript
import { GoogleEmbeddingService, createEmbeddingService } from '@cogitator-ai/memory';

const embeddings = new GoogleEmbeddingService({
  apiKey: process.env.GOOGLE_API_KEY!,
  model: 'gemini-embedding-001',
  dimensions: 768,
});

const viaFactory = createEmbeddingService({
  provider: 'google',
  apiKey: process.env.GOOGLE_API_KEY!,
});

const vector = await embeddings.embed('Hello, world!');
```

---

## Hybrid Search

Combine keyword search (BM25) with semantic search (vector embeddings) using Reciprocal Rank Fusion for best-of-both-worlds retrieval.

### Configuration

```typescript
import {
  HybridSearch,
  InMemoryEmbeddingAdapter,
  OpenAIEmbeddingService,
} from '@cogitator-ai/memory';

const embeddingService = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
});

const embeddingAdapter = new InMemoryEmbeddingAdapter();

const search = new HybridSearch({
  embeddingAdapter,
  embeddingService,
  keywordAdapter: embeddingAdapter, // PostgresAdapter also implements KeywordSearchAdapter
  defaultWeights: { bm25: 0.4, vector: 0.6 },
});
```

### Search Strategies

```typescript
// Pure vector search (semantic similarity)
const vectorResults = await search.search({
  query: 'machine learning algorithms',
  strategy: 'vector',
  limit: 10,
});

// Pure keyword search (BM25)
const keywordResults = await search.search({
  query: 'machine learning algorithms',
  strategy: 'keyword',
  limit: 10,
});

// Hybrid search (combines both with RRF)
const hybridResults = await search.search({
  query: 'machine learning algorithms',
  strategy: 'hybrid',
  weights: { bm25: 0.4, vector: 0.6 },
  limit: 10,
});

// Results include both scores
for (const result of unwrap(hybridResults)) {
  console.log(`${result.content} — score: ${result.score}`);
  console.log(`  vector: ${result.vectorScore}, keyword: ${result.keywordScore}`);
}
```

### Document Indexing

With a `keywordAdapter`, keyword search runs on that adapter's own index (embeddings added to `InMemoryEmbeddingAdapter` or `PostgresAdapter` are searchable right away). Without one, `HybridSearch` keeps a local BM25 index that you fill yourself (it ignores `filter`):

```typescript
// Add documents to BM25 index
search.indexDocument('doc-1', 'Machine learning is a subset of AI...');
search.indexDocument('doc-2', 'Deep learning uses neural networks...');

// Remove from index
search.removeDocument('doc-1');

// Clear entire index
search.clearIndex();

// Check index size
console.log('Indexed documents:', search.indexSize);
```

### Why Hybrid Search?

| Search Type        | Strengths                                            | Weaknesses                      |
| ------------------ | ---------------------------------------------------- | ------------------------------- |
| **Vector**         | Finds semantically similar content, handles synonyms | Misses exact keyword matches    |
| **Keyword (BM25)** | Exact term matching, fast                            | Misses synonyms and paraphrases |
| **Hybrid**         | Best of both worlds                                  | Slightly more computation       |

**Example:** Query "ML algorithms"

- Vector search finds "machine learning methods" (semantic match)
- Keyword search finds "ML algorithms comparison" (exact match)
- Hybrid returns both, ranked by combined relevance

### Reciprocal Rank Fusion (RRF)

Hybrid search uses RRF to combine rankings from both search methods:

```
RRF_score(d) = Σ 1 / (k + rank_i(d))
```

Where `k` is a constant (default 60) and `rank_i(d)` is the rank of document `d` in result set `i`. This produces stable rankings even when individual scores are on different scales.

---

## Zod Schemas

Type-safe configuration validation:

```typescript
import {
  MemoryProviderSchema,
  InMemoryConfigSchema,
  RedisConfigSchema,
  PostgresConfigSchema,
  MemoryAdapterConfigSchema,
  ContextStrategySchema,
  ContextBuilderConfigSchema,
  EmbeddingProviderSchema,
  OpenAIEmbeddingConfigSchema,
  OllamaEmbeddingConfigSchema,
  EmbeddingServiceConfigSchema,
} from '@cogitator-ai/memory';

const config = MemoryAdapterConfigSchema.parse({
  provider: 'redis',
  url: 'redis://localhost:6379',
  ttl: 3600,
});

const builderConfig = ContextBuilderConfigSchema.parse({
  maxTokens: 4000,
  strategy: 'recent',
});
```

---

## Type Reference

```typescript
import type {
  MemoryType,
  Thread,
  MemoryEntry,
  Fact,
  Embedding,
  MemoryProvider,
  MemoryAdapterConfig,
  RedisAdapterConfig,
  PostgresAdapterConfig,
  InMemoryAdapterConfig,
  MemoryResult,
  MemoryQueryOptions,
  SemanticSearchOptions,
  MemoryAdapter,
  FactAdapter,
  EmbeddingAdapter,
  EmbeddingService,
  EmbeddingProvider,
  EmbeddingServiceConfig,
  OpenAIEmbeddingConfig,
  OllamaEmbeddingConfig,
  ContextBuilderConfig,
  ContextStrategy,
  BuiltContext,
  MemoryConfig,
} from '@cogitator-ai/memory';
```

---

## Examples

### Conversation History

```typescript
import { InMemoryAdapter, countMessageTokens, unwrap } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();

const thread = unwrap(await memory.createThread('chatbot'));

const messages = [
  { role: 'user' as const, content: 'What is AI?' },
  { role: 'assistant' as const, content: 'AI is artificial intelligence...' },
  { role: 'user' as const, content: 'Tell me more' },
];

for (const msg of messages) {
  await memory.addEntry({
    threadId: thread.id,
    message: msg,
    tokenCount: countMessageTokens(msg),
  });
}

const history = unwrap(
  await memory.getEntries({
    threadId: thread.id,
    limit: 10,
  })
);
```

### Token-Limited Context

```typescript
import { InMemoryAdapter, ContextBuilder, countMessagesTokens } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();

const builder = new ContextBuilder(
  { maxTokens: 2000, strategy: 'recent' },
  { memoryAdapter: memory }
);

const context = await builder.build({
  threadId: 'thread_123',
  agentId: 'agent-1',
  systemPrompt: 'You are a concise assistant.',
});

console.log(`Using ${context.tokenCount} tokens`);
console.log(`Truncated: ${context.truncated}`);
console.log(
  `Included ${context.metadata.includedMessageCount} of ${context.metadata.originalMessageCount} messages`
);
```

### Semantic Memory with PostgreSQL

```typescript
import { PostgresAdapter, OpenAIEmbeddingService, unwrap } from '@cogitator-ai/memory';

const memory = new PostgresAdapter({
  provider: 'postgres',
  connectionString: process.env.DATABASE_URL!,
});

const embeddings = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
});

await memory.connect();

const content = 'Machine learning is a subset of AI...';
await memory.addEmbedding({
  sourceId: 'doc-1',
  sourceType: 'document',
  content,
  vector: await embeddings.embed(content),
  metadata: { agentId: 'agent-1' },
});

const matches = unwrap(
  await memory.search({
    vector: await embeddings.embed('What is ML?'),
    limit: 5,
    threshold: 0.7,
    filter: { agentId: 'agent-1' },
  })
);
```

---

## Knowledge Graph

Entity-relationship memory with multi-hop traversal and semantic reasoning.

### PostgresGraphAdapter

Graph adapters return `MemoryResult`s like the memory adapters. `PostgresGraphAdapter` takes an existing `pg` pool and creates its tables on first use; `SQLiteGraphAdapter` takes `{ path, walMode? }`.

```typescript
import { PostgresGraphAdapter, unwrap } from '@cogitator-ai/memory';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const graph = new PostgresGraphAdapter({ pool, vectorDimensions: 1536 }); // default 768

const person = unwrap(
  await graph.addNode({
    agentId: 'agent-1',
    type: 'person',
    name: 'Alice',
    aliases: [],
    description: 'Software engineer',
    properties: { role: 'developer' },
    confidence: 1.0,
    source: 'user',
  })
);

const company = unwrap(
  await graph.addNode({
    agentId: 'agent-1',
    type: 'organization',
    name: 'TechCorp',
    aliases: [],
    properties: {},
    confidence: 1.0,
    source: 'extracted',
  })
);

await graph.addEdge({
  agentId: 'agent-1',
  sourceNodeId: person.id,
  targetNodeId: company.id,
  type: 'works_at',
  weight: 1.0,
  bidirectional: false,
  properties: {},
  confidence: 0.95,
  source: 'extracted',
});
```

### Multi-hop Traversal

```typescript
const result = unwrap(
  await graph.traverse({
    agentId: 'agent-1',
    startNodeId: person.id,
    maxDepth: 3,
    direction: 'outgoing', // 'outgoing' | 'incoming' | 'both'
    edgeTypes: ['works_at', 'knows', 'located_in'],
  })
);

console.log('Visited nodes:', result.visitedNodes);
console.log('Paths found:', result.paths);
```

### Shortest Path

```typescript
const path = unwrap(await graph.findShortestPath('agent-1', person.id, company.id, 5));
if (path) {
  console.log('Path:', path.nodes.map((n) => n.name).join(' -> '));
  console.log('Total weight:', path.totalWeight);
}
```

### Semantic Node Search

```typescript
const similar = unwrap(
  await graph.searchNodesSemantic({
    agentId: 'agent-1',
    vector: await embeddingService.embed('machine learning engineer'), // a vector is required
    limit: 10,
    threshold: 0.7,
  })
); // nodes with a `score`
```

### LLM Entity Extraction

```typescript
import { LLMEntityExtractor } from '@cogitator-ai/memory';

const backend = cog.getLLMBackend('openai/gpt-5.5');

const extractor = new LLMEntityExtractor(backend, {
  model: 'gpt-5.5', // required with an LLMBackend
  minConfidence: 0.7,
  maxEntitiesPerText: 20,
  maxRelationsPerText: 30,
});

const result = await extractor.extract(
  'Alice works at TechCorp in San Francisco. She knows Bob from the AI conference.',
  { agentId: 'agent-1' }
);

console.log('Entities:', result.entities);
console.log('Relations:', result.relations);
```

Any object with a `chat({ model?, messages, responseFormat })` method resolving to `{ content }` (`LLMBackendMinimal`) also works as the first argument; there `model` is optional and, when set, is passed through in each request.

### Graph Inference Engine

```typescript
import { GraphInferenceEngine } from '@cogitator-ai/memory';

const engine = new GraphInferenceEngine(graph); // built-in rules; pass false to start without them

const inferred = await engine.infer('agent-1', { minConfidence: 0.5, maxInferences: 100 });
for (const edge of inferred) {
  console.log(edge.type, edge.sourceNodeId, '->', edge.targetNodeId, 'via rule', edge.ruleId);
}

await engine.materialize(inferred); // store them as edges
```

### Graph Context Builder

```typescript
import { GraphContextBuilder } from '@cogitator-ai/memory';

const contextBuilder = new GraphContextBuilder(graph, embeddingService, {
  maxNodes: 20,
  maxEdges: 50,
  includeInferred: true,
});

const context = await contextBuilder.buildContext('agent-1', 'Tell me about Alice and her work', {
  maxDepth: 2,
  userId: 'user-1', // leave out other users' nodes (metadata.userId)
});

console.log('Relevant nodes:', context.nodes);
console.log('Relationships:', context.edges);
console.log(context.formattedContext); // ready for a system prompt
```

---

## License

MIT
