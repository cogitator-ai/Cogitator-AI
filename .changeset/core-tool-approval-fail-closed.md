---
'@cogitator-ai/core': patch
---

Guardrail tool approvals fail closed. In `strictMode`, calls of tools with side effects now go through the run's approval flow (`onApproval`, `guardrails.onToolApproval`, or a paused run) instead of running silently when no `onToolApproval` is set, and `ToolGuard` denies a call that needs approval when no handler can give it.
