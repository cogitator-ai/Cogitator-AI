---
'@cogitator-ai/rag': minor
---

`LLMReranker` failures can be observed. When the model's answer held no ranking, for example because a reasoning model spent its token budget on reasoning and answered with empty content, the reranker only logged a console warning and returned the retrieval order, so a pipeline looked reranked while it was not. Pass `onError` to be told about every fallback, with the raw answer, or `strict: true` to make `rerank()` throw an `LLMRerankError` instead. Without either option the reranker falls back and warns as before.
