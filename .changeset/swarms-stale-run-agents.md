---
'@cogitator-ai/swarms': minor
---

A swarm run that timed out or failed rejected while its strategy kept going, and the strategy could still start agents and retries afterwards — even inside the next run of the same swarm. Agent runs are now bound to the run that started them (`SwarmCoordinator.runInScope`), and a run that rejects cancels its scope, so nothing of it launches once `run()` has settled.
