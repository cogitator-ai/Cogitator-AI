---
'@cogitator-ai/redis': patch
---

Explicit `host`, `port`, `password` and `db` now win over what `url` says, as they do in `@cogitator-ai/worker`. ioredis lets the url win, so `{ url: 'redis://cache:6379/0', db: 3 }` wrote to database 0 and tenants configured apart shared one keyspace. `createConfigFromEnv` no longer adds a default `localhost` host next to `REDIS_URL`, and `REDIS_PASSWORD` overrides the password in `REDIS_URL`.
