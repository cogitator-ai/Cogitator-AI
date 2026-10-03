---
'@cogitator-ai/evals': minor
---

The `run_eval` tool ran the whole dataset even with `maxCases` and reported `assertionsPassed: true` for limited runs. `EvalSuite.run({ maxCases })` now executes only the first `maxCases` cases, and the tool passes the limit through and reports the real assertion results.
