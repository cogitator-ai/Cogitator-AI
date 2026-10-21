# @cogitator-ai/memory

Memory adapters for Cogitator AI agents. Supports in-memory, Redis (short-term), PostgreSQL with pgvector, SQLite and MongoDB (persistent), plus in-memory/pgvector/Qdrant embedding stores for semantic memory.

## Installation

```bash
pnpm add @cogitator-ai/memory

# Install the driver of the store you use (optional peer dependencies)
pnpm add ioredis  # For Redis adapter
pnpm add pg       # For PostgreSQL adapter and graph adapter
pnpm add better-sqlite3  # For SQLite adapter, SQLite graph adapter and CoreFactsStore
pnpm add mongodb  # For MongoDB adapter
pnpm add @qdrant/js-client-rest  # For Qdrant embedding adapter
```

Database drivers are not installed with the package (nor with `@cogitator-ai/core`): add the one your adapter needs. An adapter whose driver is missing fails `connect()` with the command to install it. The in-memory adapters need no driver.

With `@cogitator-ai/core` you usually configure memory on the runtime (`new Cogitator({ memory: { adapter: 'postgres', postgres: { ... } } })`) and read it with `await cog.getMemory()`; the adapters below are for direct use. Website docs: [Memory](https://cogitator.app/docs/memory), [Adapters](https://cogitator.app/docs/memory/adapters), [Embeddings](https://cogitator.app/docs/memory/embeddings), [Hybrid Search](https://cogitator.app/docs/memory/hybrid-search), [Knowledge Graphs](https://cogitator.app/docs/memory/knowledge-graphs).

## Features

- **Multiple Adapters** - In-memory, Redis (standalone + cluster), PostgreSQL with pgvector, SQLite, MongoDB, Qdrant
- **Thread Management** - Create (idempotent upsert), update, delete conversation threads
- **Stable Ordering** - Entries keep insertion order even when saved within the same millisecond
- **Threads as Trees** - Entries branch from any point, with typed session events, paged branch reads, rewind, checkout and thread forks
- **Lineage** - Check that derived facts and summaries quote what the conversation actually said
- **Token Counting** - Estimate token usage without tiktoken dependency
- **Context Builder** - Token-aware context with `recent`, `relevant` (embedding-ranked) and `hybrid` (recent history plus recall of older turns and memory items by a multi-channel search) strategies
- **Scoped Semantic Memory** - Embeddings tagged with `metadata.agentId` / `metadata.threadId` never leak to other agents
- **Sessions & Compaction** - `SessionManager` for channel sessions, `CompactionService` for summarizing long histories, hierarchically into grounded atoms that a compaction never loses while they are open
- **Embedding Services** - OpenAI, Ollama and Google embedding integration
- **Semantic Search** - Vector similarity search with pgvector
- **Hybrid Search** - BM25 + Vector with Reciprocal Rank Fusion
- **Memory Items** - What conversations established, extracted by a model, grounded in quotes, trusted by who said them, kept with when they held (a newer state supersedes the old one and keeps it as history), on every built-in adapter
- **Facts Storage** - Store and retrieve agent knowledge (`FactAdapter` on PostgreSQL, `CoreFactsStore` on SQLite, both kept as memory items)
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

`maxEntries` (default 10000) counts each thread on its own. A full thread drops the oldest entry of a branch that is not active first, then the oldest of the active branch.

### Redis Adapter

Threads and entries in Redis. Nothing expires by default (`ttl: 0`), earlier versions expired keys after 24 hours, so pass `ttl: 86400` to keep that. With a `ttl`, every write refreshes the TTL of the thread and its entry index, so active conversations do not expire mid-way, and expired entries are pruned from the index on read. `getEntries({ limit })` reads only the newest `limit` entries. A failed `connect()` closes its client again, so an unreachable Redis does not keep the process alive.

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

On `connect()` the adapter creates its tables and an HNSW cosine index on the embeddings, which works from the first row on (no training data needed). An `ivfflat` index left by an earlier version is replaced on the first connect after upgrading, see the [adapters docs](https://cogitator.app/docs/memory/adapters) for building the new index ahead of time on a large table. `search()` raises `hnsw.ef_search` to the requested limit and, on pgvector 0.8+, uses iterative scans, so large limits and filters still get every matching row. Vectors of 2001 to 4000 dimensions are indexed as `halfvec` (pgvector 0.7+), larger ones are searched without an index. The schema version is kept in `<schema>.cogitator_schema_migrations`, so a `connect()` changes tables only after an upgrade. Version 3 moves every row of `facts` into a memory item of its own slot and renames the table `facts_legacy`. Messages, tool calls, tool results and metadata are stored as `jsonb`.

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
  listThreads(options?: ListThreadsOptions): Promise<MemoryResult<ThreadPage>>;

  addEntry(entry: NewMemoryEntry): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;

  getPath?(options: PathQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  rewind?(threadId: string, toEntryId: string): Promise<MemoryResult<Thread>>;
  checkout?(threadId: string, entryId: string): Promise<MemoryResult<Thread>>;
  forkThread?(
    threadId: string,
    atEntryId: string,
    newThreadId?: string
  ): Promise<MemoryResult<Thread>>;
}
```

The branch methods are optional on the interface, every built-in adapter implements them.

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

`listThreads` pages through threads, the most recently updated first, filtered by agent, metadata values (compared by type) and update time. Pass `nextCursor` back for the next page:

```typescript
const page = unwrap(
  await memory.listThreads({ agentId: 'agent-1', metadata: { user: 'user-123' }, limit: 20 })
);
const next = page.nextCursor
  ? unwrap(await memory.listThreads({ agentId: 'agent-1', cursor: page.nextCursor }))
  : undefined;
```

A thread's `updatedAt` changes when it is created or its metadata is updated. Every adapter keeps the same contract: `addEntry` into a missing thread fails, `updateThread` is atomic, entries with one `createdAt` keep the order they were added in, fields never set come back absent rather than `null`, and returned objects are copies. `memoryAdapterConformanceCases` in `@cogitator-ai/test-utils` checks it, also for adapters of your own.

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
    limit: 50, // the most recent 50, oldest first, 0 for all
    includeToolCalls: true,
    // before / after: Date bounds
  })
);

const single = unwrap(await memory.getEntry(entry.id));

await memory.deleteEntry(entry.id);

await memory.clearThread(thread.id);
```

`getEntries` reads every branch of the thread and returns only `message` and `tool_result` entries unless `types` asks for more (`types: 'all'`). `deleteEntry` splices the entry out of its branch: its children go after its parent.

### Threads as Trees

A thread's entries form a tree: each entry has a `parentId` (`null` for the first one), a `seq` and a `type`, and the thread's `activeLeafId` names the entry its active branch ends at. `addEntry` goes after the active leaf and moves it there in one step. An explicit `parentId` writes on another branch, and `activate: false` leaves the leaf where it is:

```typescript
const question = unwrap(
  await memory.addEntry({
    threadId: thread.id,
    message: { role: 'user', content: 'Plan a day in Rome' },
    tokenCount: 6,
  })
);
await memory.addEntry({
  threadId: thread.id,
  message: { role: 'assistant', content: 'Start at the Colosseum...' },
  tokenCount: 6,
});
const retry = unwrap(
  await memory.addEntry({
    threadId: thread.id,
    parentId: question.id,
    activate: false,
    message: { role: 'assistant', content: 'Start at the Vatican...' },
    tokenCount: 6,
  })
);

const active = unwrap(await memory.getPath({ threadId: thread.id })); // question, Colosseum
const other = unwrap(await memory.getPath({ threadId: thread.id, leafId: retry.id })); // question, Vatican

await memory.rewind(thread.id, question.id); // the active leaf goes back, nothing is deleted
await memory.checkout(thread.id, retry.id); // any branch becomes the active one
const copy = unwrap(await memory.forkThread(thread.id, retry.id, 'rome-vatican'));
```

- `getPath({ threadId, leafId?, limit?, before?, types?, includeToolCalls? })` reads one branch oldest first, the newest `limit` entries of it, and pages back with `before`, without reading the rest of the thread.
- Entry types: `message`, `tool_result`, and the session events `model_change`, `compaction`, `approval`, `interrupt`, `label` and `custom`, which carry an `event` payload and are never sent to a model as they are (the summary of a `compaction` stands in for the entries it covers). Reads return events only when `types` asks for them.
- `forkThread` copies the branch up to an entry into a new thread, each copy naming its original in `metadata.forkOf`, the new thread its origin in `metadata.forkedFrom`.
- `ContextBuilder` builds from the active branch, `build({ leafId })` from another one.

Entries written before trees are chained in the order they were added the first time a store meets them: Postgres moves its schema to version 2 on `connect()`, SQLite migrates by `PRAGMA user_version`, Redis and MongoDB chain a thread the first time it is read or written. Upgrade every process that shares a store together, as an older process appends entries without a parent.

### Lineage

`Fact`, `GraphNode`, `GraphEdge` and `Insight` take an optional `evidence: Evidence[]` (`{ entryId?, toolCallId?, fileRange?, quote }`, from `@cogitator-ai/types`) that says what they stand on, word for word:

```typescript
import { evidenceOnPath, verifyEvidence, verifyEvidenceInMemory } from '@cogitator-ai/memory';

const rome = { entryId: question.id, quote: 'a day in Rome' };
const evidence = [rome];

verifyEvidence(rome, question); // 'verified': the quote is in the entry, whitespace aside
const checked = unwrap(await verifyEvidenceInMemory(memory, evidence)); // { status, evidence }
const onBranch = evidenceOnPath(evidence, new Set(active.map((entry) => entry.id))); // true
```

A quote that is not found, evidence of an entry that is gone and evidence without an `entryId` are `'suggested'`. Every built-in fact and graph adapter stores `evidence`, takes it in updates, and `mergeNodes` keeps the evidence of the merged nodes.

---

## Context Builder

Build token-aware conversation context from memory.

### Configuration

```typescript
interface ContextBuilderConfig {
  maxTokens?: number; // without it, build() takes maxTokens from its options
  reserveTokens?: number; // default 10% of the budget (at least 100)
  strategy: 'recent' | 'relevant' | 'hybrid';
  includeSystemPrompt?: boolean;
  includeFacts?: boolean;
  includeSemanticContext?: boolean;
  includeGraphContext?: boolean;
  graphContextOptions?: GraphContextOptions;
  partitions?: Partial<Record<ContextPartition, ContextPartitionBudget>>; // merged over the defaults
  timeZone?: string; // IANA zone of recalled dates and of the time a turn names, default UTC
}
```

Strategies:

- `recent` - the newest messages that fit into the token budget, as one unbroken run back from the newest: a tool result too large for the room left stays as a short note in its place and the run goes on past it, any other message that does not fit ends the run, so a reply never appears without the message it answers
- `relevant` - messages ranked by embedding similarity to `currentInput` (requires `embeddingService`; falls back to `recent` without input), returned in chronological order
- `hybrid` - keeps the newest messages as history, like `recent`, and recalls older turns and memory items a search of memory finds into the turn's memory context (needs `currentInput`, searches without vectors when there is no `embeddingService`)

The system prompt is always kept and counted: the rest of the context gets what it leaves of `maxTokens - reserveTokens`, and a prompt larger than that is still sent whole, with a note in `warnings`. Entries are counted by their text, tool call arguments and images rather than only by their saved `tokenCount`. Without a `messageIndex`, `relevant` scores the newest 200 entries (`hybrid` the newest 200 older than the history it keeps) and embeds each entry once per builder (vectors are cached by entry id). Give the builder a `messageIndex` to keep those vectors in an embedding store instead: each entry is embedded once, in the background, and older entries of the thread are found by a search of the store, so recall reaches the whole thread. That is one embedding per message, plus one of the input per turn. `vectorsKept` bounds an index in process to about that many vectors, of the threads used lately, re-indexing a dropped thread when a build uses it.

`build()` also takes `asOf`, the moment the turn is read at (now by default): the time a turn names ("yesterday") is resolved from it and memory items are read as of it, to replay a recorded conversation. Its `timeZone` is the thread's IANA zone in place of the builder's.

```typescript
import { MessageIndex } from '@cogitator-ai/memory';

const index = new MessageIndex({ store: postgres, embedding: embeddings });
index.attach(memory); // background embedding of new entries, vectors deleted with their entries

const builder = new ContextBuilder(
  { maxTokens: 8000, strategy: 'relevant' },
  { memoryAdapter: memory, embeddingService: embeddings, messageIndex: index }
);
```

Every built-in adapter reports its changes through `onChange(listener)` (`entry-added`, `entry-deleted`, `thread-cleared`, `thread-deleted`), which is what `attach` listens to, and every built-in embedding store reads vectors by source with `getBySources(ids)`. An adapter of your own reports its changes by extending `ChangeReportingMemoryAdapter` and passing each write's result through `reported()`. Vectors carry `metadata.index: 'messages'` and the thread's `agentId` and `userId`.

### Recall

With `hybrid` the turns older than the history the budget keeps and the memory items the run sees are searched for the turn, and what is found goes into the `recall` partition, best first, under `Earlier in this conversation:` (each turn dated, with the turn next to it that makes it readable) and `From memory:` (each item with the interval it held when it no longer holds). An item the `facts` partition kept is not repeated, and `BuiltContext.recalled` gives `{ entries, items }` as sent.

The search reads the turn without a model: small talk is not searched, and the question is `temporal`, `aggregate`, `update`, `preference` or `general`, which sets the weights of its channels. Turns are found by their vectors (a cosine of 0.45 or more and 0.6 of the best), by BM25 over the thread, by the time the turn names and by the entities of memory it names. Items are found by BM25, by those entities, by the time they are about, by a personalized PageRank walk over the graph of items and entities, and turns through the evidence of the best items. The channels are fused by weighted reciprocal rank, then reranked by the share of the input's words a hit holds, biased a little toward recent turns and toward items sent to a model more often (`timesRetrieved`), and laid out for diversity (MMR). `ContextBuilderDeps.reranker` (any `Reranker`, such as `CohereReranker` from `@cogitator-ai/rag`) reorders the best 30 after that, and one that fails leaves the order as it was, with a `relevance` error.

```typescript
import { ContextBuilder, MemoryItems } from '@cogitator-ai/memory';
import { CohereReranker } from '@cogitator-ai/rag';

const reranker = new CohereReranker({ apiKey: process.env.COHERE_API_KEY! });
const builder = new ContextBuilder(
  { maxTokens: 16_000, strategy: 'hybrid', includeFacts: true, timeZone: 'Europe/Lisbon' },
  {
    memoryAdapter: memory,
    memoryItems: new MemoryItems({ adapter: memory }),
    embeddingService: embeddings,
    messageIndex: index,
    reranker,
  }
);

const context = await builder.build({
  threadId: 'ana-1',
  agentId: 'concierge',
  userId: 'ana',
  currentInput: 'Where did we stay last April?',
  asOf: new Date('2026-10-21T15:00:00Z'),
});
context.recalled; // { entries, items }
```

### Partitions and Message Order

A context is assembled by a `ContextAssembler` from partitions, each with a `share` of the budget it may take, and some `required`:

| Partition   | Holds                                      | Default                  |
| ----------- | ------------------------------------------ | ------------------------ |
| `system`    | the system prompt                          | required, sent whole     |
| `pinned`    | `pinned` texts of `build()`                | required                 |
| `index`     | the `index` text of `build()`              | required                 |
| `summaries` | compaction summaries                       | required                 |
| `brief`     | the `brief` text of `build()`              | required                 |
| `facts`     | facts                                      | 15%                      |
| `recall`    | recall (`hybrid`), search results, graph   | 35% (60% for `hybrid`)   |
| `recent`    | history, selected by the strategy          | what the others leave    |
| `final`     | `currentInput`, counted, not in `messages` | required, always counted |

Required partitions are fitted first. The others split what they leave by their shares, no more than each needs, and what the shares cannot place goes to those still short of room in fill order (`facts`, `recall`, `recent`). The shares of the partitions that are not required may add up to 1 at most, else the constructor throws. A text block that a kept block of a more lasting partition holds in full, word for word (a fact the system prompt states, a search result that repeats a fact), is left out as a `duplicate`.

`messages` is ordered for the prompt cache: one system message (the system prompt, `pinned`, `index`), the compaction summary and the history, whose last message and the last message of the turn before it carry `cacheBreakpoint: true` (`markTurnEnds`), then a user message with what changes every turn (the brief, `Known facts:`, `Relevant context:`, graph context, `Earlier in this conversation:` and `From memory:`) in a `<memory_context>` block, which is also `memoryContext`. A caller that adds the input itself should send `memoryContext` in front of the input as one user message, as a Cogitator run does, which adds its `context` and the insights of reflection to the same block. `formatTurnContext(blocks)` builds that text from texts of your own, `extendTurnContext(text, block)` adds a block to it, and `withoutTurnContext(text)` gives the input back without it.

```typescript
const context = await builder.build({
  threadId: 'thread_123',
  agentId: 'agent-1',
  systemPrompt: 'You are a helpful assistant.',
  pinned: ['The user is on the Pro plan.'],
  brief: 'Current date and time: Wednesday, October 21, 2026, 17:20.',
  currentInput: 'What changed since yesterday?',
});

context.partitions; // tokens per partition, e.g. { system: 9, final: 8, pinned: 9, brief: 15, recent: 2400 }
context.dropped.blocks; // [{ partition: 'recent', reason: 'budget', tokens: 310, sourceId: 'entry_17' }, ...]
```

Every left out block is in `dropped.blocks` with its `partition`, `reason` (`budget`, `duplicate`, `not-selected` for an entry the strategy did not pick, `oversized` for one larger than its partition could hold), `tokens` and `sourceId`. `ContextAssembler`, `DEFAULT_PARTITIONS` and `fitInOrder` are exported for contexts of your own.

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
console.log(context.dropped); // what was left out: entries, facts, semanticResults, graphNodes, tokenCount, blocks
```

### Budget per Build

Leave `maxTokens` out of the config and pass it to `build()` instead, so one builder serves models of different sizes. A Cogitator run does this with the context window of the model it runs on when `memory.contextBuilder.maxTokens` is not set:

```typescript
const builder = new ContextBuilder({ strategy: 'recent' }, { memoryAdapter: memory });

const context = await builder.build({
  threadId: 'thread_123',
  agentId: 'agent-1',
  maxTokens: 128_000, // e.g. the model's context window
});
```

A build without a budget from either side throws. `reserveTokens` defaults to 10% of the budget used (at least 100), and `build()` takes its own `reserveTokens` too. A Cogitator run passes `reserveTokens: 0`, since its budget already leaves room for the answer, and the builder counts the input in the budget.

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
  messages: Message[]; // system message, history (cache breakpoints at its end and the turn before), turn context
  memoryContext?: string; // brief, facts, recall and graph context, sent with the input
  partitions: Partial<Record<ContextPartition, number>>; // tokens per partition, the input included
  facts: Fact[];
  semanticResults: (Embedding & { score: number })[];
  recalled?: { entries: MemoryEntry[]; items: MemoryItem[] }; // what hybrid recalled for the turn
  graphContext?: GraphContext; // with includeGraphContext and a graph adapter
  tokenCount: number; // tokens of the context, without the input
  truncated: boolean; // history entries were left out
  dropped: DroppedContext; // what was left out of the context
  errors?: ContextBuildError[]; // parts that failed to load and were left out
  warnings?: string[]; // budget problems, such as a system prompt over budget
  metadata: {
    originalMessageCount: number;
    includedMessageCount: number;
    factsIncluded: number;
    semanticResultsIncluded: number;
    graphNodesIncluded: number;
    graphEdgesIncluded: number;
  };
}

interface DroppedContext {
  entries: MemoryEntry[]; // history left out, in conversation order (relevant/hybrid: also entries not selected, hybrid: not those recalled)
  facts: Fact[]; // facts visible to the user that did not fit
  semanticResults: (Embedding & { score: number })[]; // search results that did not fit
  graphNodes: GraphNode[]; // graph nodes cut from the graph context
  tokenCount: number; // tokens of everything left out
  blocks: DroppedBlock[]; // every block left out, with its partition and reason
}

interface ContextBuildError {
  source: 'history' | 'facts' | 'semantic' | 'graph' | 'relevance';
  error: Error;
}
```

`build()` does not throw when a part of the context fails to load (an unreachable store, an embedding API answering 429, a vector size mismatch): the part is left out and reported in `errors`. A failed relevance scoring falls back to the `recent` strategy for `relevant`, and to a recall without vectors for `hybrid`.

---

## Sessions and Compaction

`SessionManager` maps channel conversations (user + channel + agent) onto memory threads. `CompactionService` replaces old history with an LLM summary, which a reader of the thread gets before the most recent messages.

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

A thread is compacted once its conversation holds `threshold` tokens or `messageThreshold` entries, whichever comes first (set at least one). On an adapter with branches (every built-in one) nothing is deleted: a `compaction` entry at the end of the active branch names the first kept entry and holds the summary, and `readCompactedHistory(memory, { threadId })` (or `compactedHistory(path)` on a path read with `types: HISTORY_ENTRY_TYPES`) gives the conversation as the summary, the kept entries and everything after them. `ContextBuilder` and the runtime read history this way, other branches and evidence keep the summarized entries, and `getEntries` still returns all of them. An adapter without `getPath` gets the summary dated just before the first kept entry and the summarized entries deleted.

`compact()` requires the `compaction` option, without it use `CompactionService` directly. The summarizer (`SummarizeFn`) is called as `summarize(messages, options)`, where `options` is a `SummarizeOptions` `{ model?, prompt? }` filled from the `summaryModel` / `summaryPrompt` of the compaction config.

### Hierarchical Compaction

`strategy: 'hierarchical'` keeps the summary as a tree of what the conversation established, so it is never summarized again and loses nothing it still needs:

```typescript
await compaction.compact(session.id, {
  strategy: 'hierarchical',
  threshold: 60_000,
  keepRecent: 0,
  keepRecentTokens: 8000, // newest whole turns kept verbatim
  chapterTokens: 4000, // default
  chapterConcurrency: 1, // default
  chaptersPerArc: 4, // default
  arcsPerSaga: 4, // default
});
```

- The entries new since the last compaction, up to the kept tail, are read in chapters of about `chapterTokens` tokens, each opening with the end of the one before, one at a time (`chapterConcurrency` reads more at once). For each the summarizer gets a numbered transcript and `options.prompt` asks for a JSON array of atoms and lists the items still open, which it may close (`summaryPrompt` is added to it), up to three tries.
- A `CompactionAtom` has a `kind` (`fact`, `task`, `decision`, `constraint`, `error`, `file`, `thread`), a `status` (`open`, `closed`), a `text` and `evidence`. Every quote is checked against its entry, and an atom whose quotes do not all hold is not `verified`. Files tool calls worked on, failed tool calls and open task lines (`TODO:`, `- [ ]`) are taken from the entries with no model.
- Chapters beyond `chaptersPerArc` fold into arcs and arcs beyond `arcsPerSaga` into the saga, with no model. An open task, decision, constraint, error or question is closed, or opened again once done, only by an atom whose evidence holds. The saga keeps every open item and the newest 200 facts and files, so the handoff stops growing.
- The summary is written only when it still holds every open item of the one before, else `compact()` throws and the thread stays as it was.
- The whole tree is one `compaction` entry, `event.levels` (`CompactionLevels`: `saga`, `arcs`, `chapters`, each a `CompactionNode` with `from`, `to` and `atoms`), and its message is the handoff: `Open tasks`, `Constraints`, `Decisions`, `Unresolved errors`, `Open questions`, `Files`, `Facts` and `Done`, in the same order every time so it stays in the prompt cache.
- `keepRecentTokens` keeps the newest tokens in whole turns that open with a user message, so a tool call keeps its result. Without it the newest `keepRecent` entries stay.

`chapterAtoms(window, config, { own, open })` returns the checked atoms of one window, told the `open` items it may close. `anthropicCompactionSummarizer({ model })` from `@cogitator-ai/core` is a `SummarizeFn` that has Anthropic's compaction on request write the answer, checked like any other. A Cogitator compacts a run's thread this way after the run with `memory.compaction`, see [Compaction After a Run](https://cogitator.app/docs/memory#compaction-after-a-run).

---

## Memory Items

A memory item is one thing a conversation established: a `fact`, `event`, `preference`, `instruction`, `opinion` or `lesson`, with its quotes, its `trust` (`user`, `system`, `model`, `tool`, `web`), its `scope` (agent, and optionally user, project, thread) and its times. Every built-in adapter stores items (`MemoryItemAdapter`), and `MemoryItems` keeps the rules on top:

```typescript
import { InMemoryAdapter, MemoryItems, MemoryExtractor } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();
const items = new MemoryItems({ adapter: memory });
const scope = { agentId: 'concierge', userId: 'ana' };

const extractor = new MemoryExtractor({ items, summarize }); // summarize: your SummarizeFn
await extractor.extract(entries, { scope, timeZone: 'Europe/Lisbon' });

await items.query({ scope }); // what holds now
await items.query({ scope, asOf: new Date('2026-06-01') }); // what held then
await items.history(scope, slot); // every value of a slot, closed ones included
```

- Writing only adds, and one agent's writes go one after another within a process, recorded at least a millisecond apart. An item said again merges into the newest open one no other value followed since (else it is a new state), the trust and `verified` coming together from the better source: the more trusted one first, then the one whose quotes hold, so a `system` item stays `system` and a user's unverified claim stays the user's but `suggested`. Values of a slot compare by text (`sameValue`): spacing aside, case and signs count. Stores filter items by scope themselves (`MemoryItemFilter.visibleTo` and `scope`). After every write of a state, the `active` and `superseded` items of its slot (`subject`, linked to an entity the scope sees, and `attribute`) and exact scope are laid out by time, each closed (`superseded`, `validTo` set) when the next one starts and the last one open, so racing writers, a state told late and a failed close converge, and a state set to start later leaves the current one in place until it starts. A state let go keeps its place, so the one before does not come back.
- An item becomes `active` on its own only from `system`, or from `user` with quotes that hold at `activationConfidence` (default 0.7). Everything else stays `suggested` and out of every context, so text a model, a tool or a page wrote cannot plant itself. An opinion said again gains 0.1 when the new statement has quotes that hold, and one a less trusted source contradicts loses 0.2.
- Times are bitemporal: `validFrom`/`validTo` in the world, `recordedAt`/`expiredAt` in memory, queried with `asOf` (default `knownAt`) and `knownAt` (default now), by default over `active` and `superseded` items with the state that holds read from the times. `resolveTime(expression, sessionAt, timeZone)` turns time words a model marked up (`date`, `relative`, `weekday`) into an interval, end exclusive, with its precision.
- `MemoryExtractor` reads entries in windows of `windowTokens` (default 4000), one model call each (`EXTRACTION_PROMPT`, each message shown with its date), checks every quote against its entry (`parseExtraction`, which reads a `null` or blank field as absent and drops an item that does not fit) and writes the items through `MemoryItems`. An item's trust is that of the least trusted entry a holding quote is in (`trustOfEntry(entry, userId)`, where another user's message counts as `model`), so what a page, the assistant or another user said is never the user's, and its dates are resolved from the message that said them. A window the model cannot answer throws `ExtractionAnswerError` (`WindowError` from `extract`), and each call asks for up to 8000 tokens (`SummarizeOptions.maxTokens`).
- With `contextBuilder.includeFacts`, the context builder reads the items the run sees that hold now (as of `asOf`) as its facts (`ContextBuilderDeps.memoryItems`), one state per slot (the one that started last, the narrowest scope on a tie), instructions and preferences first, newest first, a replaced value shown as `(previously: X)` when the run still sees it and memory did not let it go. With `hybrid` the items that match the turn are recalled under `From memory:` too.
- `timesRetrieved` and `lastRetrievedAt` count how often and when an item went to a model. `noteRetrieved(itemIds, at?)` counts them, in one step of the store where the adapter has `countRetrieved` (every built-in one does), else read and written back under the agent's lock, and a Cogitator run counts the facts and recalled items it sent once it finishes or pauses, in the background.

A Cogitator extracts items after each run with `memory.extraction`. See [Memory Items](https://cogitator.app/docs/memory#memory-items).

---

## Core Facts

`CoreFactsStore` keeps a small set of key/value facts about the user in SQLite (with history), formatted for a system prompt. Each key is the slot `core:<key>` of `system` memory items in its `scope` (`{ agentId: 'core' }` by default):

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

A new value supersedes the current one, and the same value again changes nothing. `delete(key)` lets the current value go and keeps the history. The `core_facts` and `core_facts_history` tables of an earlier version are moved into memory items on `initialize()` and renamed with a `_legacy` suffix.

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
  DroppedContext,
  BuildContextOptions,
  MemoryConfig,
  CheckedEvidence,
} from '@cogitator-ai/memory';

import type {
  ContextPartition,
  ContextPartitionBudget,
  DroppedReason,
  DroppedBlock,
  MemoryEntryType,
  NewMemoryEntry,
  PathQueryOptions,
  Evidence,
  EvidenceStatus,
} from '@cogitator-ai/types';
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
