---
'@cogitator-ai/workflows': minor
---

`WorkflowManager` no longer overwrites a paused or cancelled run with `failed`, and `resume()` now actually continues a paused run from its last checkpoint (reusing the options it was started with, or new ones passed as a second argument); pausing requires a `checkpointStore`. Scheduled runs now get the manager's checkpoint store, tracer, metrics and `defaultTimeout`, honour `ScheduleOptions.timeout` and retry up to `ScheduleOptions.maxRetries` times, and the manager exposes `registerCronJob`, `unregisterCronJob`, `setCronJobEnabled` and `getCronJobs` for recurring runs.
