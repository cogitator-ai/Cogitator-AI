---
'@cogitator-ai/memory': patch
---

PostgresAdapter (getThread, updateThread, getEntries, getEntry, getFacts, updateFact, disconnect), PostgresGraphAdapter and SQLiteGraphAdapter threw on database errors. They now return a failed `MemoryResult` like the rest of the adapter contract, and graph traversal, path finding and node merging report a failed lookup instead of returning partial results.
