---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A run whose tool calls use up `maxIterations` now ends with an answer. Until now the loop stopped at the last tool turn, so the output was empty and `structured` was undefined for an agent with a response format, with nothing telling the caller why. The run now gets one more turn with `toolChoice: 'none'` and an instruction to answer from what it has, and tools the model still asks for on that turn are not run. `RunResult.iterationLimitReached` is set whenever the limit is hit, and `onIterationLimit: 'stop'` on the agent keeps the old behaviour. The option survives `serialize` and `deserialize`.
