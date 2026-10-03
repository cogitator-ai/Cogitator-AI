---
'@cogitator-ai/redis': minor
---

The client from `createRedisClient()` can now be passed to core's tool cache (`withCache({ storage: 'redis', redisClient })`): it gains `exists`, `incr`, `decr` and an ioredis-style `scan(cursor, 'MATCH', pattern, 'COUNT', count)`, and `zrange` takes a string `stop` such as `'-1'`. Like `keys()`, `scan` works relative to `keyPrefix` and walks every master node in cluster mode.
