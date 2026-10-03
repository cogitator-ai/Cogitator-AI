---
'@cogitator-ai/memory': patch
---

QdrantAdapter stored points under `emb_<id>` ids, which a real Qdrant server rejects because point ids must be unsigned integers or UUIDs. Each embedding is now stored under a deterministic UUID derived from its id, the public `emb_` id is kept in the payload and returned from search, and `deleteEmbedding` removes the matching point.
