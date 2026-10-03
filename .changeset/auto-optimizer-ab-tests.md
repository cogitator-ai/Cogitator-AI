---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

`AutoOptimizer` A/B tests now get samples for both variants: traces carry the instructions version or A/B variant the run used (`ExecutionTrace.prompt`, from `RunResult.prompt`), runs served through `cogitator.prompts` are no longer counted again (all as control), and a test Cogitator completed finishes the optimization run. `ABTestingFramework` reads the active test from its store instead of a per-instance cache. `triggerOptimization()` fails with a clear error instead of optimizing empty instructions when the agent has no deployed version.
