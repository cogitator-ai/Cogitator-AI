---
'@cogitator-ai/core': minor
---

`createToolCacheStorage()` now accepts `onEvict` and passes it to the memory or Redis storage, so evictions of a storage built with it can be observed. A `keyPrefix` (or `generateCacheKey` prefix) that already ends with `:` no longer produces keys with `::`.
