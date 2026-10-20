---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

`memory.embedding` takes an `EmbeddingService` of your own as well as a provider's config. The runtime uses it as it is for the context builder and the embedding store, so a provider without a built-in service, or a cache in front of one, plugs in without wrapping the runtime. A config with `provider` works as before.
