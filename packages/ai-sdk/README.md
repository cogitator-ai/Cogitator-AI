# @cogitator-ai/ai-sdk

Vercel AI SDK adapter for Cogitator — bidirectional compatibility between Cogitator agents and the AI SDK, for **AI SDK 4, 5, 6 and 7**.

Full guide: [cogitator.app/docs/integrations/ai-sdk](https://cogitator.app/docs/integrations/ai-sdk)

## Installation

```bash
pnpm add @cogitator-ai/ai-sdk @cogitator-ai/core ai
```

`ai` is a peer dependency: `^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`.

## Features

- **Use Cogitator agents with the AI SDK** — `generateText`, `streamText`, structured output, any AI SDK major
- **Use AI SDK models in Cogitator** — wrap any AI SDK provider model (`LanguageModelV1` – `LanguageModelV4`) as a Cogitator backend
- **Tool conversion** — convert tools in both directions; converted tools work with the `tools` option of every AI SDK major

## Compatibility

| AI SDK | Model specs it accepts | Default `cogitatorModel()` spec | `fromAISDK()` input |
| ------ | ---------------------- | ------------------------------- | ------------------- |
| `ai@4` | `v1`                   | `v1`                            | `LanguageModelV1`   |
| `ai@5` | `v2`                   | `v2`                            | `LanguageModelV2`   |
| `ai@6` | `v2`, `v3`             | `v3`                            | `LanguageModelV3`   |
| `ai@7` | `v2`, `v3`, `v4`       | `v4`                            | `LanguageModelV4`   |

### Specification auto-detection

When `specificationVersion` is omitted, `cogitatorModel()` and `createCogitatorProvider()` pick the spec of the installed `ai` package, so existing code keeps working on every major:

- **Runtime:** `ai/package.json` is resolved from `process.cwd()` (your app), then from this package — also for ESM-only installs whose `exports` hide `package.json`. The result is cached per process. If `ai` cannot be resolved (for example in runtimes without `process.getBuiltinModule`), `'v2'` is used, which ai@5 – ai@7 accept.
- **Types:** the default return type is derived from the `LanguageModel` type of the `ai` package your TypeScript resolves, with the same mapping, so `generateText({ model: cogitatorModel(cog, agent) })` type-checks on ai@4 – ai@7 without changes.

Pass `specificationVersion` to override the detection — for example when several `ai` majors are installed, or when the runtime and the type-level `ai` differ. AI SDK 6 and 7 run `v2` models in a compatibility mode that logs a _"Using v2 specification compatibility mode"_ warning per call; the detected `v3` / `v4` defaults avoid it.

## Usage

### Cogitator Agent as AI SDK Model

```typescript
import { generateText, streamText } from 'ai';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { cogitatorModel } from '@cogitator-ai/ai-sdk';
import { z } from 'zod';

const cog = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});

const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: [`Result for: ${query}`] }),
});

const researcher = new Agent({
  name: 'researcher',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You are a research assistant.',
  tools: [searchTool],
});

// spec detected from the installed ai package (ai@4 – ai@7)
const { text } = await generateText({
  model: cogitatorModel(cog, researcher),
  prompt: 'Research the latest AI developments',
});

// explicit override
const result = streamText({
  model: cogitatorModel(cog, researcher, { specificationVersion: 'v2' }),
  prompt: 'Write an article about TypeScript',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

With **ai@4** the same call returns a `LanguageModelV1`; `{ specificationVersion: 'v1' }` forces it explicitly.

#### How the agent maps to a model

- The agent runs its whole loop (LLM calls **and its own tool calls**) inside one model call. The result's `finishReason` is `'stop'`, unless the run waits for tool approvals (below).
- The agent's tool calls are reported as **provider-executed** tool calls with their results (`result.toolCalls` / `result.toolResults`, `tool-call` / `tool-result` stream parts). The AI SDK never executes them again.
  - With `v3` / `v4` models they are always reported.
  - With `v2` models they are reported only for tools you also pass in `tools` (ai@5 cannot handle provider-executed calls of undeclared tools).
  - Every model also lists them in `providerMetadata.cogitator.toolCalls`, together with `runId`, `threadId`, `agentId`, `model`, `cost` and `duration`.
- User and assistant text of the prompt is forwarded as the agent input (multi-turn prompts become a `User:` / `Assistant:` transcript). System messages, files and images are not forwarded — the agent's `instructions` are its system prompt — and the AI SDK reports a warning.
- `temperature`, `topP`, `maxOutputTokens` (`maxTokens` on ai@4) and `stopSequences` override the agent settings for the call; `abortSignal` cancels the run, as does cancelling the stream.
- The `reasoning` call option of `v4` models (ai@7) overrides the effort of the agent's `reasoning` for the call. An agent with `reasoning: { summary: true }` returns its summary as `reasoning` content (`reasoning-start` / `reasoning-delta` / `reasoning-end` stream parts, `reasoning` text on ai@4), and usage carries its reasoning and cached input tokens.
- JSON response formats (`generateObject`, `Output.object`, ai@4 `object-json` / `object-tool` modes) switch the agent to JSON mode and append the schema to the input.
- AI SDK `tools` the agent does not own cannot be called by the agent; the model reports a warning for each of them.
- When the agent calls a tool that needs approval (`requiresApproval`), its run pauses and the call never passes for an answer. `v3` and `v4` models (ai@6, ai@7) end the turn with `finishReason: 'tool-calls'` and a `tool-approval-request` for each waiting call (a provider-executed `tool-call` comes with it). Answer with a `tool-approval-response` (`providerExecuted: true`, which `convertToModelMessages` sets for UI messages) as the last message of the next prompt and the run resumes: approved calls run, denied ones are declined with your `reason`. `v1` and `v2` models cannot ask, so they finish with `finishReason: 'other'` and a warning, and `providerMetadata.cogitator` holds `status: 'paused'`, the `threadId` and `pendingApprovals` to resume with `cogitator.resume(agent, threadId, { decisions })`.

```typescript
const paused = await generateText({ model: cogitatorModel(cog, agent), prompt: 'Refund A-1' });
const request = paused.content.find((part) => part.type === 'tool-approval-request');

if (request?.type === 'tool-approval-request') {
  const done = await generateText({
    model: cogitatorModel(cog, agent),
    messages: [
      { role: 'user', content: 'Refund A-1' },
      ...paused.response.messages,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: request.approvalId,
            approved: true,
            providerExecuted: true,
          },
        ],
      },
    ],
  });
}
```

### Named Agents

```typescript
import { createCogitatorProvider } from '@cogitator-ai/ai-sdk';

const provider = createCogitatorProvider(cog, {
  agents: [researcher, writer],
  specificationVersion: 'v2', // optional, detected from the installed ai package
});

const model = provider('researcher', { temperature: 0.5 });
const sameModel = provider.languageModel('researcher');
```

### AI SDK Models in Cogitator

`fromAISDK()` wraps any AI SDK language model — `LanguageModelV1` (ai@4 providers) through `LanguageModelV4` (ai@7 providers) — as a Cogitator `LLMBackend`:

```typescript
import { google } from '@ai-sdk/google';
import { fromAISDK } from '@cogitator-ai/ai-sdk';

const backend = fromAISDK(google('gemini-3.5-flash-lite'));

const messages = [
  { role: 'system' as const, content: 'Be brief.' },
  { role: 'user' as const, content: 'Write a haiku about programming' },
];

const response = await backend.chat({ model: 'gemini-3.5-flash-lite', messages });

for await (const chunk of backend.chatStream({ model: 'gemini-3.5-flash-lite', messages })) {
  process.stdout.write(chunk.delta.content ?? '');
}
```

The backend converts Cogitator messages (text, images, assistant tool calls and tool results), tools, `toolChoice`, `responseFormat`, sampling settings and the abort signal to the model's specification, and maps text, reasoning, tool calls, finish reasons and usage (including cached, cache-write and reasoning tokens) back: reasoning content and stream parts become `ChatResponse.reasoning` / `delta.reasoning`. `ChatRequest.reasoning.effort` is sent as the `reasoning` call option of `v4` models (`max` as `xhigh`); older specifications have no provider-neutral reasoning setting, so configure effort, budgets and summaries on the AI SDK provider model (its `providerOptions` or settings). Gemini thought signatures on tool calls are preserved across turns.

To run Cogitator agents on an AI SDK model, register the backend under a name in `llm.backends` and point agents at it with `name/model`:

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: { backends: { gemini: fromAISDK(google('gemini-3.5-flash-lite')) } },
});

const agent = new Agent({
  name: 'writer',
  model: 'gemini/gemini-3.5-flash-lite',
  instructions: 'You write short poems.',
});

const result = await cog.run(agent, { input: 'A haiku about types' });
```

Tools, memory, streaming and every other run feature work as with built-in providers. The wrapped model is used whatever model name the request carries; cost is reported only for models the price registry knows.

### Tool Conversion

```typescript
import { tool as aiTool } from 'ai';
import { tool as cogTool } from '@cogitator-ai/core';
import { fromAISDKTool, toAISDKTool, convertToolsToAISDK } from '@cogitator-ai/ai-sdk';
import { z } from 'zod';

// AI SDK tool → Cogitator tool (ai@5+ `inputSchema` or ai@4 `parameters`)
const aiWeather = aiTool({
  description: 'Get weather for a city',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ temp: 20, city }),
});
const cogWeather = fromAISDKTool(aiWeather, 'weather');

// Cogitator tool → AI SDK tool (works with the `tools` option of ai@4 – ai@7)
const cogCalculator = cogTool({
  name: 'calculator',
  description: 'Perform calculations',
  parameters: z.object({ expression: z.string() }),
  execute: async ({ expression }) => ({ result: evaluate(expression) }),
});
const aiCalculator = toAISDKTool(cogCalculator);
const aiTools = convertToolsToAISDK([cogCalculator]);
```

`toAISDKTool()` returns a tool with both schema fields:

- `inputSchema` (read by ai@5 – ai@7) — the Cogitator tool's zod schema
- `parameters` (read by ai@4) — an AI SDK `Schema` with draft-07 JSON Schema and synchronous validation; it is also a Standard JSON Schema

`execute(input, options)` maps the AI SDK options to a Cogitator `ToolContext`: `toolCallId` becomes `runId`, `abortSignal` becomes `signal`, and string fields `agentId`, `runId`, `threadId`, `userId`, `channelType`, `channelId` of the tool context (`context` on ai@7, `experimental_context` on ai@5 / ai@6) are copied over.

Approval flags survive both ways: `toAISDKTool()` sets `needsApproval` from `requiresApproval`, so ai@6 and ai@7 ask before running the tool, and `fromAISDKTool()` sets `requiresApproval` from `needsApproval`, so a Cogitator run pauses (a `needsApproval` function that answers with a promise counts as "needs approval").

`fromAISDKTool()` accepts zod 4 schemas, Standard JSON Schemas, `jsonSchema()` / `zodSchema()` schemas from any AI SDK major and plain JSON Schema objects. Non-zod schemas are converted to JSON Schema and validated before the AI SDK `execute` runs. It also resolves ai@7 dynamic descriptions and the final value of streaming (`async function*`) `execute` functions, and passes the Cogitator context to the AI SDK tool as `context` / `experimental_context`. Zod 3 schemas cannot be converted to JSON Schema here — wrap them with `zodSchema()` from `ai`.

## API Reference

### `cogitatorModel(cogitator, agent, options?)`

```typescript
function cogitatorModel<V extends CogitatorSpecificationVersion = DefaultSpecificationVersion>(
  cogitator: Cogitator,
  agent: Agent,
  options?: CogitatorModelOptions<V>
): CogitatorLanguageModel<V>;

type CogitatorSpecificationVersion = 'v1' | 'v2' | 'v3' | 'v4';

// 'v1' | 'v2' | 'v3' | 'v4', derived from the installed ai package's LanguageModel type
type DefaultSpecificationVersion;

interface CogitatorModelOptions<V> {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  specificationVersion?: V;
}
```

`CogitatorLanguageModel<'v1'>` is a `LanguageModelV1`; `'v2'`, `'v3'`, `'v4'` return `CogitatorLanguageModelV2` / `V3` / `V4`, which satisfy `LanguageModelV2` / `V3` / `V4` of every `@ai-sdk/provider` release.

### `createCogitatorProvider(cogitator, config)`

```typescript
function createCogitatorProvider<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
>(cogitator: Cogitator, config: CogitatorProviderConfig<V>): CogitatorProvider<V>;

interface CogitatorProviderConfig<V> {
  agents: Agent[] | Map<string, Agent> | Record<string, Agent>;
  specificationVersion?: V;
}
```

### `fromAISDK(model)` / `new AISDKBackend(model)`

```typescript
function fromAISDK(model: AISDKLanguageModel): LLMBackend;

type AISDKLanguageModel = LanguageModelV1 | LanguageModelV2 | LanguageModelV3 | LanguageModelV4;
```

### Tools

```typescript
function fromAISDKTool<TParams, TResult>(
  aiTool: AISDKToolLike,
  toolName?: string
): Tool<TParams, TResult>;
function toAISDKTool<TParams, TResult>(
  cogTool: Tool<TParams, TResult>
): AISDKTool<TParams, TResult>;
function convertToolsFromAISDK(aiTools: Record<string, AISDKToolLike>): Tool[];
function convertToolsToAISDK(cogTools: Tool[]): Record<string, AISDKTool>;
```

## Migrating from 0.2.x

- `cogitatorModel()` and `createCogitatorProvider()` detect the installed `ai` major and return the matching model spec (`v1` on ai@4, as before); `specificationVersion` overrides it.
- Agent tool calls are no longer reported as client tool calls with `finishReason: 'tool-calls'` (which made the AI SDK execute them again or fail with `NoSuchToolError`); see [How the agent maps to a model](#how-the-agent-maps-to-a-model).
- `toAISDKTool()` now emits `inputSchema` (ai@5+) next to `parameters` (ai@4).
- `fromAISDK()` accepts `LanguageModelV1` – `LanguageModelV4` and forwards tool calls and tool results as structured prompt parts instead of flattened text.

## Documentation

- [AI SDK integration guide](https://cogitator.app/docs/integrations/ai-sdk)
- [LLM backends](https://cogitator.app/docs/core/llm-backends)

## License

MIT
