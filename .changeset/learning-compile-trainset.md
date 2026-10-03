---
'@cogitator-ai/core': minor
---

`AgentOptimizer.compile(agent, trainset)` uses the trainset. It ignored it, scored the same stored traces before and after, and so always reported zero improvement, which also kept `AutoOptimizer` from ever deploying a change. Pass `cogitator` to `AgentOptimizer`: `compile()` runs the trainset with the original agent (scoring it and collecting demo candidates) and again with the optimized instructions, so `scoreAfter` is measured. Without a runner it says so in `errors` and estimates `scoreAfter` from the instruction optimizer. Traces are re-read every round and handed to the instruction optimizer.
