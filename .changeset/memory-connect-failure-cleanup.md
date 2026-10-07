---
'@cogitator-ai/memory': patch
'@cogitator-ai/core': patch
---

A memory adapter that fails to connect no longer keeps the process alive. `RedisAdapter` closed nothing when its first ping failed, so ioredis kept reconnecting and logging `Unhandled error event` after `cogitator.close()`. Redis now closes its client, Postgres ends its pool and SQLite closes its file when `connect()` fails, the runtime disconnects any adapter that failed, and the Redis error names the connection problem (`connect ECONNREFUSED ...`) instead of the retry limit.
