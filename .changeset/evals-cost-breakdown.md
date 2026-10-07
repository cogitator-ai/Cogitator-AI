---
'@cogitator-ai/evals': minor
---

`stats.cost` now includes the LLM judge, so a budget assertion sees what the run really spent, and `stats.targetCost` and `stats.judgeCost` split it. Each judge score carries the judge's `usage`. A case's `usage` sums every attempt that reported one, so an attempt that finished after it timed out still counts, and `attempts` says how many attempts the case took.
