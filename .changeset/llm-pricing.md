---
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'@cogitator-ai/models': minor
'@cogitator-ai/core': minor
---

Model prices of your own and an offline catalogue. `llm.pricing` sets prices in USD per million tokens by model, for a fine-tune, a model newer than the catalogue or a negotiated rate: `pricing: { 'openai/gpt-4o': { input: 2, output: 8 } }`. A key matches the model string a run uses or its tail after any `/`: `openai/gpt-4o` prices that model string and the ones ending in it, such as `openrouter/openai/gpt-4o`, and `gpt-4o` the model at every provider that serves it under that name. These prices win over the model registry for run costs, cost-routing budgets, `estimateCost()`, Tree of Thoughts and `decide()`, and `Cogitator.pricer` exposes them.

A call whose provider reports no cost and whose model has no price used to count as $0 without a word. It still counts as $0, and the runtime now warns once per model, naming the `llm.pricing` key that fixes it. Ollama and vLLM run on your own hardware, so their calls are free unless `llm.pricing` prices them, even when a reseller lists a model of the same name, and stay quiet. A call is priced by the provider it routes to, under the name it is registered by (`llm.backends.vllm` prices as `vllm/...`), and a model string without a provider by the provider it runs on, `cog.pricedModel(model)` says which.

An Ollama or vLLM backend you register under a name of your own (`llm.backends.gpu2`) is free the same way.

A catalogue model listed without a price is no longer priced at $0: it keeps its context window and capabilities, carries `priceUnknown: true`, and the price lookups answer `null`, so its calls warn like any model without a price. A listing with a price wins over one without when a name matches several, automatic model selection skips cloud models without a price, and file caches written by earlier versions are fetched again (offline, an older cache gives way to the bundled copy).

`@cogitator-ai/models` ships a trimmed copy of the LiteLLM catalogue with its MIT notice (`LITELLM_SNAPSHOT`), the priced text and embedding models at a pinned LiteLLM commit named in `source`. The registry prices models from it when it can neither fetch the catalogue nor read its cache, and for lookups made before `initializeModels()`, where it used to know only the built-in models. Refresh it with `pnpm --filter @cogitator-ai/models snapshot`. `ModelPricer` prices by overrides of your own over the registry and `costOf` prices usage at a given `ModelPricing`.
