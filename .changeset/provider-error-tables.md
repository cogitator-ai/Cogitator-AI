---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

LLM errors are classified by the provider's own error codes, not by the HTTP status alone. Every `LLMError` carries `kind` (also as `details.kind`): `rate_limit`, `quota`, `authentication`, `permission`, `not_found`, `invalid_request`, `context_overflow`, `content_filter`, `overloaded`, `server_error`, `timeout`, `network` or `invalid_response`. The tables read OpenAI and OpenAI-compatible servers by `error.code` and `type`, Anthropic by `error.type`, Gemini by its status and the quota that ran out, Bedrock by the exception name. Errors a provider sends inside a stream that already began are classified the same way. `classifyProviderError` is exported for backends of your own.

New `ErrorCode.LLM_QUOTA_EXCEEDED` for an account out of credits or over a quota that waiting a moment will not lift: OpenAI's `insufficient_quota`, `credit_balance_exhausted` and spend or usage limits, Anthropic's `billing_error` and a reached spend limit, a Gemini quota counted per day or prepaid credits that ran out, Bedrock's `ServiceQuotaExceededException`. These are never retried.

A call the caller aborts fails with the reason the caller aborted with (`signal.reason`), on every built-in backend, not with a retryable provider error a retry or fallback layer would act on. The OpenAI and Bedrock SDKs end a stream quietly when it is aborted, so a cut-off answer used to pass for a whole one. `abortReason(signal)` is exported.

Migration:

- A 429 for exhausted credits or a spend cap was `LLM_RATE_LIMITED` and retried. It is now `LLM_QUOTA_EXCEEDED`, not retryable. Code that waits and retries on `LLM_RATE_LIMITED` keeps working for real rate limits.
- A 504 from a provider was `LLM_UNAVAILABLE`, it is now `LLM_TIMEOUT` (still retryable).
- A prompt Gemini blocks was `LLM_INVALID_RESPONSE`, it is now `LLM_CONTENT_FILTERED`.
- An aborted call rejects with the abort reason. Check `signal.aborted` or the error you aborted with, not `LLMError`.
- A 403 is reported as `Permission denied (403)` instead of `Authentication failed (403)`, a 503 or 529 as `Provider overloaded`, both with the same code as before.
