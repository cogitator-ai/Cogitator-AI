---
'@cogitator-ai/workflows': patch
---

`humanWorkflowNode` outputs `withdrawn`, and `escalated` is now true when a timed-out request was answered by its `escalateTo` assignee. `subworkflowWorkflowNode` with `onError: 'catch'` keeps the parent running and outputs `{ error: { name, message } }` instead of failing it, and `parallelSubworkflowsNode` accepts configs typed with the child state.
