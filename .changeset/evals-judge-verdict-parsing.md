---
'@cogitator-ai/evals': patch
---

The LLM judge reads its verdict more carefully. A `{"score": "0.8"}` verdict in a code fence scored 0 and `There is 1 factual error. Score: 0.4` scored 1: now a fenced verdict and a numeric string score are read, and an answer without JSON falls back to its last labelled score (`Score: 0.4`, `score is 4/5`) instead of the first number that looks like 0 or 1.
