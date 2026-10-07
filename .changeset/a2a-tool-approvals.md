---
'@cogitator-ai/a2a': minor
---

A task whose agent run pauses for tool approvals now waits in `input-required` instead of reporting `completed` with the model's text from before the tool call. The agent's message carries the waiting calls in a `tool-approval-request` data part, and the client answers with a `tool-approval-response` data part (`client.answerApprovals(taskId, { decisions })` or `toolApprovalResponsePart()`), which resumes the run through the server Cogitator's `resume()`. `readToolApprovalRequest(task)` reads the waiting calls, and `asTool()` reports them in `pendingApprovals`. `CogitatorLike` gains an optional `resume`, and `AgentRunResult` the `status` and `pendingApprovals` fields.
