---
'@cogitator-ai/server-shared': minor
---

The `finish` event of a stream now carries the same usage as the JSON run response. The protocol's `Usage` type gains the optional `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` (`RunUsage` is now the same type), and `createFinishEvent` passes its usage through `toRunUsage`, so a run's `RunResult.usage` can be given as is: the event keeps the counts the model reported and leaves out the run's cost and duration, exactly like the JSON answer. Before, a client streaming a run lost the reasoning and cache token counts that `/run` returned. The OpenAPI document gains a shared `RunUsage` schema, used by `AgentRunResponse` and by the new `StreamFinishEvent`.
