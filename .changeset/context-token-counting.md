---
'@cogitator-ai/memory': minor
---

Token counts include tool calls and images. `countMessageTokens` counts the names and JSON arguments of an assistant message's `toolCalls` and estimates images (85 tokens for `detail: 'low'`, 1600 otherwise), and the new `countEntryTokens` recounts stored entries, so `ContextBuilder` keeps to its budget when history holds large tool arguments saved with an old count. `countToolCallsTokens` is exported too.
