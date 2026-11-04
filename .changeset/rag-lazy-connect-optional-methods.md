---
'create-cogitator-app': patch
---

Forward optional `getBySources()` and `replaceBySource()` methods in `lazilyConnected()` RAG store wrappers. Persistent vector stores generated for Postgres and Qdrant now expose both optional methods after establishing a connection, allowing RAG ingestion to detect unchanged documents and avoid redundant re-embedding.
