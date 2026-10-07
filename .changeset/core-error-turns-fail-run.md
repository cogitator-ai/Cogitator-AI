---
'@cogitator-ai/core': patch
'@cogitator-ai/types': minor
---

A turn the provider ends in an error now fails the run with `LLM_INVALID_RESPONSE`, carrying the provider's explanation, instead of completing it with an empty answer. Gemini reports a function call it could not finish, often one cut by `maxTokens` without a stream, as `MALFORMED_FUNCTION_CALL`, and such a run used to end as `completed` with nothing in it. The new optional `ChatResponse.finishMessage` and `ChatStreamChunk.finishMessage` carry the provider's own explanation, which the Gemini backend fills from `finishMessage`.
