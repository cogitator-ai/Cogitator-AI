---
'@cogitator-ai/tetsu': patch
---

The `finish` event of `/agents/:name/stream` and `/agents/:name/resume/stream` now carries the same `usage` as the JSON run response: `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` are included when the model reported them. Before, the stream sent only the input, output and total tokens, so a streaming client lost the reasoning and cache counts. The OpenAPI description of both routes says so.
