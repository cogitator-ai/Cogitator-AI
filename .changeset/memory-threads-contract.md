---
'@cogitator-ai/types': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/test-utils': minor
'@cogitator-ai/redis': minor
---

Memory adapters share one contract, checked by a conformance suite, and threads can be listed.

- `MemoryAdapter.listThreads(options)` pages through threads by update time, filtered by agent, metadata values (compared by type) and update time, with an opaque cursor. Every built-in adapter implements it in the database: Redis keeps an index of threads by update time and adds threads written by earlier versions to it the first time threads are listed. Adapters of your own need to implement it.
- Every adapter now keeps the same contract: `addEntry` into a thread that does not exist fails (InMemory, Redis and MongoDB used to store an orphan entry), `updateThread` is atomic under concurrent calls (SQLite, Redis and MongoDB could lose an update), entries with one `createdAt` come back in the order they were added, a negative or fractional `getEntries` limit fails, `createThread` with an empty id fails, a field that was never set comes back absent instead of `null` (Postgres), and InMemory returns copies instead of the objects it stores.
- `SessionManager.list()` finds sessions with `listThreads` and no longer keeps an index thread. `indexRefreshInterval` is deprecated and ignored.
- `@cogitator-ai/test-utils` ships `memoryAdapterConformanceCases` and `embeddingAdapterConformanceCases`, framework-agnostic suites that check an adapter or embedding store against this contract. `MockMemoryAdapter` implements `listThreads`.
- `RedisClient` gains `eval(script, numKeys, ...args)`, run on prefixed keys.

Upgrading a database that already holds data:

- Postgres builds its new indexes on `threads` (agent and update time, update time alone, a GIN index on `metadata`) when the adapter connects, which blocks writes to `threads` while each one builds. On a large table create them first with `CREATE INDEX CONCURRENTLY` under the same names (`idx_threads_agent_updated`, `idx_threads_updated`, `idx_threads_metadata`) so connecting finds them in place. The new `entries.seq` column is added without rewriting the table: entries written before it keep their order by `createdAt`.
- MongoDB filters on metadata keys that contain a dot with `$getField`, which needs MongoDB 5.0 or later.
- Redis lists threads through an index it fills the first time threads are listed, and again when the index is gone.
