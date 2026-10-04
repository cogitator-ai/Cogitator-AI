---
'@cogitator-ai/next': minor
---

The `finish` event of `createChatHandler` (and of `createResumeHandler` with `stream: true`) now carries the same `usage` as `createAgentHandler`: `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` are included when the model reported them. Before, the stream sent only the input, output and total tokens. The exported `Usage` type gains these optional fields, and the JSON answer and the stream now share one converter, so they cannot drift apart.
