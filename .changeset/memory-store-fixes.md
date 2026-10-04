---
'@cogitator-ai/memory': patch
---

Fixes in the memory stores, found by running them against real Postgres, Qdrant and OpenRouter:

- `QdrantAdapter.search()` works again. It called `client.search()`, which `@qdrant/js-client-rest` 1.19 (the version the package asks for) no longer has, so every search failed with `this.client.search is not a function`. It now uses `client.query()`, and deletes wait until Qdrant has applied them, so a search right after a delete no longer finds the deleted points.
- `PostgresAdapter.addEntry()` stores entries with `toolCalls` or `toolResults`. node-pg sent those arrays as Postgres array literals, and Postgres rejected them with `invalid input syntax for type json`, so every tool exchange of an agent was lost. All `jsonb` columns are now written as JSON text.
- pgvector search finds every row. `connect()` built an `ivfflat` index on the empty table, and for small limits Postgres used it and missed most rows (`search({ limit: 3 })` returned 0 or 1 of 6 rows). The adapter now builds an HNSW index, which needs no training data, and replaces an existing `ivfflat` index on the first `connect()` after upgrading. On a large table that rebuild takes a while, the adapters docs show how to build the index ahead of the deploy. Searches also raise `hnsw.ef_search` to the requested limit and use iterative scans on pgvector 0.8+, so a limit above 40 or a filter no longer cuts results short, and equally similar rows come back ordered by id. `PostgresGraphAdapter` builds its node embedding index with HNSW too.
- The `recent` context strategy keeps an unbroken run of the newest messages. It skipped a message that did not fit the budget and kept older ones, so the model could see an answer without the question it answered. It now stops at the first message that does not fit.
- `createEmbeddingAdapter()` returns a `ConnectableEmbeddingAdapter`, an `EmbeddingAdapter` with `connect()` and `disconnect()`, so the adapter can be connected without a cast.
- `OpenAIEmbeddingService` sends `dimensions` for gateway model ids such as `openai/text-embedding-3-small` (OpenRouter) and knows their native size. It reported 512 while the gateway returned 1536-dimensional vectors, so vector columns and collections were created with the wrong size. A response whose vectors do not match a configured `dimensions` now throws instead of reaching the store.
