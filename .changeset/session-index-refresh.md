---
'@cogitator-ai/memory': minor
---

`SessionManager.list()` no longer comes back empty after a quiet day on Redis. The session index thread was only written when a session was created or deleted, so it expired with the adapter TTL while sessions stayed active, and the next session rebuilt it from itself alone. Using a session now puts it back into the index if needed and rewrites the index at most once per `indexRefreshInterval` (a new option, one minute by default).
