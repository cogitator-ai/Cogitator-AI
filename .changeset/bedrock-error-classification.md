---
'@cogitator-ai/core': patch
---

Bedrock errors are classified by their AWS exception name and HTTP status instead of words in the message. `ValidationException: Input is too long` was retried twice as an unavailable service, a message containing "separate" matched "rate" and became a rate limit, and `AccessDeniedException` was retried. Now `ThrottlingException` and `ServiceQuotaExceededException` are retryable rate limits, `ValidationException` is a client error (or `LLM_CONTEXT_LENGTH_EXCEEDED` for an overlong input), `AccessDeniedException` is not retried and `ModelTimeoutException` is a retryable `LLM_TIMEOUT`.
