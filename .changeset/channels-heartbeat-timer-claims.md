---
'@cogitator-ai/channels': patch
---

`HeartbeatScheduler` now honours stores that claim timers (`claimTtl`, `renew`, `release`), like the workflows `TimerManager`: it renews the claim before a task fires and every `claimTtl / 3` while it runs, skips a task whose claim was taken over (new `onClaimLost` callback), and releases disabled, exhausted and not-yet-processed tasks so other workers are not blocked by its lease.
