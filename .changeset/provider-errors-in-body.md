---
'@cogitator-ai/core': patch
---

OpenAI-compatible backends read the error a router such as OpenRouter sends in place of an answer: `{ error: { code, message } }` in the body of a successful response, or in an event of a stream, which the OpenAI SDK raises as an `APIError` without a status while the stream is read. Both now become an `LLMError` by the code they carry, so a rate limit or a provider failure is retryable, where before the backend crashed on `response.choices[0]` with a `TypeError`, or let the SDK's status-less error through, and nothing retried either. A response without choices is an invalid response, and a stream chunk without them is skipped. `providerErrorIn(body, context, cause?)` is exported for custom backends.
