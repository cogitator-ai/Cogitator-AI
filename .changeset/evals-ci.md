---
'@cogitator-ai/evals': minor
---

Evals skip scoring cases that failed, carry how agent runs ended, cache and limit the judge, run under Vitest and report to CI as JUnit and GitHub annotations

A case whose every attempt failed is no longer scored: its empty output costs no judge calls and no longer counts as a 0 in the means. Aggregates cover the cases that answered, `aggregated.<metric>.count` says how many, and the new `maxErrorRate(rate)` assertion fails a run where too many cases errored. This raises the means of a run with failed cases, so pair metric thresholds with `maxErrorRate` and save `noRegression` baselines again. An agent target's case result now carries `truncated`, `iterationLimitReached` and `paused`, and the reporters show them.

The judge takes `cache` (`true` for memory, or a `JudgeCache` with `get` and `set`), which reuses a verdict for the same model, settings and prompt and never caches an unreadable one, and `concurrency`, which caps the judge calls running at once. Both belong to the suite and its runs share them. A `JudgeCache` that fails to read or write only warns, and the judge runs as if there were no cache.

`describeEval(name, { suite, run?, timeout? })` from `@cogitator-ai/evals/vitest` runs a suite once under Vitest, with a test per case that fails when the case errored and one for the assertions. `vitest` is an optional peer dependency.

The `ci` reporter sets `process.exitCode` instead of calling `process.exit(1)`, so output flushes and later hooks run. The new `junit` reporter writes `<path>.xml`, and the `github` reporter prints workflow command annotations and appends a summary to `$GITHUB_STEP_SUMMARY`.

`Dataset.sample(n, { seed })` and `shuffle({ seed })` pick and order the same cases on every run for a number or string seed. The JSONL and CSV loaders name the line of the file a case the schema refuses comes from. The CSV loader now splits on commas instead of guessing the delimiter, so a single column with semicolons stays whole, and throws on a malformed row such as a quote never closed instead of folding the rest of the file into one case.

`EvalComparison` counts a case that errored on one side as a 0 for that side, so a challenger that fails cases loses on them, leaves out the cases neither side scored, and gives each metric `n`, the cases it was compared on.
