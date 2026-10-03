---
'@cogitator-ai/voice': patch
---

`verifyClient` may return `false` to reject an upgrade with 401, so an async check such as `async (req) => isValid(req)` type-checks; `true` accepts and `{ code, message }` still rejects with that status.
