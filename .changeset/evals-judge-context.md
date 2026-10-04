---
'@cogitator-ai/evals': minor
---

LLM judge metrics now read the case's `context`. The judge saw only the input, the expected answer and the response, so checking faithfulness against source documents meant stuffing them into `input`. The context goes into the judge's prompt between the input and the expected answer, each key on its own line and objects as JSON, and `faithfulness()` judges against the input and the context.
