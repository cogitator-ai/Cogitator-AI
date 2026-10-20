---
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/models': minor
'@cogitator-ai/core': minor
---

Model prices of your own and an offline catalogue. `llm.pricing` sets prices in USD per million tokens by model, for a fine-tune, a model newer than the catalogue or a negotiated rate: `pricing: { 'openai/gpt-4o': { input: 2, output: 8 } }`. A key matches the model string a run uses or its tail after any `/`, so `gpt-4o` prices the model at every provider that serves it under that name. These prices win over the model registry for run costs, cost-routing budgets, `estimateCost()`, Tree of Thoughts and `decide()`, and `Cogitator.pricer` exposes them.

A call whose provider reports no cost and whose model has no price used to count as $0 without a word. It still counts as $0, and the runtime now warns once per model, naming the `llm.pricing` key that fixes it. Ollama and vLLM run on your own hardware, so their calls are free and stay quiet.

`@cogitator-ai/models` ships a trimmed copy of the LiteLLM catalogue (`LITELLM_SNAPSHOT`, MIT). The registry prices models from it when it can neither fetch the catalogue nor read its cache, and for lookups made before `initializeModels()`, where it used to know only the built-in models. Refresh it with `pnpm --filter @cogitator-ai/models snapshot`. `ModelPricer` prices by overrides of your own over the registry and `costOf` prices usage at a given `ModelPricing`.
