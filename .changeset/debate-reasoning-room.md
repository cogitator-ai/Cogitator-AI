---
'@cogitator-ai/swarms': minor
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

A debate turn of a reasoning model no longer comes back empty under a short `maxTokensPerTurn`. Providers count reasoning in the same output limit as the answer, so a model that reasoned past the limit returned an empty or cut-off turn. Now a turn the model spent thinking, its answer stopped at the limit or came back empty after reasoning with less than half the limit in visible text, is run once more with room to reason on top: 4096 tokens or twice what it reasoned. The check works on every provider, including those that report no reasoning tokens. A model that does not reason keeps the limit as it is, and a turn that called tools is never run again. The new `DebateConfig.reasoningTokensPerTurn` gives the room from the first try; debaters are asked to keep their answer to `maxTokensPerTurn`, since providers cannot cap the answer apart from the reasoning.

`RunResult.truncated` is `true` when the model's last answer stopped at the output token limit.
