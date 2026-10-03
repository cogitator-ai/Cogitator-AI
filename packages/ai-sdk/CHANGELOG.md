# @cogitator-ai/ai-sdk

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
