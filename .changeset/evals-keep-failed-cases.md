---
'@cogitator-ai/evals': minor
---

A metric that throws no longer drops its case from the results and crashes Node with an unhandled rejection, and an `onProgress` callback that throws is reported as a process warning instead. The failing metric scores 0 for that case with the reason in the new `MetricScore.error`, which the LLM judge (unreadable verdict, failed call) and `metric()` (throwing `evaluate`) set as well. A score that is not a finite number, such as NaN from `0 / 0`, counts as such a failure instead of poisoning the aggregate. `stats.errors` counts cases whose every attempt failed and `stats.metricErrors` the failed scores. `threshold` and `noRegression` fail plainly on a value that is not a finite number, and `saveBaseline()` refuses to write one, so a NaN can no longer become a `null` baseline that every later run passes.
