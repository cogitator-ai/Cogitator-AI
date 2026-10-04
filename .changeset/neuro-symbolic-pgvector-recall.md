---
'@cogitator-ai/neuro-symbolic': patch
---

`PostgresGraphAdapter.searchNodesSemantic()` finds every matching node. `connect()` built an `ivfflat` index on the still empty `graph_nodes` table, and once Postgres used it, searches missed nodes (a search for 60 nodes in a graph of 3000 returned 31, and with the index forced a search for 10 returned none). The adapter now builds an HNSW index, which needs no training data, and replaces an existing `ivfflat` index on the first `connect()` after upgrading. On a large graph that rebuild takes a while, the README shows how to build the index ahead of the deploy. Searches also raise `hnsw.ef_search` to the requested limit and use iterative scans on pgvector 0.8+, so a limit above 40 or an `entityTypes` filter no longer cuts results short, and equally similar nodes come back ordered by id. A failed search now returns a failed result instead of throwing.
