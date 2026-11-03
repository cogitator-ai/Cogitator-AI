---
'@cogitator-ai/test-utils': minor
---

Add a `MockEmbeddingService`: a deterministic `EmbeddingService` whose stable unit vectors come from a hashed bag of words, with configurable `dimensions` and `model`, `setEmbedding(text, vector)` to pin one, `embedBatch` matching `embed` item for item, and call recording (`getCalls`, `getCallsFor`, `reset`).
