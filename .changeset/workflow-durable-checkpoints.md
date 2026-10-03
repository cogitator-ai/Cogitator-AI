---
'@cogitator-ai/types': minor
'@cogitator-ai/workflows': minor
---

Workflow checkpoints in Redis and Postgres, and resuming that resumes.

- `RedisCheckpointStore` (an `@cogitator-ai/redis` client or ioredis) and `PostgresCheckpointStore` (a `pg` Pool; creates its table on first use) keep checkpoints where any process can resume them.
- **Fixes:** `WorkflowExecutor.resume()` ran finished nodes again when they followed another finished node, and nodes after a finished node lost its output as their input; both are fixed (`WorkflowExecuteOptions.nodeResults` carries the outputs). Checkpoints saved in the same millisecond now get increasing timestamps, so "latest" is the latest. `WorkflowManager.replay(workflow, runId, node)` runs the node and everything after it again (it used to skip some of them) with the earlier nodes' results, and a manager with a `checkpointStore` checkpoints its runs by default, so they can be replayed.
