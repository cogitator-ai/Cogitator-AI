---
'@cogitator-ai/models': minor
---

`openrouter/*` models are priced from OpenRouter's public model list again. LiteLLM no longer lists OpenRouter, so `openrouter/deepseek/deepseek-v4-pro` fell through to DeepSeek's direct price.

- The registry fetches `GET https://openrouter.ai/api/v1/models` (no key) next to the LiteLLM catalogue and caches both together. Its models get provider `openrouter`, `catalogId` `openrouter/<id>` and OpenRouter's prices, cache reads and writes included, over any LiteLLM listing. Routers without a fixed price (`openrouter/auto`) carry `priceUnknown`, expired models are deprecated, models that do not answer in text are left out.
- A copy of the list ships with the package (`OPENROUTER_SNAPSHOT`), so `openrouter/*` models are priced offline and when only OpenRouter cannot be fetched. `pnpm --filter @cogitator-ai/models snapshot` refreshes it with the LiteLLM copy.
- OpenRouter's vendor names `z-ai` and `x-ai` are read as the providers `zai` and `xai`, so `z-ai/glm-5.3` finds Z.ai's own listing.
- New exports: `fetchOpenRouterData`, `parseOpenRouterModels`, `transformOpenRouterData`, `OpenRouterModelEntrySchema`, `OPENROUTER_MODELS_URL`, `OPENROUTER_SNAPSHOT`.
- The cache version is bumped, so caches written before are fetched again.
