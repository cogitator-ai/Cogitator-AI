# @cogitator-ai/memory

Memory adapters for Cogitator AI agents. Supports in-memory, Redis (short-term), and PostgreSQL with pgvector (long-term semantic memory).

## Installation

```bash
pnpm add @cogitator-ai/memory

# Optional peer dependencies
pnpm add ioredis  # For Redis adapter
pnpm add pg       # For PostgreSQL adapter
```

## Features

- **Multiple Adapters** - In-memory, Redis, PostgreSQL with pgvector
- **Thread Management** - Create, update, delete conversation threads
- **Token Counting** - Estimate token usage without tiktoken dependency
- **Context Builder** - Build token-aware conversation context
- **Embedding Services** - OpenAI and Ollama embedding integration
- **Semantic Search** - Vector similarity search with pgvector
- **Hybrid Search** - BM25 + Vector with Reciprocal Rank Fusion
- **Facts Storage** - Store and retrieve agent knowledge
- **Knowledge Graph** - Entity-relationship memory with multi-hop traversal
- **Zod Schemas** - Type-safe configuration validation

---

## Quick Start

```typescript
import { InMemoryAdapter, ContextBuilder } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();

const threadResult = await memory.createThread('agent-1', { topic: 'greeting' });
const thread = threadResult.data!;

await memory.addEntry({
  threadId: thread.id,
  message: { role: 'user', content: 'Hello!' },
});

await memory.addEntry({
  threadId: thread.id,
  message: { role: 'assistant', content: 'Hi there!' },
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

---

## Memory Adapters

### In-Memory Adapter

Fast, non-persistent storage for development and testing.

```typescript
import { InMemoryAdapter } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter({
  maxEntries: 1000,
});

await memory.connect();
```

### Redis Adapter

Persistent short-term memory with TTL support.

```typescript
import { RedisAdapter } from '@cogitator-ai/memory';

const memory = new RedisAdapter({
  url: 'redis://localhost:6379',
  keyPrefix: 'cogitator:',
  ttl: 3600,
});

await memory.connect();
```

### PostgreSQL Adapter

Long-term storage with vector search via pgvector.

```typescript
import { PostgresAdapter } from '@cogitator-ai/memory';

const memory = new PostgresAdapter({
  connectionString: 'postgresql://localhost:5432/cogitator',
  schema: 'public',
  poolSize: 10,
});

await memory.connect();
```

### SQLite Adapter

```typescript
import { SQLiteAdapter } from '@cogitator-ai/memory';

const memory = new SQLiteAdapter({
  provider: 'sqlite',
  path: './cogitator.db',
  walMode: true,
});
```

### MongoDB Adapter

```typescript
import { MongoDBAdapter } from '@cogitator-ai/memory';

const memory = new MongoDBAdapter({
  provider: 'mongodb',
  uri: 'mongodb://localhost:27017',
  database: 'cogitator',
});
```

### Qdrant Adapter (Embedding)

```typescript
import { QdrantAdapter } from '@cogitator-ai/memory';

const embeddings = new QdrantAdapter({
  provider: 'qdrant',
  url: 'http://localhost:6333',
  collection: 'cogitator',
  dimensions: 1536,
});
```

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
```

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

```typescript
const result = await memory.createThread('agent-1', {
  topic: 'support',
  user: 'user-123',
});
const thread = result.data!;

const threadResult = await memory.getThread(thread.id);

await memory.updateThread(thread.id, {
  resolved: true,
});

await memory.deleteThread(thread.id);
```

### Entry Operations

```typescript
const entry = await memory.addEntry({
  threadId: thread.id,
  message: { role: 'user', content: 'Hello' },
  tokenCount: 10,
});

const entries = await memory.getEntries({
  threadId: thread.id,
  limit: 50,
  includeToolCalls: true,
});

const single = await memory.getEntry(entry.data!.id);

await memory.deleteEntry(entry.data!.id);

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
}
```

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

### Built Context

```typescript
interface BuiltContext {
  messages: Message[];
  facts: Fact[];
  semanticResults: (Embedding & { score: number })[];
  tokenCount: number;
  truncated: boolean;
  metadata: {
    originalMessageCount: number;
    includedMessageCount: number;
    factsIncluded: number;
    semanticResultsIncluded: number;
  };
}
```

---

## Token Counting

Simple token estimation without tiktoken dependency.

```typescript
import {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
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

---

## Embedding Services

### OpenAI Embeddings

```typescript
import { OpenAIEmbeddingService, createEmbeddingService } from '@cogitator-ai/memory';

const embeddings = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',
});

const embeddings = createEmbeddingService({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

const vector = await embeddings.embed('Hello, world!');

const vectors = await embeddings.embedBatch(['Hello', 'World']);
```

### Ollama Embeddings

```typescript
import { OllamaEmbeddingService, createEmbeddingService } from '@cogitator-ai/memory';

const embeddings = new OllamaEmbeddingService({
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:11434',
});

const embeddings = createEmbeddingService({
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

const embeddings = createEmbeddingService({
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
hybridResults.data.forEach((result) => {
  console.log(`${result.content} — score: ${result.score}`);
  console.log(`  vector: ${result.vectorScore}, keyword: ${result.keywordScore}`);
});
```

### Document Indexing

For keyword search, documents must be indexed:

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
import { InMemoryAdapter } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();

const thread = await memory.createThread('chatbot');

const messages = [
  { role: 'user' as const, content: 'What is AI?' },
  { role: 'assistant' as const, content: 'AI is artificial intelligence...' },
  { role: 'user' as const, content: 'Tell me more' },
];

for (const msg of messages) {
  await memory.addEntry({
    threadId: thread.data!.id,
    message: msg,
  });
}

const history = await memory.getEntries({
  threadId: thread.data!.id,
  limit: 10,
});
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
import { PostgresAdapter, OpenAIEmbeddingService } from '@cogitator-ai/memory';

const memory = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL!,
});

const embeddings = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
});

await memory.connect();

const content = 'Machine learning is a subset of AI...';
const vector = await embeddings.embed(content);
```

---

## Knowledge Graph

Entity-relationship memory with multi-hop traversal and semantic reasoning.

### PostgresGraphAdapter

```typescript
import { PostgresGraphAdapter } from '@cogitator-ai/memory';

const graph = new PostgresGraphAdapter({
  connectionString: process.env.DATABASE_URL!,
});

await graph.connect();

const person = await graph.addNode({
  agentId: 'agent-1',
  type: 'person',
  name: 'Alice',
  description: 'Software engineer',
  properties: { role: 'developer' },
  confidence: 1.0,
  source: 'user',
});

const company = await graph.addNode({
  agentId: 'agent-1',
  type: 'organization',
  name: 'TechCorp',
  confidence: 1.0,
  source: 'extracted',
});

await graph.addEdge({
  agentId: 'agent-1',
  sourceNodeId: person.id,
  targetNodeId: company.id,
  type: 'works_at',
  weight: 1.0,
  confidence: 0.95,
  source: 'extracted',
});
```

### Multi-hop Traversal

```typescript
const result = await graph.traverse({
  startNodeId: person.id,
  maxDepth: 3,
  direction: 'outgoing',
  edgeTypes: ['works_at', 'knows', 'located_in'],
});

console.log('Visited nodes:', result.visitedNodes);
console.log('Paths found:', result.paths);
```

### Shortest Path

```typescript
const path = await graph.findShortestPath(startNodeId, endNodeId);
if (path) {
  console.log('Path:', path.nodes.map((n) => n.name).join(' -> '));
  console.log('Total weight:', path.totalWeight);
}
```

### Semantic Node Search

```typescript
const similar = await graph.searchNodesSemantic({
  agentId: 'agent-1',
  query: 'machine learning engineer',
  limit: 10,
  threshold: 0.7,
});
```

### LLM Entity Extraction

```typescript
import { LLMEntityExtractor } from '@cogitator-ai/memory';

const extractor = new LLMEntityExtractor(llmBackend, {
  minConfidence: 0.7,
  maxEntitiesPerText: 20,
});

const result = await extractor.extract(
  'Alice works at TechCorp in San Francisco. She knows Bob from the AI conference.'
);

console.log('Entities:', result.entities);
console.log('Relations:', result.relations);
```

### Graph Inference Engine

```typescript
import { GraphInferenceEngine } from '@cogitator-ai/memory';

const engine = new GraphInferenceEngine(graph, {
  minConfidence: 0.5,
  maxInferredEdges: 100,
});

const inferred = await engine.infer('agent-1');
console.log('Inferred edges:', inferred.edges);
console.log('Rules applied:', inferred.rulesApplied);
```

### Graph Context Builder

```typescript
import { GraphContextBuilder } from '@cogitator-ai/memory';

const contextBuilder = new GraphContextBuilder(graph, embeddingService, {
  maxNodes: 20,
  maxEdges: 50,
  includeInferred: true,
});

const context = await contextBuilder.buildContext({
  agentId: 'agent-1',
  query: 'Tell me about Alice and her work',
});

console.log('Relevant nodes:', context.nodes);
console.log('Relationships:', context.edges);
```

---

## License

MIT
