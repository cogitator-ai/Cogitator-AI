---
'@cogitator-ai/ai-sdk': minor
---

Tool approvals survive the AI SDK bridge in both directions.

- `toAISDKTool()` sets `needsApproval` from the Cogitator tool's `requiresApproval`, and `fromAISDKTool()` sets `requiresApproval` from `needsApproval`. Before, a tool that needed approval on one side ran unasked on the other.
- An agent model whose run pauses for tool approvals no longer reports `finishReason: 'stop'` with an empty answer. `v3` and `v4` models (ai@6, ai@7) end the turn with `tool-calls` and a `tool-approval-request` per waiting call, and a `tool-approval-response` in the next prompt resumes the run. `v1` and `v2` models finish with `other` and a warning, with `status`, `threadId` and `pendingApprovals` in `providerMetadata.cogitator`.
