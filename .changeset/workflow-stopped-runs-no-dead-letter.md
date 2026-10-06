---
'@cogitator-ai/workflows': patch
---

Pausing, cancelling or timing out a workflow run no longer writes the node it interrupted to the dead-letter queue, counts it as a failed node execution or reports it to `onNodeError`. Retrying such an entry while resuming the run executed the node, and everything after it, twice.
