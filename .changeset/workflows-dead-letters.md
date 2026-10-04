---
'@cogitator-ai/workflows': minor
'@cogitator-ai/types': minor
---

Dead letters can be retried for real and kept in Postgres. `DLQ.retry(id)` only bumped a counter, so retrying a failed node was left to every app. `WorkflowManager.retryDeadLetter(dlq, id)` now replays the entry's run from the failed node, keeping the checkpointed results of the nodes before it, or runs the workflow again from its input when the run failed before its first checkpoint. The attempt is recorded first and the entry is removed when the retry succeeds. `PostgresDLQ` stores the queue in Postgres (one table, created on first use, filters in SQL, `cleanupExpired()`), so failed nodes survive restarts and every process sees one queue.
