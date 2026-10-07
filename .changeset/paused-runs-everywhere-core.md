---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

A run that paused for tool approvals now keeps its pause wherever it goes, and tools can run outside a run the way a run executes them.

- The run result wire format (`toAgentWireRunResult` / `fromAgentWireRunResult`, used by queue jobs and distributed swarm turns) carries `status`, `pendingApprovals` and the `checkpoint`. Before, a paused run arrived as a completed one whose output was the model's text before the tool call, and nothing could resume it.
- `isPausedRun(result)` tells a paused run from an answer, and `AgentRunPausedError` (code `RUN_PAUSED`, HTTP 409) reports a pause where the caller cannot wait, with the calls that wait and the checkpoint to resume from. `findAgentRunPausedError` finds it behind wrapping errors.
- `cogitator.invokeTool(tool, args, options)` runs one tool call with schema validation, approval (`onApproval`, else `guardrails.onToolApproval`, else the call is refused with `pendingApproval`), the guardrails, the runtime's sandbox and `tool.timeout`. `Cogitator` implements the new `ToolInvoker` interface from `@cogitator-ai/types`.
