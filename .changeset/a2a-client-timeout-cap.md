---
'@cogitator-ai/a2a': patch
---

A client can no longer lift or remove the run timeout with `configuration.timeout`. It must be a positive integer on `message/send` and `message/stream` alike, and the server caps it at the agent's own `timeout`, or at the new `maxRunTimeoutMs` option (default `120000`) for an agent without one. Before, `timeout: 0` or `-1` ran without a time limit and a large value outlived the operator's limit.
