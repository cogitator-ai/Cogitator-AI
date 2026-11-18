---
'@cogitator-ai/workflows': patch
---

`agentNode` no longer lets `runOptions.signal` replace the node's own signal. The agent run, and a run resumed after tool approvals, is now cancelled when either the node signal (node timeout, aborted workflow run) or the caller's `runOptions.signal` aborts. Before, a node that timed out left its agent running, and a retry started a second run next to the first.
