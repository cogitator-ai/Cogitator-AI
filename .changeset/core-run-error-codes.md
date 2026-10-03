---
'@cogitator-ai/types': minor
'@cogitator-ai/core': patch
---

Deliberate run failures are `CogitatorError`s with a code, so server adapters pass their messages on instead of masking them: a run timeout is `RUN_TIMEOUT` (504, new), a budget stop `BUDGET_EXCEEDED` (429, new), a guardrail-blocked input or output `LLM_CONTENT_FILTERED`, and a missing audio API key, an invalid `limits.maxConcurrentRuns` or a cost estimate without a model `CONFIGURATION_ERROR`. Messages are unchanged.
