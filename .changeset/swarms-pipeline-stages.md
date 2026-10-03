---
'@cogitator-ai/swarms': patch
---

A pipeline swarm configured with the top-level `stages` field runs (it was rejected because only `pipeline.stages` was read); `gates` and `stageInput` still come from `pipeline`. Giving different stages in both places is rejected with a clear error.
