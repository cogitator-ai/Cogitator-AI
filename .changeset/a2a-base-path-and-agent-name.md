---
'@cogitator-ai/a2a': minor
---

The Express, Fastify, Hono and Koa adapters serve JSON-RPC on the server's `basePath` (still `/a2a` by default) instead of always `/a2a`, so the endpoint matches the URL the Agent Cards advertise; `A2AServer.basePath` exposes it and must start with `/`. `A2AClient` takes an `agentName` option that it sends with `message/send`, `message/stream` and `agent/extendedCard`, and `agentCard()` returns that agent's card, so every agent of a multi-agent server is reachable, not only the first.
