---
'@cogitator-ai/types': patch
'@cogitator-ai/core': patch
---

Tool cache fixes: `onEvict` also fires for entries evicted to make room (`maxSize`), not only for `invalidate()`. `RedisClientLike` now matches ioredis 5 and 6 (`scan(cursor, 'MATCH', pattern, 'COUNT', count)`), so an ioredis client can be passed as `redisClient`. A Redis `keyPrefix` without a trailing colon gets one, so `withCache` keys read `toolcache:entry:…` instead of `toolcacheentry:…`.
