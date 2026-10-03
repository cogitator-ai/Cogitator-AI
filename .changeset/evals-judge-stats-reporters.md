---
'@cogitator-ai/evals': minor
---

LLM-judge metrics, statistical metrics and file reporters report real numbers.

- The judge configured on `EvalSuite`, `EvalBuilder` or `EvalComparison` was wired to a stub that echoed its own prompt, so judge metrics scored 0 (or whatever number the prompt contained). The judge now runs as a Cogitator agent on `judge.model` with a `{ score, reasoning }` JSON schema, through `judge.cogitator` or the `cogitator` of an agent target. **Breaking:** a suite with LLM metrics and nothing to run the judge now fails when it is built instead of scoring 0.
- `latency()`, `cost()` and `tokenUsage()` reported a score of 0, so `aggregated.latency.p95` and `threshold('latency.p95', …)` were always 0 and always passed. They now return one value per case, the aggregate covers those values, and `aggregated.<name>.metadata` holds totals.
- `report(['json', 'csv'], { path })` treats `path` as a base and writes `.json` and `.csv` files next to each other instead of overwriting one file, creates missing directories, and runs `ci` last.
