---
'@cogitator-ai/deploy': patch
---

The default health check path was `/health`, but the server adapters (Express, Fastify, Hono, Koa) serve it under their default `/cogitator` base path. The Dockerfile `HEALTHCHECK`, the `fly.toml` check and the reported health endpoint now default to `/cogitator/health`; set `health.path` for another base path.
