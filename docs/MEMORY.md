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

Adapter methods do not throw for expected failures; they return `MemoryResult<T>` (`{ success: true, data }` or `{ success: false, error }`). Database errors are reported the same way, including in `PostgresAdapter` and the `PostgresGraphAdapter` / `SQLiteGraphAdapter` graph adapters. Check `result.success`, or use `unwrap()` to get the data and throw on failure:

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

Redis-backed storage, with an optional TTL. Supports standalone and cluster mode via `@cogitator-ai/redis`.

```typescript
import { RedisAdapter } from '@cogitator-ai/memory';

const standalone = new RedisAdapter({
  provider: 'redis',
  url: 'redis://localhost:6379',
  ttl: 86400, // optional, default 0: nothing expires
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

Implements `MemoryAdapter + MemoryItemAdapter + MemoryFileAdapter + FactAdapter + EmbeddingAdapter + KeywordSearchAdapter`. Schema version 3 moves every row of `facts` into a memory item of its own slot `fact:<id>` on the first `connect()` after upgrading and renames the table `facts_legacy`. Schema version 4 adds the table of memory file versions (`memory_file_versions`) and moves nothing.

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
| `cogitator.embeddings` | Vector embeddings (HNSW + GIN index)     |

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

Qdrant only accepts unsigned integers and UUIDs as point ids, so each point is stored under a deterministic UUID derived from the embedding id; the `emb_…` id stays in `payload.embeddingId` and is what `search` returns and `deleteEmbedding` takes.

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
  // Optional, in every built-in adapter: what the entry said becomes '[redacted]', its place stays
  redactEntry?(
    entryId: string,
    redaction: EntryRedaction
  ): Promise<MemoryResult<MemoryEntry | null>>;

  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}
```

Calling `createThread` with an existing `threadId` is an upsert in every adapter: stored entries and `createdAt` are kept, only the metadata is updated.

`redactEntry(entryId, { at, reason? })` replaces the text of a `message` or `tool_result` entry, the arguments of its tool calls and the results of its tools with `[redacted]` (`REDACTED_TEXT`), keeps its place in the thread, its role and the ids that tie tool calls to their results, and records `metadata.redacted` (`{ at, reason? }`). It gives `null` for a missing entry and refuses an event entry, such as a compaction, which is deleted instead. Change listeners hear `{ type: 'entry-redacted', entryId, threadId }`, and the message index drops the entry's vectors. An adapter of your own builds the redacted entry with `redactedEntry(entry, redaction)` from `@cogitator-ai/memory`.

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

For an SQLite-backed fact store with history, see `CoreFactsStore`. Both keep their facts as [memory items](#memory-items): `PostgresAdapter` each fact in its own slot `fact:<id>` (`updateFact` with new content supersedes the current item and keeps the old statement as history, `deleteFact` deletes the fact with its history, a fact without evidence comes back without `evidence`), and `CoreFactsStore` each key in the slot `core:<key>` of `system` items in its `scope` (`{ agentId: 'core' }` by default). Setting the value a key holds changes nothing, `delete` lets the current value go and keeps the history, and the old `core_facts` and `core_facts_history` tables are moved into items on `initialize()` and renamed with a `_legacy` suffix.

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
  maxTokens: 128_000, // optional: this build's budget, e.g. the model's context window
});

// context.messages — ready to send to LLM
// context.tokenCount — tokens used
// context.truncated — whether history was cut
// context.dropped: entries, facts, semanticResults and graphNodes left out, with tokenCount
// context.facts — facts sent with the turn (see memoryContext)
// context.semanticResults — embeddings included
// context.graphContext — graph nodes/edges, when includeGraphContext is on
```

The budget is shared among partitions. `system`, `pinned`, `index`, `summaries`, `brief` and `final` (the input) are required and fitted first, `facts` (15%) and `recall` (35%, semantic results and graph context) split what they leave by their shares, and `recent` takes the rest. What a partition does not need goes to those that need more, and the shares of the partitions that are not required add up to 1 at most. The system message holds the system prompt, what is pinned and the memory index. Facts, recall and the brief change every turn, so they come last as one user message in a `<memory_context>` block (`context.memoryContext`), which a Cogitator run sends together with the input, adding its `context` and reflection insights to it. The history before them carries prompt cache breakpoints at its end and at the end of the turn before.

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
  maxTokens?: number; // without it, build() needs options.maxTokens
  reserveTokens?: number; // default: 10% of the budget (min 100)
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

The runtime builds its thread store from `memory.adapter` and the section of the same name: `'memory'`, `'redis'` (requires `redis.url`, `redis.host`/`redis.port` or `redis.cluster`), `'postgres'` (requires `postgres.connectionString`), `'sqlite'` (requires `sqlite.path`) or `'mongodb'` (requires `mongodb.uri`). A missing required setting or a failed connection logs a warning and leaves memory off for that run; the next run tries again. An adapter you connect yourself can be assigned with `cog.memory = adapter` (such runs load the last 20 entries, since the context builder is only created from the `memory` config).

`'qdrant'` is not a thread store (it only logs a warning): Qdrant holds embeddings. Keep a thread store as `adapter` and add `memory.qdrant` with `memory.embedding` and `memory.contextBuilder`; the context builder then searches the Qdrant collection for semantic context (`includeSemanticContext: true`). The runtime does not write embeddings to it — add them with your own `QdrantAdapter`. A `qdrant.dimensions` that differs from the embedding model's is logged.

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
    ttl?: number; // seconds after the last write, default 0 (no expiry)
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

  contextBuilder?: Partial<ContextBuilderConfig>; // maxTokens defaults to what the run's model has room for, strategy to 'recent'

  compaction?: MemoryCompactionConfig; // compaction of a run's thread after the run

  extraction?: {
    model?: string; // default: the model the run ended on
    prompt?: string; // added to the extraction prompt
    windowTokens?: number; // default 4000
    activationConfidence?: number; // default 0.7
    scope?: 'user' | 'agent' | 'thread'; // default 'user'
    timeZone?: string; // IANA, when the thread names no metadata.timeZone, default UTC
    afterExtract?: (items: MemoryItem[]) => void | Promise<void>;
  };

  files?: { scope?: 'user' | 'agent' | 'thread'; readOnly?: boolean; indexChars?: number }; // the memory tool

  brief?: {
    model?: string; // default: the model of the run
    maxCards?: number; // 1 to 4, default 4
    timeoutMs?: number; // default 4000
    maxTokens?: number; // default 600
    prompt?: string;
  };

  observations?: {
    model?: string; // default: the model the run ended on, the agent's for a pass on demand
    maxEntities?: number; // observations one refresh writes, default 3
    minItems?: number; // facts an entity needs, default 3
    prompt?: string;
  };

  consolidation?: {
    model?: string; // default: the model the run ended on, the agent's for a pass on demand
    everyRuns?: number; // runs of a thread between passes, default 20
    afterCompaction?: boolean; // default true
    maxChanges?: number; // items one pass marks as stale, default 10
    maxSubjects?: number; // subjects one pass asks about, default 10
    playbook?: 'apply' | 'shadow' | false; // default 'apply'
    showPlaybook?: boolean; // default true
    prompt?: string;
    afterConsolidate?: (report: MemoryConsolidationReport) => void | Promise<void>;
  };
}
```

With `contextBuilder` set and no `maxTokens`, each run's history budget is the context window of the model the run starts on (from the model registry, else the model family, else 8192 tokens, and at most 4096 on Ollama, which serves no more by default, except Ollama Cloud), minus room for the answer (the agent's `maxTokens`, else 15% of the window, at most half of it), the tool schemas and the input, and below the point where `context` compression would start when it is on. The builder keeps `reserveTokens` of it free as slack. Set `maxTokens` to cap the history and the cost of long threads, or to use a larger context your Ollama server runs with. With `contextBuilder` set, a Postgres store is also used as the fact adapter, and as the embedding adapter unless `memory.qdrant` is set. The runtime creates the Postgres `embeddings` table with the vector size of `memory.embedding` (768 without one). Without `contextBuilder`, a run loads the last 20 entries of the thread.

---

## Memory Files and Agent Memory Tools

With `memory.files` in the Cogitator config, every agent gets the `memory` tool: notes under `/memories` it views and changes across conversations with the commands of Anthropic's memory tool (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`), sent as Anthropic's own `memory_20250818` to Claude 4 and later and as a tool with the same commands to every other model. The files a run sees are listed with its turn. `MemoryFiles` keeps every change as a version in the run's store (`MemoryFileAdapter`, in every built-in adapter, checked by `memoryFileAdapterConformanceCases`): a run sees the files of its user, its thread and the agent, in its own thread only the versions of its branch, and an edit of a file another writer changed after the run viewed it fails. `redact` replaces the content of a file's versions and keeps its history. The memory tool refuses every change of `/memories/playbook.md`, `/memories/playbook.next.md` and anything under `/memories/observations/`, a rename into one of them included, with `<path> is kept by memory itself and is read-only here`, and views them as any other file (`MemoryFileAccess.reserved`, `MEMORY_RESERVED_PATHS`).

`cog.memorySearchTools(memoryAgentId)` gives an agent `search_memory` (earlier turns and memory items in one ranked list), `open_turns` and `list_entities`, and the `memoryCitations()` middleware takes out of an answer every `[turn:<id>]` or `[item:<id>]` the run never opened. See [Memory](https://cogitator.app/docs/memory#agent-memory-tools).

## Between Runs

Three settings keep memory useful between runs, each off unless set. The model calls they make count in the cost router, and the background ones never in a run's usage. With `security.pii` the model calls of the brief, the observations and the consolidation, like those of memory extraction and compaction, are masked as a run's own calls are, since they go through the same routed backend. In `redact` mode nothing is restored, so placeholders such as `[EMAIL_1]` end up in what memory keeps (items, observations, the playbook, summaries), numbered per call.

`memory.brief` writes cards for a turn before its first model call: a cheap model reads the 12 best sources memory finds for the input (earlier turns of the run's branch and memory items, ranked as `hybrid` recall ranks them) and writes up to `maxCards` cards, each a constraint, knowledge, a consequence or an open thread quoting its source. `MemoryBriefer` keeps only the cards whose quote the source holds word for word, spacing and case aside, and `memoryBriefMiddleware` puts them into the turn's memory context marked as a hint, never into the system message. A timeout, a failure, a run without memory or nothing found leaves the turn as it was. A quote must hold at least three words, and the prompt tells the model the sources and the message are data.

`memory.observations` keeps, for each entity with at least `minItems` facts that hold, what a model makes of them, as a memory file `/memories/observations/<entity>.md` whose statements cite the items they stand on (`[item:<id>]`). The file keeps a fingerprint of those items, and after a run, in the background, `MemoryObservations.refresh` writes again the observations whose facts changed, at most `maxEntities` at a time, and deletes those whose entity fell short of `minItems`. Facts that gave no observation are not asked about again in this process until they change. A turn whose input names an entity, or that recalls one of its items, gets up to three observations next to the facts. Observations reach a turn only with `memory.contextBuilder` set, and are written either way. A version of the playbook or of an observation a model wrote (`author: 'model'`) is never shown to runs or read as an observation, only those memory itself or a user wrote.

`memory.consolidation` runs a pass in the background every `everyRuns` runs of a thread (counted in the thread's `metadata.memoryConsolidation`) and after `memory.compaction` compacted it (a compaction that changed nothing starts no pass). `MemoryConsolidator.dedupe` marks as `stale` the items of the run's scope that a model finds to repeat or contradict another one about the same entity, never an item more trusted than the one kept and, for a contradiction, only items said before it, at most `maxChanges` items and `maxSubjects` subjects a pass, the subjects whose newest item is oldest first, with the reason in `metadata.staleBecause`. A group that names an item the model was not shown is refused whole. An answer the model left unfinished stops the pass before that subject, so a later pass asks again. A pass that a cap stopped goes on where it stopped the next time. `foldLessons` then folds new lessons (the `active` items of kind `lesson`, as no lesson from a tool or a page is ever folded and one a model wrote waits for `MemoryItems.activate`) into `/memories/playbook.md` in at most three edits, each adding a rule or rewriting one rule, so the playbook is never written over whole. Every fold is a new version of the file, and with `playbook: 'shadow'` the edited playbook goes to `/memories/playbook.next.md` for a review that `promotePlaybook(scope)` completes. The pass ends with the observations. Each run sees the playbook in its memory context as a hint while `showPlaybook` is on. `showPlaybook` alone decides whether runs see the playbook: `playbook: false` only stops new lessons from reaching it, and an existing playbook is still shown. A playbook every user of the agent shares (a scope without a user, project or thread, as with `memory.extraction.scope: 'agent'`) takes only `system` lessons in `apply` mode, since one user's lesson would reach every other user, and `shadow` drafts the rest for review. Lessons are ordered and folded by when they were activated (`MemoryItems.activate` keeps `metadata.activatedAt`), else by when they were recorded, so a lesson activated after a fold is still folded. A fold builds on the newest version of the playbook memory or a person wrote, skipping one a model wrote, and `promotePlaybook` refuses a draft a model wrote.

Passes run one at a time per memory scope and never hold a run back, and `close()` stops the passes under way. `cog.consolidateMemory(agent, { userId?, threadId?, since? })` runs a pass now, such as from a worker while the agent is idle, and returns a `MemoryConsolidationReport` (`scope`, `observations`, `observationsDeleted`, `stale`, `playbook` as `{ path, editCount, lessonIds }`, `dedupe` as `{ complete, through? }`). When `report.dedupe.complete` is false a cap stopped the look for repeats, and calling again with `since: report.dedupe.through` goes on from there. With the `user` extraction scope (the default) it needs a `userId`, or a `threadId` for the memory of runs without a user, with `thread` a `threadId` (even with a `userId`), and with `agent` nothing. It throws `VALIDATION_ERROR` when neither `memory.consolidation` nor `memory.observations` is set, or when memory keeps no memory items. A pass on demand asks `consolidation.model` for repeats and lessons and `observations.model` for observations, each falling back to the agent's model (`llm.defaultModel` when the agent has none), while a pass after a run falls back to the model the run ended on. See [Memory](https://cogitator.app/docs/memory#between-runs).

## Memory Items

A memory item (`MemoryItem` in `@cogitator-ai/types`) is one thing a conversation established, kept apart from the conversation: its `kind` (`fact`, `event`, `preference`, `instruction`, `opinion`, `lesson`), its `content`, and for a state that can change its `subject`, `attribute` and `value`. It keeps its `status` (`suggested`, `active`, `stale`, `superseded`), its `trust` (`user`, `system`, `model`, `tool`, `web`), its `confidence`, its `scope` (`agentId`, optional `userId`, `projectId`, `threadId`), its `evidence` and whether every quote holds (`verified`), when it was said (`saidAt`, `sessionAt`), the time it is about (`about`), and bitemporal times: `validFrom`/`validTo` in the world, `recordedAt`/`expiredAt` in memory.

Every built-in conversation adapter implements `MemoryItemAdapter` (`putItem`, `getItem`, `findItems`, `deleteItems`, `putEntity`, `findEntities`, `deleteEntities`): InMemory in process, SQLite in `memory_items`, `memory_entities` and `memory_entity_names`, Postgres in `memory_items` and `memory_entities`, Redis as hashes with their indexes (never under the thread `ttl`), MongoDB in `<prefix>items` and `<prefix>entities`. `memoryItemAdapterConformanceCases` in `@cogitator-ai/test-utils` checks a store of your own.

`MemoryItems` keeps every rule on top of a store:

- Writing only adds, and one agent's writes go one after another within a process, items of one millisecond recorded a millisecond apart. An item said again (same scope and kind, open and not let go, same normalized words, or in a slot the same value) merges into the newest such item no other value followed since, else it is a new state. On a merge the trust and `verified` come together from the better source (the more trusted one first, then the one whose quotes hold), so a `system` item stays `system` and a user's unverified claim stays the user's but `suggested`. Values of a slot compare by text (`sameValue`): spacing aside, case and signs count. `findItems` filters by scope in the store (`visibleTo`: what a scope sees, `scope`: exactly that scope), on columns `user_id`, `project_id` and `thread_id` in SQLite and Postgres and top-level fields in MongoDB.
- `subject` is linked to an entity the writer's scope sees (`link`: its own or a broader one, such as the user's for a thread, made in the scope when there is none, no aliases added, duplicates of racing writers settled on the first made), and with an `attribute` the item gets a slot. After every write of a state, the `active` and `superseded` items of its slot and exact scope are laid out by time (settle): each closed (`superseded`, `validTo`, `supersededBy`) when the next one starts, the last one open. Racing writers, a state told late (it fits between the ones around it) and a failed close converge, a state set to start later leaves the current one in place until it starts, and a state let go keeps its place, so the one before does not come back. `expire` and `purge` reopen nothing.
- An item becomes `active` on its own from `system`, or from `user` with quotes that hold at `activationConfidence` (default 0.7). Everything else stays `suggested` until `activate(id)`. An opinion gains 0.1 when said again by a statement with quotes that hold, and loses 0.2 when a less trusted source contradicts it.
- `visibleIn(item, scope)`: the same agent, and each of user, project and thread the same or not set on the item.
- `query({ scope, kinds?, statuses?, slots?, entityIds?, asOf?, knownAt?, includeClosed?, text?, limit? })` (statuses `active` and `superseded` by default, the state that holds read from `validFrom`/`validTo`, `asOf` defaulting to `knownAt` and `knownAt` to now, recording time filtered only by an explicit `knownAt`), `history(scope, slot)`, `markStale`, `expire` (kept, found only by an earlier `knownAt`, an item whose `expiredAt` is still ahead found until then, a state let go keeping its place in the timeline), `purge` (deleted for good).

`resolveTime(expression, sessionAt, timeZone?)` turns time words a model marked up (`date`, `relative`, `weekday`) into an interval in a time zone, `end` exclusive, with its precision (`approximate` when nothing can be placed). `MemoryExtractor` reads entries in windows (`windowTokens`, default 4000), one model call each with `EXTRACTION_PROMPT`, the session date (`sessionLine`) and each message's date in the transcript, asked again up to three tries in all only when the answer holds no JSON array (a `null` or blank field is read as absent, an item that does not fit is dropped), checks every quote against its entry, gives each item the trust of the least trusted entry a holding quote is in (`parseExtraction`, `trustOfEntry(entry, userId)`, another user's message counting as `model`) and resolves its dates from the first message it quotes (its `saidAt` and `sessionAt`), and writes the items through `MemoryItems`. With `memory.extraction` a Cogitator runs it after every run (the built-in middleware `cogitator:memory-extraction`, items under the agent's configured id, else its name (`memoryAgentId`), for the run's own user, cursor in thread `metadata.memoryExtraction` kept after every window, runs of one thread one after another, a window left out only after the model could not answer it three extractions in a row, a cursor on an abandoned branch replaced by the run's branch point, a failed first extraction storing where it started so the next one takes those entries, a run without a user keeping its items in the thread's scope, a thread `metadata.timeZone` that is not an IANA zone falling back to the configured one), and with `contextBuilder.includeFacts` the context's facts are the items the run sees that hold now, one state per slot (the one that started last, the narrowest scope on a tie), instructions and preferences first, newest first, a replaced value as `(previously: X)` only when the run sees it and memory did not let it go.

## Forgetting, Redacting and Rewinding

Everything memory derives from a conversation keeps the entries it stands on (`evidence`, a compaction's `firstKeptEntryId` and atoms, a memory file version's `place`). Deleting, redacting or rewinding entries follows that lineage into every store, so nothing a user asked to be forgotten stays behind in a fact, a summary or a playbook rule:

```typescript
await cog.forget({ entryIds: [entry.id] }, { agents: [assistant] }); // the entry and what stands on it
await cog.forget({ threadId: 'chat' }, { agents: [assistant] }); // the thread
await cog.forget({ userId: 'ana' }, { agents: [assistant] }); // every thread and everything kept for the user
await cog.redactEntries([entry.id], { agents: [assistant], reason: 'the user asked' }); // its place stays
await cog.rewind('chat', earlier.id, { agents: [assistant] }); // items of the turns after it go stale
```

| What stands on the entries                 | Deleted or redacted entries                                                                                                                                                                   | Rewind                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Replies to a user message                  | Go with it (its descendants on every branch up to the next user message, events among them), unless `keepReplies`                                                                             | Stay, on the branch left                                         |
| Compaction summaries                       | Deleted when they cover one (before `firstKeptEntryId` on their branch) or quote one in an atom, the next compaction writes them again                                                        | Stay, seen on their own branch                                   |
| Memory items, facts, graph nodes and edges | Purged when they stand only on them, the others lose the quotes of them                                                                                                                       | Items standing only on the turns after the target become `stale` |
| Vectors                                    | Deleted with the entries, summaries and facts that go                                                                                                                                         | Stay                                                             |
| Memory file versions                       | Redacted when written at one of them                                                                                                                                                          | Stay, seen on their own branch                                   |
| Observations and the playbook              | Every version naming a purged item or lesson redacted, the playbook in front first written again without those rules, an observation written again over its redacted file by the next refresh | Stay                                                             |

`forget({ threadId })` also purges the items and entities and redacts the memory file versions kept for that thread alone. `forget({ userId })` deletes every thread whose `metadata.userId` is the user (a run with a `userId` sets it), purges every item and entity and redacts every memory file version of the user's scope, deletes the facts and graph nodes and edges whose `metadata.userId` is the user, and the embeddings with that metadata, through `deleteByFilter` where the store has it. `redactEntries` deletes a compaction entry among the ids, as it cannot be redacted, and throws `VALIDATION_ERROR` when the adapter has no `redactEntry`. A rewind deletes nothing: the turns after `toEntryId` stay on a branch of their own, and the items that stood only on them are marked `stale` with `staleBecause: { reason: 'rewound', threadId, toEntryId, at }`, so later runs no longer take them for what holds. A rewind marks the items stale before it moves the thread, so one that failed can be made again, and a thread that stands at `toEntryId` already is left as it is.

Items, files, facts and the graph are kept by the memory id of an agent. Every run names its agent in the thread's `metadata.memoryAgentIds`, and a cascade goes through the memory of the agents a thread names and of the thread's owner (for `forget({ userId })`, of every thread of the user). `agents` (agents or their memory ids) adds others, and is needed for a thread written before threads named their agents and for a user without threads: without it such a call throws `VALIDATION_ERROR`. `graph` is a knowledge graph of your own to go through too, and `keepReplies: true` leaves the replies to a user message alone. Each call returns a `MemoryCascadeReport`: `entries` (`deleted`, `redacted`), `threads`, `summaries`, `items` (`purged`, `trimmed`, `stale`), `entities`, `facts` (`deleted`, `trimmed`), `graph` (`nodes`, `edges`, `trimmed`), `fileVersions` and `playbookRules`. Memory extraction and compaction after a run stop before their next model call once the run's branch is no longer the active one, such as after a rewind while they work, so nothing is learned or summarized from a branch the conversation left, and extraction drops the items whose entries were forgotten or redacted while the model answered.

`MemoryCascade` from `@cogitator-ai/memory` does the same over stores of your own:

```typescript
import { MemoryCascade } from '@cogitator-ai/memory';

const cascade = new MemoryCascade({
  memory,
  items: memory,
  files: memory,
  graph,
  facts,
  embeddings,
});
const who = { agentIds: ['assistant'] };

await cascade.deleteEntries([entry.id], who);
await cascade.redactEntries([entry.id], { at: new Date(), reason: 'erasure request' }, who);
await cascade.deleteThread('chat', who);
await cascade.deleteUser('ana', who);
await cascade.rewind('chat', earlier.id, who);
```

`MemoryItems.reviseEvidence(itemIds, keep)` keeps of each item's evidence the pieces `keep` takes and returns the ids of the items it changed, which is how an item that stands on more than what went loses only those quotes.

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
    embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
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

`memory.embedding` also takes an `EmbeddingService` of your own (`embed`, `embedBatch`, `model`, `dimensions`), used as it is: a provider without a built-in service, or a cache in front of one. It is passed to `new Cogitator()` in code, `cogitator.yml` and `defineConfig()` take only provider configs.

- A run with a `threadId` loads and saves its history; per run, `useMemory: false` disables memory, `loadHistory: false` / `saveHistory: false` skip loading or saving, and `onMemoryError` is called when a load or save fails.
- `await cog.getMemory()` connects and returns the adapter before any run (`undefined` when memory is not configured or could not connect); `cog.memory` returns it once connected, and assigning `cog.memory = adapter` plugs in an adapter you created yourself.
- Pass `userId` in run options to scope threads, facts and embeddings per user — see [Multiple Users](https://cogitator.app/docs/advanced/multi-user).
