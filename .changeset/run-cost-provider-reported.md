---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

`RunResult.usage.cost` uses what the provider charged when it says so. OpenAI-compatible services that add the call's price to `usage` (OpenRouter does, as `usage.cost`) now pass it on as `ChatUsage.cost`, and the runtime adds those prices up instead of estimating them, so runs on models the model registry does not list (for example DeepSeek or Qwen through OpenRouter) no longer report a cost of 0. Calls without a reported price are priced from the registry as before, now with the full model string (`openrouter/deepseek/deepseek-v4-pro`) so the registry can pick that provider's listing. The cost so far is kept in run checkpoints, so a paused and resumed run adds to it. Thought trees and cost estimates use the same rules.
