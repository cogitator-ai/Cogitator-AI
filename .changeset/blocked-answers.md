---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

Filtered and refused answers are visible on the result. `RunResult.blocked` is `'content_filter'` when the provider's safety system withheld the answer (OpenAI and Azure content filters, Gemini `SAFETY` and similar, Bedrock guardrails) and `'refusal'` when the model declined (OpenAI and Anthropic refusals, with the explanation in `output`). Before, such a run ended `completed` with an empty output after asking the model twice more. `ChatResponse.finishReason` gains `'content_filter'` and `'refusal'` (the new `FinishReason` type), and `normalizeTurn()` is exported for backends of your own.
