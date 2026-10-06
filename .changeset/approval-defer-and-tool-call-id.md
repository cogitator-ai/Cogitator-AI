---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

`onApproval` may return `undefined` to leave a call to `guardrails.onToolApproval` (and, without it, to pause the run), so a run can decide some calls itself and keep the configured policy for the rest. Tools also get the id of the call they execute as `context.toolCallId`, in runs and in `cogitator.invokeTool()`.
