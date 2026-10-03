# @cogitator-ai/ai-sdk

## 0.5.0

### Minor Changes

- 33c567e: Remove the `AISDKModelWrapperOptions` type. No function ever accepted it (`fromAISDK` and `AISDKBackend` take only the AI SDK model, and its `defaultModel` had no effect), so code that imported it can drop the import.

### Patch Changes

- 79d9e12: The AI SDK backend reports the wrapped model's provider name without casting it to the built-in provider union, now that backends can name their own provider.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 0.4.0

### Minor Changes

- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0

## 0.3.1

### Patch Changes

- c4a4252: Agents can run on backends of your own. `llm.backends` takes `LLMBackend` instances by name: an agent with model `name/model` or `provider: 'name'` runs on it, and a name of a built-in provider replaces it. Backend plugins registered with `registerLLMBackend()` are now used by the runtime, created on first use with their config from `llm.plugins`; before, the registry was never consulted. A provider nobody provides fails with `CONFIGURATION_ERROR`. `cogitator.route(model)` returns the backend and model name a run uses. With `fromAISDK()`, any AI SDK model now runs Cogitator agents, tools included.
- 6404340: `llm.defaultModel` and `limits` now do what they say.

  - An agent may leave out `model` (`AgentConfig.model` is optional): it runs on the Cogitator's `llm.defaultModel`, and a run without either fails with a `CONFIGURATION_ERROR` naming the agent. `cogitator.resolveModel(agent)` returns the model a run uses. **Breaking for types:** `Agent.model` is `string | undefined`.
  - `limits.maxConcurrentRuns` caps concurrent `run()` calls; the rest wait in order, and their timeout and abort signal cover the wait.
  - `limits.defaultTimeout` applies to runs whose options and agent set no timeout. The 120 s default moved from the `Agent` constructor to the runtime, so `agent.config.timeout` is `undefined` unless set.
  - `limits.maxTokensPerRun` is checked before every model call and fails the run with the new `RUN_TOKEN_LIMIT_EXCEEDED` code.
  - Swarms: the assessor and the distributed coordinator resolve models through the Cogitator, so agents without a model work there too (`Assessor.analyze()` takes an optional resolver).

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0

## 0.3.0

### Minor Changes

- Support AI SDK 4, 5, 6 and 7. `cogitatorModel()`/`createCogitatorProvider()` detect the installed `ai` major (v1/v2/v3/v4, override via `specificationVersion`) at runtime and in the types, so existing ai@4 code keeps compiling and running. Agent tool calls are reported as provider-executed tool calls instead of client tool calls, so the AI SDK no longer runs them again. `fromAISDK()` wraps LanguageModelV1–V4. `toAISDKTool()` emits `inputSchema` plus `parameters` and passes the tool context through.

  **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.2.16

### Patch Changes

- Internal peer dependencies are now declared as version ranges instead of exact pins, so the package keeps installing cleanly alongside newer 0.x releases of @cogitator-ai/core.
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 0.2.14

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.2.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.2.8

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.2.7

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.2.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.2.3

### Patch Changes

- fix(ai-sdk): audit — 8 bugs & type fixes, +45 tests
  - Fix createCogitatorProvider: now accepts explicit agents config instead of broken unsafe cast
  - Fix fromAISDKTool: throw on missing execute instead of returning undefined
  - Fix AISDKBackend: derive provider from model instead of hardcoding 'openai'
  - Fix type: Partial<ToolCall> -> ToolCall where all fields always present
  - Remove unused @ai-sdk/provider-utils dependency
  - Add 45 unit tests (tools, provider, model-wrapper)
  - Exclude tests from tsc build output

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.2.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- feat(next): add @cogitator-ai/next package for Next.js App Router integration
  - createChatHandler / createAgentHandler for streaming API routes
  - useCogitatorChat / useCogitatorAgent React hooks
  - AI SDK useChat compatible streaming protocol
  - Full TypeScript support

  feat(ai-sdk): add @cogitator-ai/ai-sdk package for Vercel AI SDK compatibility
  - cogitatorModel() - use Cogitator agents with generateText/streamText
  - fromAISDK() - use AI SDK models in Cogitator agents
  - Tool conversion utilities (fromAISDKTool, toAISDKTool)
  - Full streaming support with LanguageModelV1 interface
