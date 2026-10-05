---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

`RunResult.structuredError` says why the final answer does not match the agent's `responseFormat` after the run's one correction, in the words the model was given, such as `the answer is not valid JSON` or `celsius: expected number, received string`. Before, `structured` was simply `undefined` with no reason to read.
