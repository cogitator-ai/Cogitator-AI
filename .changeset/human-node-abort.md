---
'@cogitator-ai/workflows': patch
---

Human approval nodes now stop waiting when the workflow run is aborted: the pending approval request is withdrawn from the store and the node fails with an abort error instead of hanging until someone answers or the request times out.
