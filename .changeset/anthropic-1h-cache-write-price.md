---
'@cogitator-ai/models': minor
'@cogitator-ai/core': patch
'@cogitator-ai/types': minor
---

Prompt-cache writes with Anthropic's 1-hour TTL are priced at their own rate. With `llm.promptCache: { ttl: '1h' }` every write was counted at the 5-minute price, 37.5% under what Anthropic bills. `ChatUsage.cacheWrite1hTokens` reports the part of `cacheWriteTokens` written for an hour, `ModelPricing.inputCacheWrite1h` holds its price (read from LiteLLM and set on the built-in Claude models), and `calculateCost()` takes `cacheWrite1hTokens`.
