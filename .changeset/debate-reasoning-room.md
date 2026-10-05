---
'@cogitator-ai/swarms': minor
'@cogitator-ai/types': minor
---

A debate turn of a reasoning model no longer comes back empty under a short `maxTokensPerTurn`. Providers count reasoning in the same output limit as the answer, so a model that reasoned past the limit returned an empty or cut-off turn. `maxTokensPerTurn` is now the length of the answer: a turn that came back empty or cut off while the model reasoned is run once more with room to reason on top, 4096 tokens or twice what it reasoned, and the new `DebateConfig.reasoningTokensPerTurn` gives that room from the first try. A model that does not reason keeps the limit as it is and is never retried.
