---
'@cogitator-ai/workflows': patch
'@cogitator-ai/types': patch
---

Resume a workflow run that stopped inside a loop. A resumed run passed over every node that had ever completed, by name, so a run stopped in round 2 or later of an `addLoop` ended at once without an error and without reaching the exit node, and a run stopped in round 1 ended at the first back edge. Checkpoints now record where the run stood (`frontier`), and `WorkflowExecutor.resume()` and `WorkflowManager.resume()` go on from there: the node that had not completed runs with the idempotency key of its visit, the remaining rounds run once each, and the exit node is reached. A cycle whose nodes had all completed once is no longer taken for a finished run. Checkpoints saved by earlier versions stay readable and are resumed the way they were.
