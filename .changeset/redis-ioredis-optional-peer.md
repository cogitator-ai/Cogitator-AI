---
'@cogitator-ai/redis': patch
---

`ioredis` is now only an optional peer dependency of `@cogitator-ai/redis`, no longer an optional dependency, so installing a package that builds on it (such as `@cogitator-ai/memory`) no longer pulls in a Redis client the app does not use. Apps that talk to Redis install it themselves with `pnpm add ioredis`, as the README already says, and `createRedisClient` throws that install hint when it is missing.
