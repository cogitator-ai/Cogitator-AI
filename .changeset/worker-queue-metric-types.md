---
'@cogitator-ai/worker': minor
---

The completed and failed job counts come from the jobs BullMQ keeps in Redis, which `removeOnComplete`/`removeOnFail` cap, so they drop as old jobs are trimmed, yet they were exported as counters (`cogitator_queue_completed_total`, `cogitator_queue_failed_total`), which broke `rate()` and `increase()`. They are now gauges named `cogitator_queue_completed` and `cogitator_queue_failed`. For a real failure counter, `WorkerPool` records jobs that failed their last attempt in `pool.metrics` (`MetricsCollector.recordFailure`), exported as `cogitator_jobs_failed_total{type}`.
