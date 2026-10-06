---
'@cogitator-ai/workflows': minor
---

Map nodes stop when they should. Without `continueOnError` the first failed item now stops the map: no further item starts, the items in flight are aborted, and the error's `partialResults` report what each item really did (`MapItemSkippedError` for items that never started) instead of marking every item failed. The mapper gets a fourth argument `{ signal, attempt }`: the signal aborts on the item's `timeout`, on another item's failure and when the workflow run is cancelled or paused, and a timed-out attempt is aborted before the next one starts, so retries no longer overlap. `mapWorkflowNode` and `mapReduceWorkflowNode` pass the run's signal, and `executeMap`/`executeMapReduce` accept `{ signal }` as a third argument.
