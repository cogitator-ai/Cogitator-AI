---
'@cogitator-ai/core': patch
---

OpenAI-compatible backends read the error a router such as OpenRouter sends in the body of a successful response, `{ error: { code, message } }` in place of the choices or inside a stream chunk. It now throws an `LLMError` by the code it carries, so a rate limit or a provider failure is retryable, where before the backend crashed on `response.choices[0]` with a `TypeError` that nothing retried. A response without choices is an invalid response, and a stream chunk without them is skipped. `providerErrorIn(body, context)` is exported for custom backends.
