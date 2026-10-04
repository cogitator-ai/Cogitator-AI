---
'@cogitator-ai/server-shared': minor
---

One run contract for every server adapter. `parseRunRequest` and `parseSwarmRunRequest` validate the body of agent and swarm runs (an `input` of only whitespace is refused, so a request that says nothing never reaches the model), `RUN_INPUT_SCHEMA` and `NON_BLANK_PATTERN` give schema-driven adapters the same rule, and `isNonBlankString` checks a single value. `toRunUsage` and the `RunUsage` type describe the usage of a run answer, now with the optional `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens`. `DEFAULT_SSE_HEARTBEAT_MS`, `encodeHeartbeat`, `resolveSseHeartbeatMs` and `startHeartbeat` let SSE streams write a comment every 5 seconds while a run is silent. The OpenAPI document now states that `input` must contain more than whitespace and lists the three optional usage counts.
