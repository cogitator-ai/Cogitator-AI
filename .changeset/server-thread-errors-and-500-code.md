---
'@cogitator-ai/express': patch
'@cogitator-ai/fastify': patch
'@cogitator-ai/hono': patch
'@cogitator-ai/koa': patch
---

A failing memory adapter no longer reaches the client through the Express and Fastify thread routes: the error is logged and answered as `500 Internal server error`, as Hono and Koa already did. Every unexpected error, whether caught by a route, a stream or the error handler, now carries the same code, `INTERNAL_ERROR` (routes and streams used `INTERNAL` before).
