---
'@cogitator-ai/workflows': patch
---

`WorkflowManager` records `currentNodes`, `completedNodes` and `failedNodes` for scheduled and triggered runs too (it did only for `execute()`), and a run's record holds every node update by the time the run is marked finished.
