---
'@cogitator-ai/memory': patch
---

`RedisAdapter.getEntries({ limit })` reads only the newest `limit` entries instead of fetching and parsing the whole thread, and still fills the limit from older entries when the newest have expired.
