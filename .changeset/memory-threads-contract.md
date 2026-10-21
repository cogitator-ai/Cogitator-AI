---
'@cogitator-ai/types': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/test-utils': minor
'@cogitator-ai/redis': minor
---

Memory adapters share one contract, checked by a conformance suite, and threads can be listed.

- `MemoryAdapter.listThreads(options)` pages through threads by update time, filtered by agent, metadata values (compared by type) and update time, with an opaque cursor. Every built-in adapter implements it in the database: Redis keeps an index of threads by update time and adds threads written by earlier versions to it the first time threads are listed. Adapters of your own need to implement it.
- Every adapter now keeps the same contract: `addEntry` into a thread that does not exist fails (InMemory, Redis and MongoDB used to store an orphan entry), `updateThread` is atomic under concurrent calls (SQLite, Redis and MongoDB could lose an update), entries with one `createdAt` come back in the order they were added, a negative or fractional `getEntries` limit fails, a field that was never set comes back absent instead of `null` (Postgres), and InMemory returns copies instead of the objects it stores.
- `SessionManager.list()` finds sessions with `listThreads` and no longer keeps an index thread. `indexRefreshInterval` is deprecated and ignored.
- `@cogitator-ai/test-utils` ships `memoryAdapterConformanceCases` and `embeddingAdapterConformanceCases`, framework-agnostic suites that check an adapter or embedding store against this contract. `MockMemoryAdapter` implements `listThreads`.
- `RedisClient` gains `eval(script, numKeys, ...args)`, run on prefixed keys.
