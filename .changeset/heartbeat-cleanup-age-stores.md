---
'@cogitator-ai/channels': patch
---

`HeartbeatScheduler` now removes old fired and cancelled tasks from every timer store. It passed a cutoff time to `cleanup()`, which only `SimpleTimerStore` reads that way, so the stores that take an age in ms (the in-memory and file stores of core, the Redis and Postgres stores of workflows) never removed anything.
