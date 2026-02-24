# Memory System

> Pluggable memory adapters with semantic search, facts, and knowledge graph support

## Overview

The `@cogitator-ai/memory` package provides conversation persistence for agents. It separates storage backends (adapters) from context assembly (`ContextBuilder`) so you can swap adapters without changing agent code.

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
        MemoryAdapter    FactAdapter       EmbeddingAdapter  GraphAdapter
              │               │                    │              │
     ┌────────┼────────┐      │                    │              │
     ▼        ▼        ▼      │                    │              │
  InMemory  Redis  Postgres───┴────────────────────┘       PostgresGraph
              SQLite
              MongoDB
              Qdrant
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

// Standalone
const adapter = new RedisAdapter({
  provider: 'redis',
  url: 'redis://localhost:6379',
  ttl: 86400, // 24 hours
  keyPrefix: 'cogitator:',
});

// Cluster
const adapter = new RedisAdapter({
  provider: 'redis',
  cluster: {
    nodes: [
      { host: 'redis-1', port: 6379 },
      { host: 'redis-2', port: 6379 },
    ],
  },
});

await adapter.connect();
```

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

Vector dimensions default to 768 (nomic-embed-text). Override with `adapter.setVectorDimensions(1536)` before connecting.

### SQLiteAdapter

File-based storage. Ideal for local development and single-server deployments.

```typescript
import { SQLiteAdapter } from '@cogitator-ai/memory';

const adapter = new SQLiteAdapter({
  provider: 'sqlite',
  path: './data/memory.db',
  walMode: true, // default, better concurrency
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

Optimized for vector search workloads.

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

Long-term knowledge storage — user preferences, learned facts, domain knowledge.

```typescript
interface FactAdapter {
  addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>>;
  getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>>;
  updateFact(factId: string, updates: Partial<...>): Promise<MemoryResult<Fact>>;
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

### EmbeddingAdapter (Postgres only)

pgvector-backed semantic search.

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
  };
}
```

---

## Context Building

`ContextBuilder` assembles messages for the LLM from stored history while respecting token limits.

```typescript
import { ContextBuilder } from '@cogitator-ai/memory';

const builder = new ContextBuilder(
  {
    maxTokens: 128_000,
    reserveTokens: 4000, // headroom for output
    strategy: 'hybrid', // 'recent' | 'hybrid' (| 'relevant' — not yet implemented)
    includeSystemPrompt: true,
    includeFacts: true, // requires FactAdapter
    includeSemanticContext: true, // requires EmbeddingAdapter + EmbeddingService
  },
  {
    memoryAdapter: adapter,
    factAdapter: postgresAdapter, // optional
    embeddingAdapter: postgresAdapter, // optional
    embeddingService: embeddingService, // optional
  }
);

const context = await builder.build({
  threadId: 'thread_abc123',
  agentId: 'agent_xyz',
  systemPrompt: 'You are a helpful assistant.',
  currentInput: 'What did we discuss yesterday?', // used for semantic retrieval
});

// context.messages — ready to send to LLM
// context.tokenCount — tokens used
// context.truncated — whether history was cut
// context.facts — facts included in system prompt
// context.semanticResults — embeddings included
```

### Strategies

| Strategy   | Behavior                                                                      |
| ---------- | ----------------------------------------------------------------------------- |
| `recent`   | Most recent entries first, fills token budget                                 |
| `hybrid`   | Semantically relevant older entries + recent entries (30/70 split by default) |
| `relevant` | Not yet implemented — throws on use                                           |

### ContextBuilderConfig

```typescript
interface ContextBuilderConfig {
  maxTokens: number;
  reserveTokens?: number; // default: 10% of maxTokens
  strategy: ContextStrategy;
  includeSystemPrompt?: boolean; // default: true
  includeFacts?: boolean; // default: false
  includeSemanticContext?: boolean; // default: false
  includeGraphContext?: boolean; // default: false
  graphContextOptions?: { maxNodes?: number; maxDepth?: number };
}
```

---

## Embedding Services

```typescript
import {
  OpenAIEmbeddingService,
  OllamaEmbeddingService,
  GoogleEmbeddingService,
  createEmbeddingService,
} from '@cogitator-ai/memory';

// Factory
const service = createEmbeddingService({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // optional
});

// Or Ollama
const service = createEmbeddingService({
  provider: 'ollama',
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:11434', // optional
});

// Or Google
const service = createEmbeddingService({
  provider: 'google',
  apiKey: process.env.GOOGLE_API_KEY!,
  model: 'text-embedding-004', // optional
});

const vector = await service.embed('hello world');
const vectors = await service.embedBatch(['text1', 'text2']);
console.log(service.dimensions); // 1536 for OpenAI, 768 for nomic, etc.
```

---

## Hybrid Search

BM25 keyword search + vector search fused with Reciprocal Rank Fusion.

```typescript
import { HybridSearch, type HybridSearchConfig } from '@cogitator-ai/memory';

const search = new HybridSearch({
  embeddingAdapter: postgresAdapter,
  embeddingService: embeddingService,
  keywordAdapter: postgresAdapter, // PostgresAdapter implements KeywordSearchAdapter
  defaultWeights: { bm25: 0.3, vector: 0.7 },
});

const results = await search.search({
  query: 'user preferences about dark mode',
  strategy: 'hybrid', // 'vector' | 'keyword' | 'hybrid'
  limit: 10,
  threshold: 0.5,
});
// results: SearchResult[] with score, vectorScore, keywordScore
```

---

## Configuration (via CogitatorConfig)

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

  embedding?: {
    provider: 'openai' | 'ollama' | 'google';
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };

  contextBuilder?: {
    maxTokens?: number;
    reserveTokens?: number;
    strategy?: 'recent' | 'hybrid';
    includeFacts?: boolean;
    includeSemanticContext?: boolean;
  };
}
```

---

## Knowledge Graph (Advanced)

Postgres-backed entity–relationship graph with LLM-assisted extraction and inference rules.

```typescript
import {
  PostgresGraphAdapter,
  LLMEntityExtractor,
  GraphInferenceEngine,
  GraphContextBuilder,
} from '@cogitator-ai/memory';

// Store and query entities and relationships
const graph = new PostgresGraphAdapter({
  connectionString: 'postgres://localhost/cogitator',
});
await graph.connect();

// Add nodes and edges
const node = await graph.addNode({
  type: 'person',
  label: 'Alice',
  source: 'user',
  properties: { role: 'engineer' },
});

await graph.addEdge({
  fromId: alice.id,
  toId: project.id,
  type: 'works_on',
  properties: {},
});

// Semantic graph search
const results = await graph.semanticSearch({
  query: 'engineers working on ML projects',
  vector: await embeddingService.embed('engineers ML projects'),
  limit: 10,
});

// Build graph-enriched context
const gctx = new GraphContextBuilder(graph, { maxNodes: 20, maxDepth: 2 });
const graphContext = await gctx.buildContext({
  agentId: 'agent_123',
  query: 'who works on what projects?',
  embeddingService,
});
```

---

## Usage with Cogitator

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: { defaultModel: 'openai/gpt-4o' },
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
    contextBuilder: { strategy: 'hybrid', includeSemanticContext: true },
  },
});

const agent = new Agent({ name: 'assistant', instructions: 'You are helpful.' });

// Pass threadId to persist conversation
const result = await cog.run(agent, {
  input: 'Hello!',
  threadId: 'thread_user_123',
  useMemory: true,
  saveHistory: true,
});
```
