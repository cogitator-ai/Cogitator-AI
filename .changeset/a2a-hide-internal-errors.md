---
'@cogitator-ai/a2a': patch
---

Errors that are neither an `A2AError` nor a `CogitatorError` (a failing task store, auth validator or agent run) no longer reach clients with their text: JSON-RPC answers them with a bare `-32603 Internal error`, failed tasks and stream `failed` events say `Internal error`, and the real error is logged on the server. A2A errors and `CogitatorError` messages are kept.
