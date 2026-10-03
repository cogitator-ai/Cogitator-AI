---
'@cogitator-ai/express': patch
'@cogitator-ai/fastify': patch
'@cogitator-ai/hono': patch
'@cogitator-ai/koa': patch
'@cogitator-ai/next': patch
'@cogitator-ai/tetsu': patch
---

Errors that are not a `CogitatorError` no longer reach the client with their text, which can carry internals such as connection strings or file paths. They are logged on the server and answered as `Internal server error` everywhere: the Next.js agent, chat and resume handlers (now with `code: 'INTERNAL_ERROR'`), WebSocket run errors in Express and Fastify, `Workflow failed: …` responses, and the `node_error` / `agent_error` stream events of workflows and swarms in every adapter. A `CogitatorError` keeps its message and code.
