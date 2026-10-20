---
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/core': minor
---

Anthropic and Google take `baseUrl` and `headers`, for a gateway or proxy in front of the provider: `llm.providers.anthropic.baseUrl` (or `ANTHROPIC_BASE_URL`, `COGITATOR_ANTHROPIC_BASE_URL`) and `llm.providers.google.baseUrl` (or `COGITATOR_GOOGLE_BASE_URL`), the Gemini one with its API version, `https://generativelanguage.googleapis.com/v1beta` by default. `headers` also works for `openai`, `openrouter` (for example OpenRouter's `HTTP-Referer` and `X-Title`) and `vllm`, and Bedrock takes an `endpoint` for VPC endpoints and proxies.
