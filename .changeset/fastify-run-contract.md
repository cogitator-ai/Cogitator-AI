---
'@cogitator-ai/fastify': minor
---

The `usage` of a run answer now includes `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, like Tetsu and Next, and `AgentRunResponseSchema` lists them.

SSE streams now write a `: keep-alive` comment every 5 seconds while a run is silent, so proxies and load balancers do not close a stream that waits on a slow tool or model. Set it with the new `sseHeartbeatMs` option (also on `FastifyStreamWriter`), `0` turns it off.

The run request schemas now take the `input` rule from `@cogitator-ai/server-shared`, so Fastify keeps refusing exactly the bodies every other adapter refuses.
