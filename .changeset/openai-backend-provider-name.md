---
'@cogitator-ai/core': patch
---

`OpenAIBackend` accepts any provider name, not only the built-in ones, so an OpenAI-compatible service registered as a custom backend reports its own name in errors and traces: `new OpenAIBackend({ apiKey, baseUrl: 'https://openrouter.ai/api/v1', provider: 'openrouter' })` now compiles and its errors say `openrouter` instead of `openai`.
