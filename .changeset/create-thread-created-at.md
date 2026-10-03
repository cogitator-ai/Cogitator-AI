---
'@cogitator-ai/memory': patch
---

`createThread` on an existing thread id in the Postgres and SQLite adapters returned the current time as `createdAt`. It now returns the stored thread, so `createdAt` keeps the original creation time.
