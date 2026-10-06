---
'@cogitator-ai/evals': minor
---

Every built-in per-case metric takes a `name` option, such as `regex(/\[\d+\]/, { name: 'hasCitation' })` or `faithfulness({ name: 'faithfulToSources' })`. A suite refuses two metrics with the same name: before, two `regex()` checks merged into one `regex` aggregate, so a check that failed every case could hide behind one that passed. `regex()` also ignores the `g` and `y` flags, which made identical outputs alternate between pass and fail.
