---
'@cogitator-ai/workflows': patch
---

A timer interrupted by a pause or an abort no longer counts as completed. The timer node swallowed the abort and returned `{ cancelled: true }`, so the run checkpointed it as done and `resume()` ran the following nodes at once, skipping the rest of the wait (an embargo of 3 s paused after 0.5 s released 2.4 s early). The node now fails with an `AbortError` like a human node does, so it is not checkpointed and a resumed run waits again. A persisted timer (`persist: true` with a `timerStore`) is cancelled in its store and marked as interrupted, and on resume the node waits only until the original `firesAt`. A persisted timer cancelled through its store while the node waits (`TimerManager.cancel`) now reports `cancelled: true` and `onCancelled` instead of `onFired`.
