---
'@cogitator-ai/a2a': patch
---

`RedisClientLike.scan` now declares the call `RedisTaskStore` makes (`MATCH` / `COUNT`), so an ioredis client is accepted as is; keys SCAN returns twice are listed once.
