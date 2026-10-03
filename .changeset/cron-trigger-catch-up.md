---
'@cogitator-ai/workflows': patch
---

Cron triggers registered with `catchUp: true` now fire every occurrence that passed while their timer was late (system sleep, a blocked event loop), each with its own timestamp, instead of skipping them.
