---
'@cogitator-ai/hono': patch
---

The `finish` event of an agent stream now carries the same `usage` as `POST /agents/:name/run`: `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` are included when the model reported them. Before, the stream sent only the input, output and total tokens, so a streaming client lost the reasoning and cache counts.
