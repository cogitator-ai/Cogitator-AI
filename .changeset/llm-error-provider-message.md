---
'@cogitator-ai/core': patch
---

LLM errors keep the provider's own message and report a context overflow only when there is one. Any 400 whose body mentioned tokens or length became "Context length exceeded" with the provider's text hidden, so "Unsupported parameter max_tokens, use max_completion_tokens" or an Anthropic `max_tokens` limit looked like an overflowing prompt. Context overflow is now read from the providers' own phrases (`context_length_exceeded`, `maximum context length`, `prompt is too long`, `input is too long` and the like), other bad requests are `VALIDATION_ERROR`, and every `LLMError` message ends with what the provider said.
