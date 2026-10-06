---
'@cogitator-ai/rag': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/types': minor
---

Ingesting a source again replaces it instead of duplicating every chunk. Before, `rag_ingest` on the same README or a cron over an edited folder grew the store with each run, stale text kept being found and `topK` filled up with copies, and there was no way to delete a document. `RAGPipeline.ingest()` now deletes the chunks it stored for each loaded source once the new ones are embedded, `removeSource(source)` deletes a source, loaders derive document ids from the source (and row, item or page) and chunkers derive chunk ids from the document and position, so ids stay the same across re-ingests. Embedding stores gain `deleteByFilter()` and a `metadata` search filter (in-memory, Postgres and Qdrant), an optional `EmbeddingAdapter` method that a custom store without it skips with a warning.
