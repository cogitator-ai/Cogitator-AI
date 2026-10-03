---
'@cogitator-ai/swarms': patch
'@cogitator-ai/types': patch
---

Swarm config fields that were accepted but ignored now work or say why they cannot: `observability.tracing` logs each agent run's spans, `distributed.retry` re-dispatches jobs that fail on a worker or time out, and `distributed.cleanupAfter` expires the swarm's Redis state after `close()` (default one hour). `messaging.protocol` (now optional), `blackboard.locking` and `distributed.workerConcurrency` have no effect and are marked deprecated with the reason. `swarm.messageBus` and `swarm.events` are typed with their full API (`markAsRead`, `onMessage`, `getEventsByType`, `getEventsByAgent`).
