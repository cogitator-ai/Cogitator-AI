---
'@cogitator-ai/workflows': patch
---

`WorkflowManager.cancel()` now sticks when the node in flight ignores the abort signal and finishes: the run stays `cancelled` with its reason and `execute()` returns the cancel error, before the run was flipped to `completed` after `cancel()` had resolved.

A human request that timed out and was escalated is closed once the escalation has an answer, so it no longer stays in `getPendingForAssignee()` of its first assignee. It is closed with `respondedBy: ESCALATED` (new exports `ESCALATED` and `escalatedResponse`), the decision stays on the escalation, and a node that runs again after a restart still gets that decision.
