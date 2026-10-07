---
'@cogitator-ai/core': patch
---

Claude through OpenRouter now uses the prompt cache. An `OpenAIBackend` for OpenRouter (`provider: 'openrouter'` or an `openrouter.ai` base URL) marks requests to `anthropic/*` models with the same top-level `cache_control` the native Anthropic backend sends, honoring `llm.promptCache` and its `ttl`, so a tool loop or a repeated request reads its prompt from the cache instead of paying for it in full each time. Usage reports OpenRouter's `cache_write_tokens` as `cacheWriteTokens`. Other OpenAI-compatible servers and models are left unmarked.
