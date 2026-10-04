---
'@cogitator-ai/koa': minor
---

An `input` of only whitespace is now refused with `400 INVALID_INPUT` on run, stream and swarm routes and over the WebSocket. It used to reach the model, which answered and was billed, while Express and Fastify refused it. Validation now comes from `@cogitator-ai/server-shared`, so every adapter refuses the same bodies.

SSE streams now write a `: keep-alive` comment every 5 seconds while a run is silent, so proxies and load balancers do not close a stream that waits on a slow tool or model. Set it with the new `sseHeartbeatMs` option (also on `KoaStreamWriter`), `0` turns it off.

The `usage` of a run answer now includes `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, like Tetsu and Next.
