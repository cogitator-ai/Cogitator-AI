---
'@cogitator-ai/hono': minor
---

An `input` of only whitespace is now refused with `400 INVALID_INPUT` on run, stream and swarm routes and over the WebSocket. It used to reach the model, which answered and was billed, while Express and Fastify refused it. Validation now comes from `@cogitator-ai/server-shared`, so every adapter refuses the same bodies.

Long runs on Bun are no longer cut off. `Bun.serve` closes a connection silent for 10 seconds, so a stream or JSON run waiting on a slow tool ended with "terminated (other side closed)". SSE streams now write a `: keep-alive` comment every 5 seconds (new `sseHeartbeatMs` option, `0` turns it off, also on `HonoStreamWriter`), and the JSON run routes lift Bun's idle timeout for their own request.

The `usage` of a run answer now includes `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, like Tetsu and Next.
