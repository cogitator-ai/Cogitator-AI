---
'@cogitator-ai/server-shared': patch
'@cogitator-ai/express': patch
'@cogitator-ai/hono': patch
'@cogitator-ai/koa': patch
'@cogitator-ai/fastify': patch
---

Swagger UI calls the right URLs and offers a bearer token when the server checks credentials. The spec's `servers` now defaults to where the routes are mounted (Express `basePath`, the Hono/Koa mount prefix), and with `auth` configured the spec declares `bearerAuth` as an optional requirement (`swagger.auth` overrides it). The Swagger page escapes the title and the embedded spec, so agent names and descriptions can't inject markup.
