---
'@cogitator-ai/sandbox': patch
---

fix: properly terminate Docker containers on timeout

Previously, when a timeout occurred in Docker executor, only a flag was set but the exec process continued running in the background. Now:

- Uses Promise.race to immediately resolve on timeout
- Closes stream when timeout fires
- Marks timed-out containers as corrupted so they're destroyed instead of returned to pool
- Uses exit code 124 (standard timeout exit code)
