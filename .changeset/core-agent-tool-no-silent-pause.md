---
'@cogitator-ai/core': patch
---

`agentAsTool()` no longer reports a paused inner run as a success with empty output: an `onApproval` that answers `'pause'` declines the call (a delegated run cannot wait for a person), and a run that pauses anyway returns `success: false` with the pending tools.
