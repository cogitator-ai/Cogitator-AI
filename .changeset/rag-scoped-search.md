---
'@cogitator-ai/rag': minor
'@cogitator-ai/memory': patch
'@cogitator-ai/types': minor
---

RAG searches only its own documents. Retrievers searched the whole embedding store, so a store shared with agent memory (a Postgres memory store holding message and fact embeddings with `metadata.userId`) could return another user's private memory through `rag_search`. `RAGPipeline.query()` now always searches `sourceType: 'document'`, and the new `namespace` config keeps several pipelines apart in one store (queries, re-ingest and removal stay inside it). `retrieval.filter` and the `filter` query option narrow a search further, every built-in retriever passes the filter on, and `HybridSearch` applies it to its local keyword index too.
