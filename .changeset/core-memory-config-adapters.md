---
'@cogitator-ai/core': patch
---

Config-driven memory now builds every store `memory.adapter` names: `sqlite` (from `memory.sqlite.path`), `mongodb` (from `memory.mongodb.uri`) and `redis` from `host`/`port` or `cluster` as well as `url`. `memory.qdrant` becomes the embedding store that `memory.contextBuilder` searches, and `adapter: 'qdrant'` explains that Qdrant does not store threads instead of logging "Unknown memory provider". A Postgres store gets the vector size of the `memory.embedding` model instead of always `vector(768)`.
