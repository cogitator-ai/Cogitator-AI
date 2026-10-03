---
'@cogitator-ai/deploy': patch
---

The generated `docker-compose.prod.yml` repeated `REDIS_URL`, `DATABASE_URL`, `PORT` or `NODE_ENV` when `env` or `secrets` also set them, which YAML parsers reject or resolve unpredictably. Each variable is now written once: `env` overrides the defaults and the bundled service URLs, and a secret that names a service URL falls back to that URL when unset.
