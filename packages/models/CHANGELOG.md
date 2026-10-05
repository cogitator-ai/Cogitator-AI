# @cogitator-ai/models

## 18.2.1

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.

## 18.2.0

### Minor Changes

- [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217) - Provider-qualified model ids now get that provider's price. The registry used to key every LiteLLM model by the last segment of its id, keep whichever provider the catalogue listed first and ignore any `provider/` prefix on lookups, so `getModel('openrouter/deepseek/deepseek-v4-pro')` returned Azure's entry at 1.74/3.48 USD per million tokens instead of OpenRouter's 0.2088/0.4176, and `calculateCost` priced runs the same wrong way. The registry now keeps one entry per provider: `id` is the model's name at that provider (`deepseek/deepseek-v4-pro` on OpenRouter), and the new `catalogId` field holds the LiteLLM key (`openrouter/deepseek/deepseek-v4-pro`).

  Lookups find the named provider's entry for both Cogitator model strings (`openai/gpt-6.1-sol`, `google/gemini-3.8-flash`) and LiteLLM keys (`azure_ai/...`, `gemini/...`). When that provider does not list the model, the prefix is dropped and the rest is looked up. A bare name picks a listing by fixed rules instead of catalogue order, the vendor's own listing first, so `deepseek-v4-pro` is DeepSeek's price. Built-in models and the pricing helpers follow the same rules. Prices keep their exact value instead of being rounded to a thousandth of a dollar per million tokens, and OpenRouter is listed among `BUILTIN_PROVIDERS`. The cache format version changed, so existing model caches are refetched once.

## 18.1.0

### Minor Changes

- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

### Patch Changes

- a7cb81b: Cogitator runs on Cloudflare Workers and on Deno without extra permissions. Agents no longer draw a random id in their constructor — it is generated on first read — so they can be created at module scope, where Workers forbid random values. The runtime, logger and built-in tools read environment variables through a guard, and only when a feature needs them: a run no longer asks for `OPENAI_API_KEY` unless it has audio, and runtimes without `process` or with env access denied get `undefined` instead of an error. The model price cache in `@cogitator-ai/models` loads the file system lazily and stays in memory where there is none, so importing it no longer reads the home directory. `validateSkill` checks dependencies through `process.getBuiltinModule` and warns where packages cannot be resolved.

## 18.0.0

### Major Changes

- Registry adds GPT-6, gpt-5.6, Claude 5.5 / Fable 5.1 and Gemini 3.8 / 3.5 Flash-Lite and marks retired models deprecated.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

## 17.1.9

### Patch Changes

- Fix model registry metadata merging and refresh builtin fallback models.
  - Validate file cache entries before loading them.
  - Preserve builtin deprecation and capability metadata when LiteLLM refreshes.
  - Add current OpenAI, Anthropic, and Google fallback model metadata.

## 17.1.8

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.

## 17.1.6

### Patch Changes

- fix(models): audit — 7 bugs fixed, +21 tests, v17.1.6
  - Fix autoRefresh timer not starting when data loaded from cache
  - Remove redundant sample_spec check in fetcher
  - Export LiteLLM types and Zod schemas for public API completeness
  - Remove phantom @cogitator-ai/types peer dependency
  - Move @types/node to devDependencies
  - Add 21 new unit tests (51 → 72 total)
  - Update README with current model listings

## 17.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 17.1.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 17.1.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 17.1.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 17.1.0

### Minor Changes

- Update model registry to January 2026 models
  - Add Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
  - Add GPT-4.1, GPT-4.1 Mini/Nano, o3, o4-mini
  - Add Gemini 3 Pro/Flash Preview, Gemini 2.5 Pro/Flash/Flash-Lite
  - Mark deprecated models (Claude 3.x, GPT-4 Turbo, Gemini 1.5/2.0)
  - Fix model selector and cost estimator for new models
  - Export all 26 built-in tools from @cogitator-ai/core

## 17.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 16.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 14.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 13.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 10.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 9.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 8.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 8.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 7.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 6.0.1

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 6.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 5.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 4.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 1.1.0

### Minor Changes

- Add cache tests (memory/file storage, TTL, stale fallback, version mismatch)
- Add fetcher tests (fetch, transform, provider mapping, pricing calculation)
- Fix silent error handling: background refresh and auto-refresh now log warnings
- Add `shutdownModels()` export to properly cleanup singleton registry
- Fix deprecated field: now consistently returns `boolean` instead of `boolean | undefined`

### Breaking Changes

- Remove imprecise model lookup (substring matching). Now requires exact model ID or alias.

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
