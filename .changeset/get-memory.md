---
'@cogitator-ai/core': minor
'@cogitator-ai/express': patch
'@cogitator-ai/fastify': patch
'@cogitator-ai/hono': patch
'@cogitator-ai/koa': patch
'@cogitator-ai/tetsu': patch
---

`cog.getMemory()` connects the configured memory adapter on first use, so threads can be read before any agent has run; `cog.memory` stays `undefined` until then. The `/threads` routes of every server adapter use it, so they no longer answer `503 Memory not configured` on a fresh server.
