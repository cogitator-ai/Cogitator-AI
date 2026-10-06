---
'@cogitator-ai/express': minor
'@cogitator-ai/fastify': minor
'@cogitator-ai/hono': minor
'@cogitator-ai/koa': minor
'@cogitator-ai/next': minor
---

The adapters speak one protocol from `@cogitator-ai/server-shared`. Clients can no longer write system content: a run's `context` goes into the system prompt, so a request that sets any key is refused with `400` unless the new `acceptContext` option lists it (or is `true`), and `POST /threads/:id/messages` takes only `user` and `assistant` unless `threadMessageRoles` adds `system`. A body that is not JSON (`text/plain`, a form) is refused with `415` before it is parsed, so a web page on another origin cannot start a run without a preflight. Every adapter reads bodies with the shared validators, Fastify before its schema coerces types, and Next no longer accepts an empty `threadId`. The JSON answer of a run and the WebSocket `complete` event are the same object everywhere, with `structured`, `structuredError`, `truncated`, `blocked`, `iterationLimitReached` and `traceId`, and never the system prompt, the history or trace spans (Next drops `trace` from `AgentResponse`, read the full `RunResult` in `afterRun`). The `start` and `finish` events of an agent stream name the run's thread, so a client that sent none can continue the conversation. Swarm routes close the swarm they build once the run ends, so distributed swarms no longer leak Redis connections and keys without expiry, and `GET /swarms` lists a router and pipeline stages. `options.checkpoint: true` on workflow runs is refused instead of silently doing nothing. Next streams gain heartbeats (`sseHeartbeatMs` on `createChatHandler` and `createResumeHandler`) and use the shared protocol instead of a copy.
