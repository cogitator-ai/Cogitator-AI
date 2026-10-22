---
'@cogitator-ai/types': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/test-utils': minor
---

Memory files read only what stands. `MemoryFileAdapter.findFileHeads` gives the newest version of each scope and path a filter and a branch see, and `MemoryFiles` lists, views and indexes files through it, so a turn no longer reads the whole history of every file. Postgres and SQLite find the heads in SQL, InMemory, MongoDB and Redis in process, and MongoDB now asks only for batches holding a version of a scope the reader sees. A change that finds, once kept, a file of its own under another file or with files under it, which writers in two processes can make at the same time, is taken back, its own versions withdrawn (`withdrawFileVersions`, a new optional store method every built-in adapter has, `MemoryFileVersion.withdrawn`), and refused so the writer tries again. `fileHeads` finds heads in process for a store of your own, and the conformance kit checks `findFileHeads`.
