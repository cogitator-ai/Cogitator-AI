---
'@cogitator-ai/express': minor
---

`CogitatorServer.init()` no longer prints `[CogitatorServer] Initialized at ...` to the console, and the WebSocket setup no longer prints where it listens. Both now report through the core logger at `debug` level, so they stay silent unless `LOG_LEVEL=debug` or your own logger set with `setLogger()` asks for them. Errors are still logged.

Run bodies are now validated by the validator shared with every adapter from `@cogitator-ai/server-shared`. Blank inputs are still refused with `400 INVALID_INPUT`, the messages now name the field the same way as Hono and Koa (`Field "input" must not be blank`), and an empty `threadId` is refused too.

SSE streams now write a `: keep-alive` comment every 5 seconds while a run is silent, so proxies and load balancers do not close a stream that waits on a slow tool or model. Set it with the new `config.sseHeartbeatMs` option (also on `ExpressStreamWriter`), `0` turns it off.

The `usage` of a run answer now includes `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, like Tetsu and Next.
