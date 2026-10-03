---
'@cogitator-ai/workflows': patch
'@cogitator-ai/types': patch
---

`InMemoryRunStore` hands out copies of runs, so changing a returned run's node or tag lists no longer changes the stored run, and `list()` without filters is sorted like `list({})` (newest started first), matching the Redis and Postgres stores. `WorkflowRunStats` documents that cancelled runs count toward neither the success nor the failure rate.
