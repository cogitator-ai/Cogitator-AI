# @cogitator-ai/memory

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
