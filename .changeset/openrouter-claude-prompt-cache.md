---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
'@cogitator-ai/config': patch
---

Prompt caching for Claude shares the system prompt between runs and reaches Claude through OpenRouter.

Anthropic requests now mark the end of the agent's instructions at the start of the system prompt, so runs with different input, such as single-turn runs that share only their instructions, read those from the cache instead of writing them again. The top-level mark on the end of the conversation is set only when another turn is likely (the request offers tools or continues earlier turns), since a single turn with unique input only paid the cache write premium on it. `llm.promptCache.conversation` overrides that choice, and `ChatRequest.cachePrefix` names the stable start of a request's system prompt.

An `OpenAIBackend` for OpenRouter (`provider: 'openrouter'` or an `openrouter.ai` base URL) marks `anthropic/*` models the same way, where before it sent no marks and Claude never cached. Its usage reports OpenRouter's `cache_write_tokens` as `cacheWriteTokens`. Other OpenAI-compatible servers and models are left unmarked.
