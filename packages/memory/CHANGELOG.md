# @cogitator-ai/memory

## 0.12.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.12.1

### Patch Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - - memory: the SQLite adapter and the core facts store create the directory of their database file.
  - channels: the file-tool path guard now comes from `@cogitator-ai/core`.
  - workflows: `functionNode` takes the output type of its function, so `stateMapper` is typed by it.
  - workflows: the file run, approval, checkpoint and dead-letter stores write atomically, so a process killed mid-write leaves the previous state, which `recoverRuns()` picks up, instead of an empty file that lost the run.
  - next: `setThreadId(undefined)` starts a new thread.
- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.12.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Compaction no longer reorders a thread that is written while the summary is produced. Before, the kept entries were deleted and added again after the summary with new timestamps, so a reply saved during summarization (two quick messages on a channel) ended up before its own question in every later turn. The summary is now dated just before the first kept entry and kept entries are left untouched, with their ids. `addEntry` accepts an optional `createdAt` (the new `NewMemoryEntry` type) for this, honoured by every built-in adapter, and compactions of one thread in a process run one after another.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `ContextBuilder` never drops the system prompt anymore. Before, instructions larger than the budget (about 15k characters with the runtime's default 4000 tokens) were silently left out, so the run went to the model without a system prompt and lost `RunOptions.context` and reflection insights with it. The prompt is now always kept and counted, history gets what it leaves, and `BuiltContext.warnings` explains when nothing else fits. In runs, the agent's instructions always come first, `includeSystemPrompt: false` is ignored with a warning, and the warning about an oversized prompt is logged.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A part of the context that fails to load no longer fails the run or vanishes silently. `ContextBuilder.build()` leaves out the history, facts, semantic search, knowledge graph or relevance scoring that failed and lists it in the new `BuiltContext.errors` (`{ source, error }`). Runs pass each of them to `onMemoryError` with the `'load'` operation and log a warning, so an embedding API answering 429 with `includeSemanticContext` no longer fails every run, and a brief database outage no longer makes the agent answer as if the conversation never happened. The runtime also warns at connect when `includeFacts`, `includeSemanticContext` or `includeGraphContext` cannot add anything with the configured memory.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Token counts include tool calls and images. `countMessageTokens` counts the names and JSON arguments of an assistant message's `toolCalls` and estimates images (85 tokens for `detail: 'low'`, 1600 otherwise), and the new `countEntryTokens` recounts stored entries, so `ContextBuilder` keeps to its budget when history holds large tool arguments saved with an old count. `countToolCallsTokens` is exported too.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` checks the vector size of an existing `embeddings` table on `connect()`. An adapter without a configured size adopts it, and one configured for another size (after switching the embedding model) reports the mismatch through `vectorStatus()` and a clear failure from `addEmbedding` and `search` instead of a Postgres error on each search. The size can now be set with `dimensions` in `PostgresAdapterConfig` and `memory.postgres.dimensions`, as well as `setVectorDimensions()`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` connects to Postgres without pgvector. Before, the `CREATE TABLE ... vector(N)` that followed a failed `CREATE EXTENSION` failed `connect()`, so memory was off entirely even for users who only need threads. Threads, entries and facts now work on any Postgres, embedding operations return a failed result naming the reason, and the new `vectorStatus()` tells whether vectors are usable. The runtime does not use such a store for semantic context and logs why.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Ingesting a source again replaces it instead of duplicating every chunk. Before, `rag_ingest` on the same README or a cron over an edited folder grew the store with each run, stale text kept being found and `topK` filled up with copies, and there was no way to delete a document. `RAGPipeline.ingest()` now deletes the chunks it stored for each loaded source once the new ones are embedded, `removeSource(source)` deletes a source, loaders derive document ids from the source (and row, item or page) and chunkers derive chunk ids from the document and position, so ids stay the same across re-ingests. Embedding stores gain `deleteByFilter()` and a `metadata` search filter (in-memory, Postgres and Qdrant), an optional `EmbeddingAdapter` method that a custom store without it skips with a warning.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `SessionManager.list()` no longer comes back empty after a quiet day on Redis. The session index thread was only written when a session was created or deleted, so it expired with the adapter TTL while sessions stayed active, and the next session rebuilt it from itself alone. Using a session now puts it back into the index if needed and rewrites the index at most once per `indexRefreshInterval` (a new option, one minute by default).

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The `relevant` and `hybrid` context strategies embed each history entry once instead of on every turn. Vectors are cached per builder by entry id, and only the newest 200 entries are scored, so a long thread no longer sends its whole history to the embedding API with each message.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A memory adapter that fails to connect no longer keeps the process alive. `RedisAdapter` closed nothing when its first ping failed, so ioredis kept reconnecting and logging `Unhandled error event` after `cogitator.close()`. Redis now closes its client, Postgres ends its pool and SQLite closes its file when `connect()` fails, the runtime disconnects any adapter that failed, and the Redis error names the connection problem (`connect ECONNREFUSED ...`) instead of the retry limit.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - RAG searches only its own documents. Retrievers searched the whole embedding store, so a store shared with agent memory (a Postgres memory store holding message and fact embeddings with `metadata.userId`) could return another user's private memory through `rag_search`. `RAGPipeline.query()` now always searches `sourceType: 'document'`, and the new `namespace` config keeps several pipelines apart in one store (queries, re-ingest and removal stay inside it). `retrieval.filter` and the `filter` query option narrow a search further, every built-in retriever passes the filter on, and `HybridSearch` applies it to its local keyword index too.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `RedisAdapter.getEntries({ limit })` reads only the newest `limit` entries instead of fetching and parsing the whole thread, and still fills the limit from older entries when the newest have expired.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/redis@0.5.2

## 0.11.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 0.11.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 0.11.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 0.11.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/redis@0.5.1
  - @cogitator-ai/types@0.33.1

## 0.11.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 0.11.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 0.11.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 0.11.1

### Patch Changes

- [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7) - Fixes in `MongoDBAdapter`, found by running it against a real MongoDB server for the first time:

  - Fields left `undefined` are no longer stored as `null`. The driver serializes `undefined` as BSON null by default, so an entry saved without tool calls came back with `toolCalls: null`, `toolResults: null` and `metadata: null`, a message without a name came back with `name: null`, and a thread metadata key set to `undefined` was stored as `null`. Every other store leaves those fields out. The adapter now opens its client with `ignoreUndefined`, and entries an earlier version stored with those nulls read back without them, while a tool result that really is `null` stays `null`.
  - A failed `connect()` leaves the adapter disconnected. It kept the half-open client, so the next `connect()` reported success while every call failed with `Not connected`. The failed client is now closed and the next `connect()` tries again, concurrent `connect()` calls share one attempt, and `disconnect()` waits for a pending one.

- [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6) - The SQLite (`SQLiteAdapter`, `SQLiteGraphAdapter`, `CoreFactsStore`) and MongoDB adapters are now type checked against the real `better-sqlite3` and `mongodb` drivers instead of hand-written declarations of them. Those declarations took precedence over the drivers' own types, which is how a Qdrant client method that no longer existed went unnoticed. A driver release that drops or changes a method the adapters call now fails the build instead of failing at runtime. Checking the adapters against `better-sqlite3` 13 and `mongodb` 7 found no mismatch, so behaviour is unchanged.

- [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36) - Fixes in the memory stores, found by running them against real Postgres, Qdrant and OpenRouter:

  - `QdrantAdapter.search()` works again. It called `client.search()`, which `@qdrant/js-client-rest` 1.19 (the version the package asks for) no longer has, so every search failed with `this.client.search is not a function`. It now uses `client.query()`, and deletes wait until Qdrant has applied them, so a search right after a delete no longer finds the deleted points.
  - `PostgresAdapter.addEntry()` stores entries with `toolCalls` or `toolResults`. node-pg sent those arrays as Postgres array literals, and Postgres rejected them with `invalid input syntax for type json`, so every tool exchange of an agent was lost. All `jsonb` columns are now written as JSON text.
  - pgvector search finds every row. `connect()` built an `ivfflat` index on the empty table, and for small limits Postgres used it and missed most rows (`search({ limit: 3 })` returned 0 or 1 of 6 rows). The adapter now builds an HNSW index, which needs no training data, and replaces an existing `ivfflat` index on the first `connect()` after upgrading. On a large table that rebuild takes a while, the adapters docs show how to build the index ahead of the deploy. Searches also raise `hnsw.ef_search` to the requested limit and use iterative scans on pgvector 0.8+, so a limit above 40 or a filter no longer cuts results short, and equally similar rows come back ordered by id. `PostgresGraphAdapter` builds its node embedding index with HNSW too.
  - The `recent` context strategy keeps an unbroken run of the newest messages. It skipped a message that did not fit the budget and kept older ones, so the model could see an answer without the question it answered. It now stops at the first message that does not fit.
  - `createEmbeddingAdapter()` returns a `ConnectableEmbeddingAdapter`, an `EmbeddingAdapter` with `connect()` and `disconnect()`, so the adapter can be connected without a cast.
  - `OpenAIEmbeddingService` sends `dimensions` for gateway model ids such as `openai/text-embedding-3-small` (OpenRouter) and knows their native size. It reported 512 while the gateway returned 1536-dimensional vectors, so vector columns and collections were created with the wrong size. A response whose vectors do not match a configured `dimensions` now throws instead of reaching the store.

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.11.0

### Minor Changes

- a3c2ee1: `CompactionConfig.summaryModel` and `summaryPrompt` were ignored by `CompactionService`. The summarizer now receives them as a second `options` argument (`{ model, prompt }`, type `SummarizeOptions`). The Ollama embedding config schema now keeps `dimensions` and the Google one keeps `baseUrl`, matching the TypeScript types.
- bb17767: `LLMEntityExtractor` now accepts a Cogitator `LLMBackend` directly together with a `model` (`new LLMEntityExtractor(backend, { model })`), so no hand-written adapter is needed. Hand-written `LLMBackendMinimal` adapters keep working and receive the configured `model` when one is set.

### Patch Changes

- e7925d5: `createThread` on an existing thread id in the Postgres and SQLite adapters returned the current time as `createdAt`. It now returns the stored thread, so `createdAt` keeps the original creation time.
- e7925d5: PostgresAdapter (getThread, updateThread, getEntries, getEntry, getFacts, updateFact, disconnect), PostgresGraphAdapter and SQLiteGraphAdapter threw on database errors. They now return a failed `MemoryResult` like the rest of the adapter contract, and graph traversal, path finding and node merging report a failed lookup instead of returning partial results.
- 4a2925f: QdrantAdapter stored points under `emb_<id>` ids, which a real Qdrant server rejects because point ids must be unsigned integers or UUIDs. Each embedding is now stored under a deterministic UUID derived from its id, the public `emb_` id is kept in the payload and returned from search, and `deleteEmbedding` removes the matching point.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [7083ee5]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/redis@0.5.0

## 0.10.0

### Minor Changes

- 333e4ad: `unwrap(result)` turns a `MemoryResult` into its data, or throws an `Error` with the adapter's message when the call failed: `const thread = unwrap(await memory.createThread('agent-1'))`.

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.9.1

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.9.0

### Minor Changes

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.8.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.8.0

### Minor Changes

- Optional dependencies move to ioredis 6, mongodb 7 and better-sqlite3 13; peer ranges keep the previous majors.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/redis@0.4.0
  - @cogitator-ai/types@0.24.0

## 0.7.0

### Minor Changes

- createThread on an existing id wiped history in the in-memory adapter and failed in SQLite and MongoDB; it is now a non-destructive upsert everywhere. Entries saved in the same millisecond now keep insertion order, using per-thread strictly increasing timestamps plus rowid ordering in SQLite. Cross-agent leakage is fixed: ContextBuilder no longer injects embeddings scoped to other agents, and the in-memory, Postgres and Qdrant embedding stores now filter consistently by metadata.agentId and metadata.threadId. The 'relevant' strategy, which used to throw 'not implemented', now works. Hybrid no longer wastes 30% of the budget and keeps chronological order. Compaction puts the summary before the kept messages and includes tool calls. SessionManager.list() works without userId through an index thread, delete() updates the index, and compact() delegates to an optional CompactionService. Redis adapter: cluster hash-tag prefix, TTL refresh on the thread key, stale index pruning, and errors returned as results. Postgres search returns failures instead of throwing, and MongoDB gets a compound index. CoreFactsStore writes are transactional, embedding fetch retries network errors and honours Retry-After, and graph LIKE now escapes wildcards. README (including snippets that did not compile) and the memory docs were updated.

  **Breaking changes**
  - createThread with an existing thread id now upserts metadata instead of resetting (in-memory) or failing (SQLite/MongoDB)
  - Semantic context no longer includes embeddings whose metadata.agentId belongs to another agent
  - Qdrant filters use metadata.threadId/metadata.agentId payload keys
  - SessionManager constructor accepts an options object { compaction }; compact() throws without it

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/redis@0.3.0
  - @cogitator-ai/types@0.23.0

## 0.6.22

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.6.21

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.6.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.6.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.6.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.6.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/redis@0.2.24

## 0.6.14

### Patch Changes

- fix(memory): audit — 42 bugs fixed, +122 tests, v0.6.14
  - Fix SQL injection via schema name in Postgres and knowledge graph adapters
  - Fix Qdrant deleteEmbedding (wrong filter), metadata collision, search reconstruction
  - Fix Postgres keywordSearch params corruption, getEntries limit subquery, ILIKE injection
  - Fix Redis zrangebyscore exclusive bounds inconsistency
  - Fix BM25 duplicate query term scoring
  - Fix context builder facts/semantic context dropped without system prompt
  - Fix knowledge graph traversal paths, bidirectional edge support, merge self-references
  - Fix embedding services: add dimensions config to Google/OpenAI API requests
  - Add missing Zod schemas (SQLite, MongoDB, Qdrant configs)
  - Add EmbeddingProvider 'google' to types, OpenAIEmbeddingConfig dimensions field
  - Add createEmbeddingAdapter factory, export missing adapter config types
  - Fix dependencies: add missing optional/peer deps, move @types to devDeps
  - Add SQLite PRAGMA foreign_keys enforcement
  - Remove dead code (indexedIds, unused schema types)
  - Add 122 new tests (BM25, RRF, schema validation)

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/redis@0.2.23

## 0.6.13

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/redis@0.2.22

## 0.6.11

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/redis@0.2.20

## 0.6.10

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/redis@0.2.19

## 0.6.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/redis@0.2.18

## 0.6.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/redis@0.2.17

## 0.6.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/redis@0.2.16

## 0.6.6

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/redis@0.2.15

## 0.6.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/redis@0.2.14

## 0.6.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/redis@0.2.13

## 0.6.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/redis@0.2.12

## 0.6.2

### Patch Changes

- docs: sync package READMEs with main documentation

## 0.6.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/redis@0.2.11

## 0.6.0

### Minor Changes

- feat(memory): implement hybrid search with BM25 + vector fusion

  Add comprehensive hybrid search capability combining keyword search (BM25) with semantic vector search using Reciprocal Rank Fusion (RRF):
  - BM25Index class with inverted index for fast keyword search
  - Tokenizer with stopword filtering and text normalization
  - RRF algorithm for combining ranked results from different sources
  - HybridSearch class with three search strategies: vector, keyword, hybrid
  - PostgreSQL adapter extended with tsvector/tsquery full-text search
  - InMemoryEmbeddingAdapter for testing without database dependency
  - New types: SearchStrategy, SearchOptions, SearchResult, HybridSearchConfig

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/redis@0.2.10

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/redis@0.2.9

## 0.5.1

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/redis@0.2.8

## 0.5.0

### Minor Changes

- Phase 5: Memory adapters and observability integrations

  Memory Adapters:
  - SQLite adapter with WAL mode for zero-config local development
  - MongoDB adapter for flexible document storage
  - Qdrant vector adapter for semantic similarity search

  Observability:
  - Langfuse exporter for LLM-native observability
  - OpenTelemetry OTLP exporter for universal tracing

  All adapters use dynamic imports - install only what you need.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/redis@0.2.7

## 0.4.3

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/redis@0.2.6

## 0.4.2

### Patch Changes

- 218d91f: feat: add vision / multi-modal support

  Message content now supports images in addition to text:
  - `MessageContent` = `string | ContentPart[]`
  - `ContentPart` can be `text`, `image_url`, or `image_base64`

  All LLM backends updated to handle multi-modal content:
  - **OpenAI**: `image_url` parts with detail level support
  - **Anthropic**: `image` source with URL or base64
  - **Google Gemini**: `inlineData` and `fileData` parts
  - **Ollama**: `images` array with base64 data

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/redis@0.2.5

## 0.4.1

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/redis@0.2.4

## 0.4.0

### Minor Changes

- f874e69: ### Memory improvements
  - Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
  - Add Google embedding service using `text-embedding-004` model (768 dimensions)
  - Implement hybrid context strategy (30% semantic + 70% recent messages)
  - Fix foreign key constraint violation when saving entries before thread creation

  ### Swarms improvements
  - Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
  - Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
  - Fix coordinator to properly register pipeline stages and handle missing negotiation section

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/redis@0.2.3

## 0.3.1

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/redis@0.2.2

## 0.3.0

### Minor Changes

- feat: add Knowledge Graph Memory and Prompt Auto-Optimization

  **Knowledge Graph Memory:**
  - PostgresGraphAdapter for entity-relationship storage with pgvector
  - Multi-hop graph traversal with BFS/DFS algorithms
  - Shortest path finding between nodes
  - Semantic node search with embeddings
  - LLMEntityExtractor for extracting entities/relations from text
  - GraphInferenceEngine for rule-based relationship inference
  - GraphContextBuilder for graph-aware context building

  **Prompt Auto-Optimization:**
  - PostgresTraceStore for persistent trace and prompt storage
  - PromptLogger wrapper for capturing all LLM prompts
  - ABTestingFramework with Welch's t-test statistical analysis
  - PromptMonitor for real-time performance monitoring with degradation detection
  - RollbackManager for instruction version control
  - AutoOptimizer for automated optimization pipeline with A/B testing

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/redis@0.2.1

## 0.2.0

### Minor Changes

- Add Redis adapter tests (connect, cluster mode, thread/entry CRUD)
- Add Postgres adapter tests (thread/entry/fact/embedding operations)
- Add embedding service tests (OpenAI, Ollama, factory)
- Fix context builder strategies: `relevant` and `hybrid` now throw explicit errors (not yet implemented)

### Breaking Changes

- Context builder `relevant` and `hybrid` strategies now throw errors instead of silently using `recent` strategy

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/redis@0.1.1
