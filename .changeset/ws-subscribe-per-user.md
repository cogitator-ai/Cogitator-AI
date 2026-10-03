---
'@cogitator-ai/express': patch
'@cogitator-ai/fastify': patch
---

WebSocket `subscribe` channels no longer leak runs across users. A subscriber to `agent:<name>` now receives only the events of runs started by the same `userId` (as returned by `auth`) on other connections; before, any authenticated client could watch every user's prompts, tool calls and results. Servers without `auth` behave as before.
