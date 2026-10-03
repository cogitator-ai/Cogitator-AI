---
'@cogitator-ai/workflows': minor
---

Runs, approvals and timers can live in Redis or Postgres, like checkpoints: `RedisRunStore` / `PostgresRunStore`, `RedisApprovalStore` / `PostgresApprovalStore` and `RedisTimerStore` / `PostgresTimerStore` take an existing `@cogitator-ai/redis` client or ioredis, or a `pg` Pool, and create their tables on first use. Run queries, counts and stats run in the database (Postgres) or on sorted-set indexes (Redis); a human node waiting in one process resumes when another process answers (polled every `pollInterval`); and overdue timers are claimed for `claimTtl`, so several `TimerManager`s can share a store without firing a timer twice and a crashed worker's timers come back. All Postgres stores, the checkpoint store included, now survive two processes creating their tables at the same moment.
