---
'@cogitator-ai/types': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/core': minor
'@cogitator-ai/rag': minor
'@cogitator-ai/test-utils': minor
'@cogitator-ai/neuro-symbolic': patch
---

Every message and document is embedded once.

- `MessageIndex` keeps a vector per history entry in an embedding store (`sourceType: 'message'`). Attached to an adapter it embeds new user and assistant entries in the background, in batches, and deletes vectors with their entries and threads. `ContextBuilder` takes it as `messageIndex`: `relevant` and `hybrid` then embed only the input, read kept vectors for the newest entries and find older ones of the thread with a search of the store, so recall is no longer limited to the newest 200 entries. The `Cogitator` runtime sets one up for `relevant` and `hybrid` when `memory.embedding` and an embedding store are configured (in process next to the `memory` adapter), and `close()` waits for its work.
- `MemoryAdapter.onChange(listener)` reports `entry-added`, `entry-deleted`, `thread-cleared` and `thread-deleted` once stored. Every built-in adapter implements it.
- `EmbeddingAdapter.getBySources(ids)` reads embeddings with their vectors by source, and `SearchFilter.sourceType` takes a list. Every built-in store implements both. Semantic context now searches only facts and documents.
- RAG: `ingest()` skips a source whose documents, chunking and embedding model did not change, and reports them as `unchanged`. A changed source is written as a new generation before the previous one is deleted, so it is never missing from queries, and its unchanged documents keep their vectors. Chunks stored by earlier versions are replaced once as before.
- Postgres: vectors of 2001 to 4000 dimensions get an HNSW index on their `halfvec` cast (pgvector 0.7+) instead of none, in the memory store and both knowledge graph adapters. The memory schema version is recorded in `<schema>.schema_migrations`, and `connect()` changes tables only when it is older, under an advisory lock. New indexes on `embeddings(source_id)` and `metadata->>'threadId'`. Qdrant gets payload indexes on `sourceId`, `sourceType` and `metadata.threadId`.
- `@cogitator-ai/test-utils`: conformance cases `reports-changes` and `get-by-sources`, and source type lists in `filters`.
