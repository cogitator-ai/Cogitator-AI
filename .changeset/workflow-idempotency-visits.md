---
'@cogitator-ai/workflows': patch
'@cogitator-ai/types': minor
---

Idempotency keys of workflow nodes no longer change when a run resumes. The key used the scheduler's step, which starts again at 1 on resume, so a node that had already charged a card before the last checkpoint was run a second time. The key is now `workflow:<workflowId>:node:<name>:visit:<n>`, where `n` counts the runs of that node, and checkpoints record those counts in the new `WorkflowCheckpoint.nodeVisits` (passed back through `WorkflowExecuteOptions.nodeVisits`). Checkpoints saved before this change count each completed node once.
