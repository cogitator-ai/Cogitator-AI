# @cogitator-ai/memory

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
