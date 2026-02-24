# @cogitator-ai/ai-sdk

Vercel AI SDK adapter for Cogitator — bidirectional compatibility between Cogitator agents and AI SDK.

## Installation

```bash
npm install @cogitator-ai/ai-sdk
# or
pnpm add @cogitator-ai/ai-sdk
```

## Features

- **Use Cogitator agents with AI SDK** — `generateText`, `streamText`, `useChat`
- **Use AI SDK models in Cogitator** — wrap any AI SDK provider for use in Cogitator agents
- **Tool conversion** — seamlessly convert tools between formats

## Usage

### Cogitator Agent as AI SDK Provider

Use your Cogitator agents with AI SDK's `generateText` and `streamText`:

```typescript
import { generateText, streamText } from 'ai';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { cogitatorModel } from '@cogitator-ai/ai-sdk';
import { z } from 'zod';

// Create your Cogitator setup
const cog = new Cogitator({
  llm: { defaultProvider: 'openai' },
});

const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: [`Result for: ${query}`] }),
});

const researcher = new Agent({
  name: 'researcher',
  model: 'openai/gpt-4o',
  instructions: 'You are a research assistant.',
  tools: [searchTool],
});

// Use as AI SDK model
const result = await generateText({
  model: cogitatorModel(cog, researcher),
  prompt: 'Research the latest AI developments',
});

console.log(result.text);

// Streaming
const stream = await streamText({
  model: cogitatorModel(cog, researcher),
  prompt: 'Write an article about TypeScript',
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

### AI SDK Models in Cogitator

Use any AI SDK provider (OpenAI, Anthropic, Google, etc.) in your Cogitator agents:

```typescript
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { fromAISDK } from '@cogitator-ai/ai-sdk';

// Wrap AI SDK model for Cogitator
const agent = new Agent({
  name: 'writer',
  model: 'custom', // placeholder, actual model comes from backend
  instructions: 'You are a creative writer.',
});

// Create a Cogitator instance with AI SDK backend
const cog = new Cogitator();

// Use fromAISDK to create a backend from any AI SDK model
const backend = fromAISDK(openai('gpt-4o'));

// Run with custom backend (requires custom integration)
const result = await cog.run(agent, {
  input: 'Write a haiku about programming',
});
```

### Tool Conversion

Convert tools between Cogitator and AI SDK formats:

```typescript
import { tool as aiTool } from 'ai';
import { tool as cogTool } from '@cogitator-ai/core';
import { fromAISDKTool, toAISDKTool, convertToolsToAISDK } from '@cogitator-ai/ai-sdk';
import { z } from 'zod';

// AI SDK tool → Cogitator tool
const aiWeather = aiTool({
  description: 'Get weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ temp: 20, city }),
});
const cogWeather = fromAISDKTool(aiWeather, 'weather');

// Cogitator tool → AI SDK tool
const cogCalculator = cogTool({
  name: 'calculator',
  description: 'Perform calculations',
  parameters: z.object({ expression: z.string() }),
  execute: async ({ expression }) => ({ result: eval(expression) }),
});
const aiCalculator = toAISDKTool(cogCalculator);

// Batch conversion
const cogitatorTools = [cogCalculator /* more tools */];
const aiTools = convertToolsToAISDK(cogitatorTools);
```

## API Reference

### `cogitatorModel(cogitator, agent, options?)`

Creates an AI SDK `LanguageModelV1` from a Cogitator agent.

```typescript
function cogitatorModel(
  cogitator: Cogitator,
  agent: Agent,
  options?: CogitatorProviderOptions
): LanguageModelV1;

interface CogitatorProviderOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}
```

### `createCogitatorProvider(cogitator, config)`

Creates a provider factory for named agent lookup.

```typescript
function createCogitatorProvider(
  cogitator: Cogitator,
  config: CogitatorProviderConfig
): CogitatorProvider;

interface CogitatorProviderConfig {
  agents: Agent[] | Map<string, Agent> | Record<string, Agent>;
}
```

```typescript
const provider = createCogitatorProvider(cogitator, {
  agents: [researcher, writer],
});
const model = provider('researcher');
```

### `fromAISDK(model)`

Wraps an AI SDK `LanguageModelV1` as a Cogitator `LLMBackend`.

```typescript
function fromAISDK(model: LanguageModelV1): LLMBackend;
```

### `fromAISDKTool(aiTool, name?)`

Converts an AI SDK tool to a Cogitator tool.

```typescript
function fromAISDKTool<TParams, TResult>(
  aiTool: CoreTool,
  toolName?: string
): Tool<TParams, TResult>;
```

### `toAISDKTool(cogTool)`

Converts a Cogitator tool to an AI SDK tool.

```typescript
function toAISDKTool<TParams, TResult>(cogTool: Tool<TParams, TResult>): CoreTool;
```

### `convertToolsFromAISDK(aiTools)`

Batch converts AI SDK tools to Cogitator tools.

```typescript
function convertToolsFromAISDK(aiTools: Record<string, CoreTool>): Tool[];
```

### `convertToolsToAISDK(cogTools)`

Batch converts Cogitator tools to AI SDK tools.

```typescript
function convertToolsToAISDK(cogTools: Tool[]): Record<string, CoreTool>;
```

## Compatibility

- **AI SDK**: `>=4.0.0`
- **Cogitator Core**: `>=0.17.0`
- **Zod**: `^3.23.8` (AI SDK requirement)

## Notes

### Zod Version

This package uses Zod 3.x for AI SDK compatibility. If your project uses Zod 4.x (like `@cogitator-ai/core`), the tool conversion functions handle the schema bridging automatically.

### Streaming

When using `cogitatorModel` with `streamText`, the agent's full execution (including tool calls) happens, and tokens are streamed as they're generated.

### useChat Compatibility

The `@cogitator-ai/next` package provides handlers that are already compatible with AI SDK's `useChat` hook. This package focuses on the lower-level model adapter.

## License

MIT
