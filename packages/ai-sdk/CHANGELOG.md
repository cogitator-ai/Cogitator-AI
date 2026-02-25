# @cogitator-ai/ai-sdk

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
