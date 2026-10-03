---
'@cogitator-ai/types': minor
'@cogitator-ai/workflows': minor
---

Timer claims belong to the store instance that took them. `TimerStore` gains optional `claimTtl`, `renew(id)` and `release(id)`, which `RedisTimerStore` and `PostgresTimerStore` implement (Postgres adds a `claimed_by` column, also to existing tables). `TimerManager` renews a claim right before a handler starts and every `claimTtl / 3` while it runs, so a handler slower than the lease no longer lets another worker run the same timer; it skips a timer whose claim another worker took while it waited and reports it through the new `onClaimLost` option. A timer without a handler, or beyond a poll's `batchSize`, is released so another manager can take it right away. A failed handler still keeps the claim until the lease ends, which spaces out retries.
