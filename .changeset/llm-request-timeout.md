---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
---

A model call that hangs no longer eats the whole run. `llm.retry.requestTimeout` sets how long one call may take: a call with no answer by then is aborted and retried like a dropped connection, as a retryable `LLM_TIMEOUT`, and a stream gets that long for each chunk (a stream that stalls after its first chunk fails, as any broken stream does). Before, a request the provider never answered waited for the SDK's own timeout, ten minutes for OpenAI-compatible servers, so a run with a shorter `timeout` failed without a retry while other calls to the same model answered in seconds. It is off by default, and YAML configs take it as `llm.retry.requestTimeout`.
