# @cogitator-ai/core

Core runtime for Cogitator AI agents. Build and run LLM-powered agents with tool calling, streaming, reflection, Tree-of-Thought reasoning, learning optimization, and time-travel debugging.

## Installation

```bash
pnpm add @cogitator-ai/core zod
```

Optional peer dependencies, installed only for the features that use them:

| Package                           | Needed for                                                      |
| --------------------------------- | --------------------------------------------------------------- |
| `@aws-sdk/client-bedrock-runtime` | `BedrockBackend` (`bedrock/...` models)                         |
| `@cogitator-ai/sandbox`           | Tools with `sandbox: { type: 'docker' \| 'wasm' }`              |
| `pg`                              | `sqlQuery` / `vectorSearch` on PostgreSQL, `PostgresTraceStore` |
| `better-sqlite3`                  | `sqlQuery` on SQLite                                            |
| `nodemailer`                      | `sendEmail` over SMTP                                           |
| `langfuse`                        | `LangfuseExporter`                                              |

Full documentation: [cogitator.app/docs](https://cogitator.app/docs) — start with [Agents](https://cogitator.app/docs/core/agents) and [Cogitator](https://cogitator.app/docs/core/cogitator).

## Quick Start

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string(),
  }),
  execute: async ({ expression }) => {
    return { result: eval(expression) };
  },
});

const agent = new Agent({
  name: 'math-assistant',
  instructions: 'You are a helpful math assistant',
  model: 'openai/gpt-6.1-sol',
  tools: [calculator],
});

const cog = new Cogitator({
  llm: {
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});
const result = await cog.run(agent, {
  input: 'What is 25 * 4?',
});

console.log(result.output);
```

## Features

- **Multi-Provider LLM Support** - Ollama, OpenAI, Anthropic, Google, Azure OpenAI, Bedrock, vLLM, Mistral, Groq, Together, DeepSeek
- **Type-Safe Tools** - Zod-validated tool definitions, `toolset()` for typed tool tuples
- **Streaming Responses** - Real-time token and reasoning streaming
- **Structured Output** - `responseFormat` with a Zod schema, validated and repaired once on mismatch
- **Handoffs & Approvals** - Pass a conversation to another agent; pause runs for human approval and resume them later
- **Prompt Versions & A/B Tests** - Versioned instructions per agent with `cog.prompts`
- **Memory Integration** - In-memory, Redis, PostgreSQL, SQLite, MongoDB and Qdrant adapters
- **26 Built-in Tools** - Web search, SQL, email, GitHub, filesystem, and more
- **Reflection Engine** - Self-improvement through tool call analysis
- **Tree-of-Thought** - Advanced reasoning with branch exploration
- **Agent Optimizer** - DSPy-style learning from traces
- **Time Travel** - Checkpoint, replay, fork, and compare executions
- **Causal Reasoning** - Pearl's do-calculus, counterfactuals, d-separation
- **Resilience** - Retry, circuit breaker, and fallback patterns
- **PII Masking** - Personal data and secrets replaced with placeholders before they reach the provider
- **Observability** - Full tracing with spans and callbacks

---

## LLM Backends

### Supported Providers

```typescript
const agent = new Agent({
  name: 'assistant',
  instructions: 'You are helpful.',

  // Ollama (local, default backend when no provider prefix is present)
  model: 'ollama/llama3.1:8b',

  // Cloud providers use the same provider/model format:
  // model: 'openai/gpt-6.1-sol'
  // model: 'anthropic/claude-sonnet-5-5'
  // model: 'google/gemini-3.8-flash'
  // model: 'vllm/mistral-7b'
});
```

### Backend Configuration

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      ollama: {
        baseUrl: 'http://localhost:11434',
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY!,
      },
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
      google: {
        apiKey: process.env.GOOGLE_API_KEY!,
      },
      vllm: {
        baseUrl: 'http://localhost:8000/v1',
      },
    },
  },
});
```

The runtime does not read provider keys from the environment: pass them under `providers` (or build the config with `loadConfig()` from `@cogitator-ai/config`, which reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the rest). Ollama defaults to `http://localhost:11434`. A model string without a known provider prefix runs on `llm.defaultProvider` (Ollama when unset). An agent without `model` uses `llm.defaultModel`. `llm.backends` registers backends of your own by name (`model: 'my-backend/some-model'`), and `llm.retry` (2 retries with exponential backoff by default, `false` to disable) applies to every backend the runtime creates. Azure (`endpoint`, `apiKey`, `apiVersion`, `deployment`), Bedrock (`region`, credentials) and Mistral / Groq / Together / DeepSeek (`apiKey`) are configured the same way under `providers`.

See [LLM Backends](https://cogitator.app/docs/core/llm-backends) for every provider's options.

### Provider Notes

- **OpenAI** — the official backend uses the Responses API and defaults to `gpt-6.1-sol`. Requests are stateless (`store: false`); reasoning items are round-tripped between tool-call turns via `ToolCall.replay`. Reasoning models (o-series, GPT-5+) get no `temperature` / `top_p` and, on Chat Completions, `max_completion_tokens`. Requests with stop sequences fall back to Chat Completions (the Responses API has no stop parameter). OpenAI-compatible providers (Azure, Mistral, Groq, Together, DeepSeek, vLLM, custom `baseUrl`) stay on Chat Completions. Force either path with `providers.openai.api: 'responses' | 'chat-completions'`. Usage includes `cachedInputTokens` and `reasoningTokens` when reported.
- **Azure** — a deployment serving a reasoning model gets no `temperature` / `top_p` and `max_completion_tokens`, told by its name (`azure/gpt-5`) or by `providers.azure.model` when the name is your own. `apiVersion` defaults to `2025-04-01-preview`.
- **Anthropic** — defaults to `claude-sonnet-5-5`. Sampling params are omitted for Claude 4.7+, 5.x and Fable (they reject non-default values); Claude 4.0 – 4.6 get at most one of `temperature` / `top_p` (`temperature` wins). `json_schema` uses native structured outputs on Claude 4.5+. Forced tool choice falls back to `auto` with a system-prompt instruction and a one-time warning on Opus/Sonnet 5.5 and Fable.
- **Bedrock** — Claude models follow the same sampling and tool-choice rules; `json_object` and `json_schema` response formats are supported (schema enforced via `outputConfig.textFormat` on Claude 4.5 – 4.6, system-prompt instruction otherwise).
- **Google** — Gemini has no `null` schema type, so `.nullable()` fields in response schemas and tool parameters are sent as `nullable: true`.

### Direct Backend Usage

```typescript
import { createLLMBackend, parseModel } from '@cogitator-ai/core';

const { provider, model } = parseModel('openai/gpt-6.1-sol'); // { provider: 'openai', model: 'gpt-6.1-sol' }

const backend = createLLMBackend(provider ?? 'ollama', {
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
});

const response = await backend.chat({
  model,
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' },
  ],
});
```

`response.finishReason` is the same for every provider: `stop`, `tool_calls`, `length`, `content_filter`, `refusal` or `error`. Only a `tool_calls` turn runs tools: a finished turn with complete tool calls is one even when the provider reported `stop` (vLLM, LM Studio and other OpenAI-compatible servers do for forced tools), and a turn cut at the token limit, filtered or refused carries no tool calls, so a call cut off mid-arguments never runs with partial or empty ones. A finished turn whose streamed tool arguments are not valid JSON fails with `LLM_INVALID_RESPONSE`. The built-in backends settle each turn with `normalizeTurn()`, and the runtime applies it to every turn, backends of your own included.

### LLM Plugin System

Register custom LLM backends:

```typescript
import { registerLLMBackend, defineBackend, createLLMBackendFromPlugin } from '@cogitator-ai/core';

const myPlugin = defineBackend({
  provider: 'my-provider',
  metadata: {
    name: 'My Custom Provider',
    version: '1.0.0',
    description: 'Custom LLM backend',
  },
  create: (config) => new MyBackend(config),
});

registerLLMBackend(myPlugin);
const backend = createLLMBackendFromPlugin('my-provider', { apiKey: '...' });
```

A backend's `provider` field is an `LLMBackendProvider`: a built-in provider name or one of your own, such as the plugin's provider or its key in `llm.backends`.

`cog.route(model)` returns the backend and model name a run would use, and `cog.knowsProvider(name)` tells whether a `name/...` model prefix routes to that provider (a backend in `llm.backends`, a built-in provider or a registered plugin) or stays part of the model name on `llm.defaultProvider`.

### LLM Debug Wrapper

Wrap any backend for request/response logging:

```typescript
import { withDebug } from '@cogitator-ai/core';

const debugBackend = withDebug(backend, {
  logStream: true,
  maxContentLength: 500,
});
```

### LLM Error Handling

```typescript
import { LLMError } from '@cogitator-ai/core';

try {
  await backend.chat(request);
} catch (error) {
  if (error instanceof LLMError) {
    console.log('Provider:', error.provider, error.model);
    console.log('Code:', error.code); // ErrorCode, e.g. LLM_RATE_LIMITED
    console.log('HTTP status from the provider:', error.details?.statusCode);
    console.log('Retryable:', error.retryable, 'after', error.retryAfter, 'ms');
  }
}
```

`error.message` always carries what the provider said (`[openai] Bad request: Unsupported parameter: ...`). `LLM_CONTEXT_LENGTH_EXCEEDED` is reported only for the providers' own context overflow errors, not for any bad request that mentions tokens, and Bedrock errors are classified by their AWS exception name and HTTP status.

`llmUnavailable`, `llmTimeout`, `llmInvalidResponse`, `llmConfigError` and `wrapSDKError` build these errors in your own backends, and `providerErrorIn` reads the error a router such as OpenRouter puts in the body of a successful response; `withLLMRetry(backend, options)` / `RetryingBackend` add retries with `Retry-After` support to any backend.

---

## Agent Configuration

```typescript
import { Agent, calculator, webSearch } from '@cogitator-ai/core';

const agent = new Agent({
  id: 'custom-id',
  name: 'research-assistant',
  instructions: 'You research topics thoroughly',
  model: 'openai/gpt-6.1-sol',
  tools: [webSearch, calculator],

  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  maxIterations: 15,
  onIterationLimit: 'answer', // when tools use up maxIterations: one more turn without tools
  timeout: 120_000,
  stopSequences: ['DONE'],
  // responseFormat, reasoning, handoffs, skills, description are covered below
});

// Clone with modifications
const variant = agent.clone({
  name: 'fast-assistant',
  temperature: 0.3,
  maxTokens: 1024,
});
```

### Skills and Serialization

A skill bundles tools with the instructions for using them; `skills` merges them into the agent:

```typescript
import { Agent, defineSkill, httpRequest, ToolRegistry } from '@cogitator-ai/core';

const apiSkill = defineSkill({
  name: 'http-api',
  version: '1.0.0',
  description: 'Call JSON APIs',
  tools: [httpRequest],
  instructions: 'Prefer GET requests and summarize responses.',
  env: ['API_TOKEN'], // checked by validateSkill()
});

const agent = new Agent({
  name: 'integrator',
  model: 'openai/gpt-5.5',
  instructions: 'Answer with data from the API.',
  skills: [apiSkill],
});

const snapshot = agent.serialize(); // plain JSON; tools are stored by name
const registry = new ToolRegistry();
registry.register(httpRequest);
const restored = Agent.deserialize(snapshot, { toolRegistry: registry });
```

To run an agent in another process (queue jobs, workflow jobs, distributed swarm turns), send it in the agent wire format instead: `toAgentWire(agent)` keeps every setting (stop sequences, timeout, handoffs, the response schema as JSON Schema, ...) and `fromAgentWire(payload, { cogitator, tools })` rebuilds it, refusing unknown keys and routing the model exactly as the sender would. `toAgentWireRunResult` / `fromAgentWireRunResult` do the same for a run's outcome, cost included.

See [Agents](https://cogitator.app/docs/core/agents).

### Structured Output

`responseFormat` asks the model for JSON. With a Zod schema the answer is validated and parsed into `result.structured`:

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { z } from 'zod';

const Weather = z.object({ city: z.string(), celsius: z.number() });

const extractor = new Agent({
  name: 'extractor',
  model: 'openai/gpt-5.5',
  instructions: 'Extract the weather report.',
  responseFormat: { type: 'json_schema', schema: Weather }, // or { type: 'json' } for any JSON
});

const cog = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const result = await cog.run(extractor, { input: 'Paris, 21 degrees' });
const weather = Weather.parse(result.structured);
```

When the final answer does not fit the schema, the run asks the model once more with the validation problem (for example `celsius: expected number, received string`) and does not save the rejected answer to the thread; if the retry fails too, `structured` is `undefined` and `structuredError` says why. Streamed runs keep the first answer, since the client has already seen it. JSON wrapped in prose or code fences is still read. See [Structured Outputs](https://cogitator.app/docs/core/structured-outputs).

### Reasoning and Prompt Caching

`reasoning` sets how hard a reasoning model thinks, in one vocabulary for every provider (Anthropic adaptive thinking and effort, OpenAI `reasoning.effort`, Gemini thinking levels or budgets, Ollama `think`), and can ask for a readable summary:

```typescript
const analyst = new Agent({
  name: 'analyst',
  model: 'anthropic/claude-opus-5-5',
  instructions: 'Explain the numbers.',
  reasoning: { effort: 'high', summary: true }, // none | minimal | low | medium | high | xhigh | max
});

const result = await cog.run(analyst, {
  input,
  stream: true,
  onReasoning: (d) => process.stdout.write(d),
});
result.reasoning; // the summary
result.usage.reasoningTokens; // billed as output
```

Reasoning that has to travel with tool calls (Claude thinking blocks, OpenAI reasoning items, Gemini thought signatures) is sent back while the agent works through a tool loop.

Runs cache their prompt by default: Anthropic and Bedrock requests mark their stable prefix, OpenAI and Gemini cache on their own, and `usage.cachedInputTokens` / `cacheWriteTokens` are priced at the model's cache prices (1-hour writes, `cacheWrite1hTokens`, at their own price). `llm.promptCache: { ttl: '1h' }` or `false` changes it.

---

## Tools

### Creating Tools

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  execute: async ({ city, units = 'celsius' }, context) => {
    console.log(`Run ID: ${context.runId}`);
    return { temperature: 22, units, city };
  },
});
```

`tool()` also takes `category`, `tags`, `sideEffects`, `requiresApproval`, `timeout` and `sandbox`. A parameter with `.default()` is optional in the JSON Schema the model sees; `execute` receives the default when the model leaves it out. Tools passed to `new Agent({ tools })` lose their individual parameter types in a plain array; `toolset(...tools)` keeps them as a typed tuple that agents still accept:

```typescript
import { tool, toolset } from '@cogitator-ai/core';
import { z } from 'zod';

function createSearchTools() {
  return toolset(
    tool({
      name: 'search',
      description: 'Search the catalog',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ hits: [query] }),
    }),
    tool({
      name: 'fetch_item',
      description: 'Fetch one item',
      parameters: z.object({ id: z.number() }),
      execute: async ({ id }) => ({ id }),
    })
  );
}

const [search, fetchItem] = createSearchTools();
await search.execute({ query: 'lamp' }, ctx); // typed as { query: string }
```

A result object with a base64 image in `image` or `imageBase64` (PNG, JPEG, GIF or WebP, plain or as a `data:` URL) reaches the model as an image, with the rest of the result as JSON, so a vision model sees a screenshot instead of its base64 text. Anthropic, Bedrock and the OpenAI Responses API get the image inside the tool result, Google after the turn's function responses, Ollama in the tool message's `images`, and Chat Completions backends (OpenAI-compatible, Azure) in a user message after the turn's tool messages:

```typescript
const screenshot = tool({
  name: 'screenshot',
  description: 'Capture the dashboard as a PNG',
  parameters: z.object({}),
  execute: async () => ({ page: 'dashboard', image: (await capture()).toString('base64') }),
});
```

See [Tools](https://cogitator.app/docs/core/tools) and [Custom Tools](https://cogitator.app/docs/tools/custom-tools).

### Handoffs

`handoffs` lets an agent pass the conversation to another one: each target becomes a `transfer_to_<name>` tool, and the rest of the run goes on as the target — its instructions, tools and model — with the whole conversation:

```typescript
const triage = new Agent({
  name: 'triage',
  model: 'openai/gpt-5.5',
  instructions: 'Hand the customer to the right specialist.',
  handoffs: [billing, techSupport],
});

const result = await cog.run(triage, { input: 'How much do I owe on INV-204?' });
result.handoffs; // [{ from: 'triage', to: 'billing', reason }]
result.finalAgent; // 'billing'
```

A handoff can also be `{ agent, toolName, description }` to name the tool or describe when to use it. `onHandoff` on the run options reports each switch as it happens.

### Approvals

A tool with `requiresApproval` (`true` or a function of its arguments) never runs without a person's decision. Decide inline with `onApproval`, or let the run pause and resume it later:

```typescript
const result = await cog.run(agent, { input: 'Refund order A-1', threadId, userId });

if (result.status === 'paused') {
  // result.pendingApprovals: [{ toolCallId, toolName, arguments, description }]
  const done = await cog.resume(agent, threadId, {
    userId,
    decisions: { [result.pendingApprovals![0].toolCallId]: { approved: true } },
  });
}
```

Nothing of the paused turn runs until every call in it is decided. Paused runs live in the thread's memory (or process memory, or your `runCheckpoints` store), so a resume can come after a restart; a new message on the thread instead declines the waiting calls.

`cog.resume()` takes the thread id or the returned `result.checkpoint`; `defaultDecision` answers every call `decisions` leaves out. To decide while the run waits, pass `onApproval: (request) => ({ approved: true })` (or return `'pause'`) to `cog.run()`. See [Tool Approvals](https://cogitator.app/docs/tools/approvals).

### PII Masking

`security.pii` replaces emails, phones, card numbers (Luhn-checked), IBANs, SSNs, IP addresses, API keys and your own patterns with placeholders before every LLM request, so the provider never sees them:

```typescript
const cog = new Cogitator({
  security: {
    pii: {
      mode: 'mask', // 'redact' keeps placeholders in the answer, 'block' rejects such input
      custom: [{ type: 'customer_id', pattern: /CUS-\d{6}/ }],
      onDetect: (counts) => audit.log(counts), // { email: 1 } — never the values
    },
  },
});
```

In `mask` mode the answer, its stream and tool call arguments get the real values back, so `send_email({ to: '[EMAIL_1]' })` reaches the tool as the real address. `detect` limits the built-in kinds (`PII_TYPES`: `email`, `phone`, `credit_card`, `iban`, `ssn`, `ip_address`, `api_key`). `PiiMasker`, `PiiVault` and `withPiiMasking` work outside a run too. See [Security](https://cogitator.app/docs/advanced/security).

### Tool Context

Every tool receives a context object:

```typescript
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal; // aborted on run cancel or tool timeout
  threadId?: string;
  userId?: string; // the run's userId
  channelType?: string;
  channelId?: string;
}
```

### Sandboxed Tools

Execute tools in isolated Docker or WASM environments:

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const shellTool = tool({
  name: 'run_shell',
  description: 'Execute shell commands safely',
  parameters: z.object({
    command: z.string(),
  }),
  sandbox: {
    type: 'docker',
    image: 'ubuntu:22.04',
  },
  timeout: 30000,
  execute: async ({ command }) => command,
});
```

A Docker-sandboxed tool does not call `execute`: the sandbox runs the `command` argument with `sh -c` (plus optional `cwd` / `env` arguments) and returns its output. A WASM tool gets its arguments as JSON on stdin and its JSON stdout is parsed as the result. Sandboxing needs `@cogitator-ai/sandbox` installed (options go in `new Cogitator({ sandbox })`).

When Docker is unavailable (or `@cogitator-ai/sandbox` is missing), a Docker-sandboxed tool runs its command directly on the host with a warning; set `sandbox.allowNativeFallback: false` to make those calls fail instead. WASM tools never fall back to the host: they run their own `execute` only when `@cogitator-ai/sandbox` is missing or fails to start, and a WASM sandbox that cannot load the module returns an error. Each Docker execution gets a fresh container (the pool keeps them warm); `sandbox.pool.reuseContainers: true` reuses containers between executions with the same settings, which is faster but lets files and processes leak from one execution to the next.

`timeout` is enforced for every tool: native tools get an aborted `context.signal` and the model receives a `Tool "<name>" timed out after <ms>ms` error; sandboxed tools forward it to the sandbox executor. The sandbox is initialized lazily on the first sandboxed call, and that call already runs inside it.

### Tool Registry

```typescript
import { ToolRegistry } from '@cogitator-ai/core';

const registry = new ToolRegistry();

registry.register(calculator);
registry.registerMany([datetime, webSearch, fileRead]);

const tool = registry.get('calculator');
const names = registry.getNames();
const schemas = registry.getSchemas();
```

### Built-in Tools

#### Utility Tools

| Tool            | Description                      |
| --------------- | -------------------------------- |
| `calculator`    | Evaluate math expressions        |
| `datetime`      | Get current date/time            |
| `uuid`          | Generate UUIDs                   |
| `randomNumber`  | Random number generation         |
| `randomString`  | Random string generation         |
| `hash`          | Hash strings (md5, sha256, etc.) |
| `base64Encode`  | Encode to base64                 |
| `base64Decode`  | Decode from base64               |
| `sleep`         | Delay execution                  |
| `jsonParse`     | Parse JSON strings               |
| `jsonStringify` | Stringify to JSON                |
| `regexMatch`    | Match regex patterns             |
| `regexReplace`  | Replace with regex               |
| `fileRead`      | Read file contents               |
| `fileWrite`     | Write to files                   |
| `fileList`      | List directory contents          |
| `fileExists`    | Check if file exists             |
| `fileDelete`    | Delete files                     |
| `httpRequest`   | Make HTTP requests               |
| `exec`          | Execute shell commands           |

#### Web & Search Tools

| Tool        | Description                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `webSearch` | Search the web or news (Tavily, Brave, Serper) with date, domain, country and language filters |
| `webScrape` | Extract content from web pages                                                                 |

#### Database Tools

| Tool           | Description                                |
| -------------- | ------------------------------------------ |
| `sqlQuery`     | Execute SQL queries (PostgreSQL, SQLite)   |
| `vectorSearch` | Semantic search with embeddings (pgvector) |

#### Communication Tools

| Tool        | Description                    |
| ----------- | ------------------------------ |
| `sendEmail` | Send emails (Resend API, SMTP) |

#### Development Tools

| Tool        | Description                                      |
| ----------- | ------------------------------------------------ |
| `githubApi` | GitHub API (issues, PRs, files, commits, search) |

#### Multimodal Tool Factories

Not part of `builtinTools`. `createAnalyzeImageTool` takes an `llm` backend; the other three call the OpenAI API (`apiKey` or `OPENAI_API_KEY`).

| Factory                     | Tool              | Default model                                                                                                                                                                       |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAnalyzeImageTool`    | `analyzeImage`    | `gpt-6.1-sol` (`defaultModel`) on the backend you pass in                                                                                                                           |
| `createGenerateImageTool`   | `generateImage`   | `gpt-image-2.5-flare`; returns `imageBase64` (`url` only from legacy `dall-e-*` endpoints). `size` / `quality` default to `auto`; legacy `standard` / `hd` map to `medium` / `high` |
| `createTranscribeAudioTool` | `transcribeAudio` | `gpt-transcribe`; `whisper-1` when word timestamps are requested without an explicit model                                                                                          |
| `createGenerateSpeechTool`  | `generateSpeech`  | `gpt-4o-mini-tts`                                                                                                                                                                   |

```typescript
import { Agent, builtinTools } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'utility-agent',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-6.1-sol',
  tools: builtinTools, // Tool[]
});
```

#### Assistant Tool Factories

Also not in `builtinTools`, these build tools around your own stores. `createMemoryTools` and `createSchedulerTools` return typed tuples (see `toolset()`), so destructured tools keep their parameter types:

| Factory                                                                                                        | Tools                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `createMemoryTools({ graphAdapter, agentId, coreFacts?, embeddingFn? })`                                       | `remember`, `recall`, `forget` on a knowledge graph                               |
| `createSchedulerTools({ store, defaultChannel?, defaultUserId? })`                                             | `schedule_task`, `list_tasks`, `cancel_task` on a `TimerStore`                    |
| `createDeviceTools()`, `createCapabilitiesTool(doc)`, `createSelfTools({ toolsDir })` / `loadCustomTools(dir)` | Device info, a capabilities description, and tools an agent writes to a directory |

### Web Search Tool

Search the web using Tavily, Brave, or Serper APIs:

```typescript
import { Agent, webSearch } from '@cogitator-ai/core';

// Auto-detects from TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY
const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [webSearch],
});

// Or specify provider explicitly in tool call
// provider: 'tavily' | 'brave' | 'serper'
```

### Web Scrape Tool

Extract content from web pages:

```typescript
import { Agent, webScrape } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [webScrape],
});

// Supports simple selectors (tag, .class, #id), text/markdown/html output, link/image extraction
```

### SQL Query Tool

Execute SQL queries against PostgreSQL or SQLite:

```typescript
import { Agent, sqlQuery } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [sqlQuery],
});

// Uses DATABASE_URL env var by default
// Supports parameterized queries for safety
// Read-only by default (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN)
```

Read-only queries on PostgreSQL run inside `BEGIN TRANSACTION READ ONLY` (always rolled back), so writes hidden in functions are rejected by the database. SQLite opens the file with `readonly: true`. With `readOnly: false`, row-less statements return `rows: []` and the affected row count in `rowCount`.

**Dependencies:** `pg` for PostgreSQL, `better-sqlite3` for SQLite

### Vector Search Tool

Semantic search using embeddings with pgvector:

```typescript
import { Agent, vectorSearch } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [vectorSearch],
});

// Embedding providers: OpenAI, Ollama, Google
// Auto-detects from OPENAI_API_KEY, OLLAMA_BASE_URL / OLLAMA_URL / OLLAMA_HOST, or GOOGLE_API_KEY
// Default models: text-embedding-3-small, nomic-embed-text, gemini-embedding-001
```

**Dependencies:** `pg` with pgvector extension

### Email Tool

Send emails via Resend API or SMTP:

```typescript
import { Agent, sendEmail } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [sendEmail],
});

// Resend: Set RESEND_API_KEY
// SMTP: Set SMTP_HOST, SMTP_USER, SMTP_PASS
// Supports HTML, CC/BCC, reply-to
```

**Dependencies:** `nodemailer` for SMTP

### GitHub API Tool

Interact with GitHub repositories:

```typescript
import { Agent, githubApi } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [githubApi],
});

// Set GITHUB_TOKEN env var
// Actions: get_repo, list_issues, get_issue, create_issue, update_issue,
//          list_prs, get_pr, create_pr, get_file, list_commits,
//          search_code, search_issues
```

---

## Run Options

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const agent = new Agent({
  name: 'analyst',
  instructions: 'Analyze data.',
  model: 'openai/gpt-5.5',
});
const controller = new AbortController();

const result = await cog.run(agent, {
  input: 'Analyze this data...',
  images: ['https://example.com/chart.png'],
  audio: [{ data: base64Wav, format: 'wav' }],

  threadId: 'thread_123',
  userId: 'user_456', // owns the thread, scopes memory, reaches tools as context.userId
  threadAccess: 'owner', // default; 'shared' lets any user continue the thread
  context: { task: 'analysis' }, // extra values for the system prompt

  timeout: 60000,
  signal: controller.signal,
  stream: true,
  onToken: (token) => process.stdout.write(token),
  onReasoning: (delta) => process.stdout.write(delta),
  reasoning: { effort: 'low' }, // overrides the agent's reasoning for this run

  useMemory: true,
  loadHistory: true,
  saveHistory: true,
  parallelToolCalls: false, // default: tool calls of one turn run one after another

  onApproval: (request) => ({ approved: request.toolName !== 'delete_account' }),
  onHandoff: (handoff) => console.log(`${handoff.from} -> ${handoff.to}`),
  onToolCall: (call) => console.log('Tool:', call.name),
  onToolResult: (result) => console.log('Result:', result.result),
  onSpan: (span) => console.log('Span:', span.name),
  onRunStart: ({ runId }) => console.log('Started:', runId),
  onRunComplete: (result) => console.log('Completed'),
  onRunError: (error) => console.error('Error:', error),
  onMemoryError: (error, op) => console.warn(`Memory ${op} failed`),
});
```

`audio` inputs are transcribed with OpenAI `gpt-transcribe` (`llm.providers.openai.apiKey` or `OPENAI_API_KEY`) and prepended to `input` before guardrails and prompt-injection checks run. History loaded from memory is repaired before it is sent: tool results without their assistant call and tool calls without results are dropped, so a truncated window never produces an invalid provider request.

### Run Result

```typescript
interface RunResult {
  output: string;
  structured?: unknown; // parsed output when the agent has a responseFormat
  runId: string;
  agentId: string;
  threadId: string;
  modelUsed?: string; // differs from agent.model when cost routing picked another
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
  reasoning?: string; // reasoning summary, with reasoning.summary
  truncated?: boolean; // the last answer stopped at maxTokens
  blocked?: 'content_filter' | 'refusal'; // the last answer was filtered or refused
  prompt?: RunPrompt; // versioned instructions / A/B variant used
  handoffs?: HandoffEvent[];
  finalAgent?: string;
  status?: 'completed' | 'paused';
  pendingApprovals?: ToolApprovalRequest[];
  checkpoint?: RunCheckpoint; // pass to cog.resume()
  toolCalls: ToolCall[];
  messages: Message[];
  trace: { traceId: string; spans: Span[] };
  reflections?: Reflection[];
  reflectionSummary?: ReflectionSummary;
}
```

All fields are `readonly`. The run timeout comes from the run, the agent, `limits.defaultTimeout`, or 120 s.

A run whose last answer the provider withheld still completes, with `blocked` saying why: `content_filter` when its safety system filtered the answer (OpenAI and Azure `content_filter`, Gemini `SAFETY` and the like, Bedrock guardrails), `refusal` when the model declined (OpenAI `refusal`, Anthropic `refusal`). `output` holds what the model said before it stopped, the explanation of a refusal or often nothing, and the run does not ask again.

---

## Memory Integration

Configure memory for conversation persistence:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'redis',
    redis: {
      url: 'redis://localhost:6379',
      keyPrefix: 'cogitator:',
    },
    contextBuilder: {
      maxTokens: 4000,
      strategy: 'recent',
    },
  },
});

// Or PostgreSQL
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: {
      connectionString: 'postgresql://...',
    },
  },
});

// Or in-memory
const cog = new Cogitator({
  memory: {
    adapter: 'memory',
    inMemory: {
      maxEntries: 1000,
    },
  },
});
```

`adapter` also accepts `'sqlite'` (`sqlite.path`), `'mongodb'` (`mongodb.uri`) and `'redis'` (`redis.url`, or `redis.host` + `redis.port`, or `redis.cluster`). Qdrant stores embeddings, not threads: configure it in `memory.qdrant` next to a thread adapter, together with `memory.embedding` and `memory.contextBuilder.includeSemanticContext`, and semantic context is retrieved from it. The Postgres adapter sizes its vector column to the `memory.embedding` model. Runs with a `threadId` load history from and save messages to the adapter.

The adapter connects on the first run. To read threads before that (for example in an API route), use `getMemory()`, which connects it on first use; `cog.memory` stays `undefined` until something connected it:

```typescript
import { unwrap } from '@cogitator-ai/memory';

const memory = await cog.getMemory(); // undefined when memory is not configured
if (memory) {
  const entries = unwrap(await memory.getEntries({ threadId: 'thread_123', limit: 20 }));
}
```

See [Memory](https://cogitator.app/docs/memory) and [Memory Adapters](https://cogitator.app/docs/memory/adapters).

---

## Reflection Engine

Enable self-improvement through reflection on tool calls and runs:

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator({
  reflection: {
    enabled: true,
    reflectionModel: 'openai/gpt-6-luna',
    reflectAfterToolCall: true,
    reflectAtEnd: true,
    minConfidenceToStore: 0.7,
    maxInsightsPerAgent: 50,
  },
});

const result = await cog.run(agent, { input: 'Complete this task...' });

console.log('Reflections:', result.reflections);
console.log('Summary:', result.reflectionSummary);

const insights = await cog.getInsights(agent.id);
console.log('Learned insights:', insights);
```

### Standalone Reflection Engine

```typescript
import { ReflectionEngine, InMemoryInsightStore, createLLMBackend } from '@cogitator-ai/core';

const backend = createLLMBackend('openai', {
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
});
const insightStore = new InMemoryInsightStore();

const engine = new ReflectionEngine({
  llm: backend,
  insightStore,
  config: {
    enabled: true,
    reflectAfterToolCall: true,
    minConfidenceToStore: 0.7,
  },
});

const result = await engine.reflectOnToolCall(action, agentContext);
if (result.shouldAdjustStrategy) {
  console.log('Suggested action:', result.suggestedAction);
}
```

`reflectOnError`, `reflectOnRun`, `getRelevantInsights` and `getSummary(agentId)` cover the other stages. See [Reflection](https://cogitator.app/docs/advanced/reflection).

---

## Tree-of-Thought Reasoning

Explore multiple reasoning paths before deciding:

```typescript
import { ThoughtTreeExecutor } from '@cogitator-ai/core';

const executor = new ThoughtTreeExecutor(cog, {
  branchFactor: 3,
  maxDepth: 3,
  explorationStrategy: 'best-first',
  confidenceThreshold: 0.3,
});

const result = await executor.explore(agent, 'Solve this complex problem...', {
  timeout: 60_000,
  onProgress: (stats) => console.log('Explored:', stats.exploredNodes),
});

console.log('Answer:', result.output);
console.log(
  'Best path:',
  result.bestPath.map((node) => node.branch.thought)
);
console.log('Nodes in tree:', result.tree.nodes.size);
console.log('Stats:', result.stats);
```

### ToT Configuration

Every field is optional; defaults are in `DEFAULT_TOT_CONFIG`:

```typescript
const executor = new ThoughtTreeExecutor(cog, {
  branchFactor: 3, // branches generated per node
  beamWidth: 2, // best candidates queued per expanded node
  maxDepth: 5,
  explorationStrategy: 'beam', // 'beam' | 'best-first' | 'dfs'
  confidenceThreshold: 0.3, // prune branches scored below
  terminationConfidence: 0.8, // stop once a branch reaches this
  maxTotalNodes: 50, // executed nodes
  maxIterationsPerBranch: 3, // iteration cap for each branch run
  onBranchEvaluated: (branch, score) => console.log(branch.thought, score.composite),
});
```

Candidates beyond `beamWidth` stay pending, so a failed branch backtracks to the next best one. `beam` runs the tree level by level, `best-first` always runs the node whose own branch scored highest, and `dfs` goes deep first. The executor's own generation, evaluation and synthesis calls use the agent's routed model and count into `usage` (tokens and cost) and `stats`. See [Tree-of-Thought](https://cogitator.app/docs/advanced/reasoning).

---

## Agent Optimizer (Learning)

DSPy-style optimization through execution traces:

```typescript
import { AgentOptimizer, InMemoryTraceStore } from '@cogitator-ai/core';

const traceStore = new InMemoryTraceStore();
const optimizer = new AgentOptimizer({
  llm: cog.getLLMBackend('openai/gpt-6.1-sol'),
  model: 'gpt-6.1-sol',
  traceStore,
  cogitator: cog,
});

const result = await optimizer.compile(
  agent,
  [
    { input: 'Calculate 2+2', expected: '4' },
    { input: 'Calculate 10*5', expected: '50' },
  ],
  { maxRounds: 3 }
);

console.log('Optimized instructions:', result.instructionsAfter);
console.log('Score:', result.scoreBefore, '→', result.scoreAfter);
```

With `cogitator`, `compile()` runs the trainset with the original agent (those runs score it and become demo candidates) and again with the optimized instructions, so `scoreAfter` is measured. Without it, `compile()` works on the traces already stored and `scoreAfter` is the instruction optimizer's estimate.

### Built-in Metrics

```typescript
import {
  createSuccessMetric,
  createExactMatchMetric,
  createContainsMetric,
} from '@cogitator-ai/core';

const successMetric = createSuccessMetric(); // 1 when no tool call failed
const exactMatch = createExactMatchMetric(); // compares the output (or a field path) with `expected`
const containsMetric = createContainsMetric(['refund', 'order']); // share of keywords found, passes at >= 0.5
```

Each is a `MetricFn` (`(trace, expected?) => MetricResult`); `MetricEvaluator` combines built-in and custom metrics, including LLM-judged ones.

### Demo Selection

```typescript
import { DemoSelector, InMemoryTraceStore } from '@cogitator-ai/core';

const selector = new DemoSelector({
  traceStore: new InMemoryTraceStore(),
  maxDemos: 5, // per agent (default 10)
  minScore: 0.8, // traces scoring lower are not used as demos
  diversityWeight: 0.3,
});

await selector.addDemo(trace);
const demos = await selector.selectDemos(agent.id, currentInput, 3);
const fewShot = selector.formatDemosForPrompt(demos);
```

See [Learning](https://cogitator.app/docs/advanced/learning).

---

## Prompt Auto-Optimization

Capture prompts, run A/B tests, monitor performance, and automatically optimize agent instructions.

### Prompt Versions

`cog.prompts` versions an agent's instructions on top of the ones in code. A deployed version is used by every following run of that agent, and each run's outcome is recorded against the version (or A/B variant) it used:

```typescript
const v2 = await cog.prompts.deploy(writer, 'You write release notes. Lead with what changed.');

const result = await cog.run(writer, { input, threadId });
result.prompt; // { key: 'writer', versionId: v2.id, version: 2 }

await cog.prompts.rollbackTo(writer); // previous version, recorded as a new one
await cog.prompts.history(writer); // newest first, with metrics

await cog.prompts.startABTest(writer, {
  name: 'shorter notes',
  treatment: 'You write release notes in at most five bullet points.',
  treatmentAllocation: 0.3, // share of threads
  minSampleSize: 50,
});
```

Versions are kept per agent `id` when set, else per `name`. They live in process memory unless `new Cogitator({ prompts: { versions, abTests } })` gets durable stores (`PostgresTraceStore` provides both via `instructionVersions()` and `abTests()`); `prompts.score` scores runs (default: 1 for a completed run) and `prompts.autoDeployWinner` deploys a significant A/B winner. See [Prompt Versions](https://cogitator.app/docs/advanced/prompt-versions).

The classes below are the building blocks `cog.prompts` uses, available for your own pipelines.

### Prompt Logger

Wrap any LLM backend to capture all prompts:

```typescript
import { wrapWithPromptLogger, PostgresTraceStore } from '@cogitator-ai/core';

const store = new PostgresTraceStore({
  connectionString: process.env.DATABASE_URL!,
});

await store.connect();

const wrappedBackend = wrapWithPromptLogger(openaiBackend, store, {
  captureContent: true,
  captureTools: true,
});

wrappedBackend.setContext({ runId, agentId: agent.id, threadId });
```

### A/B Testing Framework

Test instruction variants with statistical analysis:

```typescript
import { ABTestingFramework } from '@cogitator-ai/core';

const abTesting = new ABTestingFramework({
  store: abTestStore,
  defaultConfidenceLevel: 0.95,
  defaultMinSampleSize: 50,
});

const test = await abTesting.createTest({
  agentId: 'agent-1',
  name: 'Instruction Experiment',
  controlInstructions: 'You are a helpful assistant.',
  treatmentInstructions: 'You are an expert assistant. Be concise.',
  treatmentAllocation: 0.5,
});

await abTesting.startTest(test.id);

const variant = abTesting.selectVariant(test);
const instructions = abTesting.getInstructionsForVariant(test, variant);

await abTesting.recordResult(test.id, variant, score, latency, cost);

const { test: completed, outcome } = await abTesting.completeTest(test.id);
console.log('Winner:', outcome.winner);
console.log('p-value:', outcome.pValue);
console.log('Effect size:', outcome.effectSize);
```

### Prompt Monitor

Real-time performance monitoring with degradation detection:

```typescript
import { PromptMonitor } from '@cogitator-ai/core';

const monitor = new PromptMonitor({
  windowSize: 60 * 60 * 1000,
  scoreDropThreshold: 0.15,
  latencySpikeThreshold: 2.0,
  errorRateThreshold: 0.1,
  enableAutoRollback: true,
  onAlert: (alert) => {
    console.log(`Alert: ${alert.type} (${alert.severity})`);
  },
});

const alerts = monitor.recordExecution(trace);

const metrics = monitor.getCurrentMetrics('agent-1'); // null before any execution
console.log('Avg score:', metrics?.avgScore);
console.log('P95 latency:', metrics?.p95Latency);
```

### Rollback Manager

Version control for agent instructions:

```typescript
import { RollbackManager } from '@cogitator-ai/core';

const rollback = new RollbackManager({ store: versionStore });

const version = await rollback.deployVersion(
  'agent-1',
  'New optimized instructions',
  'optimization',
  'opt-run-123'
);

const result = await rollback.rollbackToPrevious('agent-1');
if (result.success) {
  console.log('Rolled back to version:', result.previousVersion?.version);
}

const history = await rollback.getVersionHistory('agent-1', 10);
```

### Auto-Optimizer

Automated optimization pipeline with A/B testing and rollback:

```typescript
import { AutoOptimizer } from '@cogitator-ai/core';

const optimizer = new AutoOptimizer({
  enabled: true,
  triggerAfterRuns: 100,
  minRunsForOptimization: 20,
  requireABTest: true,
  maxOptimizationsPerDay: 3,
  agentOptimizer,
  abTesting,
  monitor,
  rollbackManager,
  onOptimizationComplete: (run) => {
    console.log('Optimization completed:', run.status);
  },
  onRollback: (agentId, reason) => {
    console.log('Rollback triggered:', reason);
  },
});

await optimizer.recordExecution(trace);
```

It optimizes the agent's deployed version, so deploy one first. To serve its A/B tests on live traffic, give `new Cogitator({ prompts: { abTests, versions } })` the same stores as `abTesting` and `rollbackManager` and the agent an explicit `id`: the Cogitator then assigns variants per thread and records the results, traces carry the variant (`trace.prompt`) so the optimizer does not count them twice, and the optimizer deploys the winner (leave `prompts.autoDeployWinner` off). `PostgresTraceStore` backs all of it: `traces()` for `AgentOptimizer`, `abTests()` and `instructionVersions()` for the rest. See [Learning](https://cogitator.app/docs/advanced/learning#ab-tests-on-live-traffic).

---

## Time Travel Debugging

Checkpoint, replay, fork, and compare agent executions:

```typescript
import { TimeTravel, InMemoryCheckpointStore } from '@cogitator-ai/core';

const timeTravel = new TimeTravel(cogitator);

const result = await cogitator.run(agent, { input: 'Original task...' });
const checkpoints = await timeTravel.checkpointAll(result, 'original'); // one per tool call

const replayResult = await timeTravel.replayLive(agent, checkpoints[2].id);
console.log('Replayed from the third tool call:', replayResult.output);

const forkResult = await timeTravel.fork(agent, checkpoints[2].id, {
  input: 'Modified task...',
});
console.log('Forked result:', forkResult.result.output);

const diff = await timeTravel.compareWithOriginal(forkResult.result);
console.log(timeTravel.formatDiff(diff));
```

### Forking Variants

```typescript
const forkWithContext = await timeTravel.forkWithContext(
  agent,
  checkpointId,
  'Additional context: the user is an expert'
);

const forkWithMock = await timeTravel.forkWithMockedTool(agent, checkpointId, 'api_call', {
  status: 'success',
  data: 'mocked data',
});

const forkWithMocks = await timeTravel.forkWithMockedTools(agent, checkpointId, {
  api_call: { status: 'success' },
  database_query: { rows: [] },
});

const forkWithNewInput = await timeTravel.forkWithNewInput(
  agent,
  checkpointId,
  'Completely different task...'
);

const variants = await timeTravel.forkMultiple(agent, checkpointId, [
  { input: 'Variant A' },
  { input: 'Variant B' },
  { additionalContext: 'Be more concise' },
]);
```

### Replay Modes

```typescript
const deterministicReplay = await timeTravel.replayDeterministic(agent, checkpointId);

const liveReplay = await timeTravel.replayLive(agent, checkpointId, {
  skipTools: ['send_email'],
  modifiedToolResults: { web_search: { results: [] } },
});
```

Checkpoints are anchored on tool calls: checkpoint `i` holds the conversation after `i` tool calls, stopping before the result of the call it is anchored on. `stepsReplayed` is that index, `stepsExecuted` counts the replay's tool calls, and `divergedAt` uses the original run's numbering. Mocked tool results are keyed by tool name (in deterministic replays also by call id): the tool answers with the given value and never runs. Tools in `skipTools` are removed from the replayed agent. Checkpoints, replays and forks store their traces in the trace store, so `compare()` and `compareWithOriginal()` can read them.

---

## Causal Reasoning

Full causal reasoning framework implementing Pearl's Ladder of Causation:

- **Level 1 (Association)**: Observational queries P(Y|X)
- **Level 2 (Intervention)**: do-calculus P(Y|do(X))
- **Level 3 (Counterfactual)**: "What if" queries P(Y_x|X', Y')

### Building Causal Graphs

```typescript
import { CausalGraphBuilder, CausalInferenceEngine } from '@cogitator-ai/core';

const graph = CausalGraphBuilder.create('medical-study')
  .treatment('X', 'Drug Treatment')
  .outcome('Y', 'Recovery')
  .confounder('Z', 'Age')
  .from('Z')
  .causes('X')
  .from('Z')
  .causes('Y')
  .from('X')
  .causes('Y', { strength: 0.8 })
  .build();

const engine = new CausalInferenceEngine(graph);
```

### Effect Identification

```typescript
const identifiable = engine.isIdentifiable('X', 'Y');
if (identifiable.identifiable) {
  console.log('Effect is identifiable:', identifiable.reason); // e.g. backdoor criterion
  console.log('Adjustment set:', identifiable.adjustmentSet?.variables);
}
```

### Interventional Queries

```typescript
const effect = engine.computeInterventionalEffect({
  target: 'Y',
  interventions: { X: 1 },
  conditions: { Z: 0.5 },
});

console.log('Expected effect:', effect.effect);
console.log('Formula:', effect.formula, 'identifiable:', effect.isIdentifiable);
```

### Counterfactual Reasoning

```typescript
import { evaluateCounterfactual } from '@cogitator-ai/core';

const result = evaluateCounterfactual(graph, {
  target: 'Y',
  intervention: { X: 1 },
  factual: { X: 0, Y: 0.2 },
  question: 'What would Y be if X was 1?',
});

console.log('Factual value:', result.factualValue);
console.log('Counterfactual value:', result.counterfactualValue);
```

Counterfactuals use the nodes' structural equations (`withEquation()` on the builder): `linear`, `logistic`, `polynomial`, or `custom` with a safe arithmetic expression over the parent ids in `customFn` (`'2 * price - log(demand)'`; `+ - * / ^`, parentheses, `abs exp log sqrt pow min max tanh sigmoid`). Nodes without an equation keep their factual values.

### D-Separation Analysis

```typescript
import { dSeparation, findBackdoorAdjustment } from '@cogitator-ai/core';

const separated = dSeparation(graph, 'X', 'Y', ['Z']);
console.log('D-separated:', separated.separated);

const backdoor = findBackdoorAdjustment(graph, 'X', 'Y');
if (backdoor?.isValid) {
  console.log('Backdoor adjustment set:', backdoor.variables);
}
```

### Causal Discovery from Traces

```typescript
import { CausalExtractor, CausalHypothesisGenerator } from '@cogitator-ai/core';

const extractor = new CausalExtractor({ llmBackend: backend });

const { nodes, edges } = await extractor.extractFromToolResult(
  { id: 'call_1', name: 'database_query', arguments: { table: 'users' } },
  { rows: 100, cached: true },
  { taskDescription: 'Count active users' },
  graph
);

const generator = new CausalHypothesisGenerator({ llmBackend: backend });
const hypotheses = await generator.generateFromFailure(trace, { agentId: 'agent-1' });
```

`CausalReasoner` ties these together for agents (`predictEffect`, `explainCause`, `planForGoal`, `evaluateToolCall`, `analyzeErrorCausally`). See [Causal Reasoning](https://cogitator.app/docs/advanced/causal-reasoning).

---

## Error Handling & Resilience

### Retrying LLM Calls

Agent runs retry failed LLM calls on their own: rate limits, 5xx, timeouts and dropped connections, with exponential backoff and the provider's `Retry-After`. Streams are retried only before the first chunk. Tune or turn this off with `llm.retry`:

```typescript
import { Cogitator, GoogleBackend, withLLMRetry } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    retry: { maxRetries: 3, maxRetryAfter: 30_000, onRetry: (e) => console.warn(e) },
    // retry: false — no retries
  },
});

// A backend used on its own
const backend = withLLMRetry(new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! }), {
  maxRetries: 3,
});
```

### Retry with Backoff

```typescript
import { withRetry, retryable } from '@cogitator-ai/core';

const result = await withRetry(() => unreliableApiCall(), {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential',
  jitter: 0.1,
  onRetry: (error, attempt, delay) => {
    console.log(`Retry ${attempt} after ${delay}ms: ${error.message}`);
  },
});

const retryableFetch = retryable(fetch, { maxRetries: 3 });
const response = await retryableFetch('https://api.example.com');
```

### Circuit Breaker

```typescript
import { CircuitBreaker, CircuitBreakerRegistry } from '@cogitator-ai/core';

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenRequests: 3,
  onStateChange: (from, to) => console.log(`Circuit ${from} -> ${to}`),
});

// Throws CIRCUIT_OPEN while open; counts successes and failures (by default only retryable errors, see isFailure)
const result = await breaker.execute(() => riskyOperation());

console.log(breaker.getState(), breaker.getStats());

const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });
const apiBreaker = registry.get('payments-api');
```

### Fallback Patterns

```typescript
import {
  CircuitBreakerRegistry,
  withFallback,
  withGracefulDegradation,
  createLLMFallbackExecutor,
} from '@cogitator-ai/core';

const result = await withFallback({
  primary: () => primaryCall(),
  fallbacks: [
    { name: 'secondary', fn: () => fallbackCall() },
    { name: 'cache', fn: () => cachedResult() },
  ],
  retry: { maxRetries: 2 },
  onFallback: (from, to, error) => console.warn(`${from} -> ${to}: ${error.message}`),
});

const degraded = await withGracefulDegradation(() => fullFeatureCall(), {
  defaultValue: [],
  onDegraded: (error) => console.warn('Degraded:', error.message),
});

const executeWithFallback = createLLMFallbackExecutor(
  {
    providers: [
      { provider: 'openai', model: 'gpt-6.1-sol' },
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { provider: 'ollama', model: 'llama3.3:70b' },
    ],
  },
  new CircuitBreakerRegistry()
);
const response = await executeWithFallback((provider, model) =>
  cog.getLLMBackend(`${provider}/${model}`).chat({ model, messages })
);
```

---

## Prompt Injection Detection

Protect your agents from jailbreak attempts, prompt injections, and other adversarial inputs. See [Security](https://cogitator.app/docs/advanced/security).

```typescript
import { Cogitator, PromptInjectionDetector } from '@cogitator-ai/core';

// Standalone usage
const detector = new PromptInjectionDetector({
  detectInjection: true, // "Ignore previous instructions..."
  detectJailbreak: true, // DAN, developer mode attacks
  detectRoleplay: true, // Malicious roleplay scenarios
  detectEncoding: true, // Base64, hex encoded attacks
  detectContextManipulation: true, // [SYSTEM], <|im_start|> injections
  classifier: 'local', // 'local' (fast) or 'llm' (accurate)
  action: 'block', // 'block' | 'warn' | 'log'
  threshold: 0.7,
});

const result = await detector.analyze('Ignore all previous instructions and...');
// { safe: false, threats: [...], action: 'blocked', analysisTime: 2 }

// Integrated with Cogitator runtime
const cog = new Cogitator({
  security: {
    promptInjection: {
      detectInjection: true,
      detectJailbreak: true,
      action: 'block',
      threshold: 0.7,
    },
  },
});

// Throws a CogitatorError with code PROMPT_INJECTION_DETECTED when an attack is found
await cog.run(agent, { input: userInput });
```

### Detection Types

| Type                   | Examples                                              |
| ---------------------- | ----------------------------------------------------- |
| `direct_injection`     | "Ignore previous instructions", "Your new prompt is"  |
| `jailbreak`            | DAN prompts, "developer mode enabled", "unrestricted" |
| `roleplay`             | "Pretend you are evil AI", "From now on you are"      |
| `encoding`             | Base64 payloads, hex escape sequences, unicode tricks |
| `context_manipulation` | `[SYSTEM]:`, `<\|im_start\|>`, markdown role markers  |

### Custom Patterns & Allowlist

```typescript
const detector = new PromptInjectionDetector({
  action: 'block',
  patterns: [/secret\s+backdoor/i], // Custom regex patterns
  allowlist: ['ignore the previous search'], // Legitimate phrases
});

// Dynamic updates
detector.addPattern(/company\s+specific\s+attack/i);
detector.addToAllowlist('ignore previous results');
```

### LLM-Based Classification

For higher accuracy with complex attacks:

```typescript
const detector = new PromptInjectionDetector({
  classifier: 'llm',
  llmBackend: openaiBackend,
  llmModel: 'gpt-6-luna',
  action: 'block',
});
```

Inside `Cogitator` (`security.promptInjection`), omit `llmBackend` and pass a `provider/model` id as `llmModel`; without `llmModel` the classifier uses the running agent's model.

### Statistics & Callbacks

```typescript
const detector = new PromptInjectionDetector({
  action: 'block',
  onThreat: (result, input) => {
    console.log('Attack detected:', result.threats);
    logToSecurity(input, result);
  },
});

await detector.analyze('...');
const stats = detector.getStats();
// { analyzed: 100, blocked: 5, warned: 0, allowRate: 0.95 }
```

---

## Polite Crawling (robots.txt)

`RobotsPolicy` reads and caches a site's robots.txt and answers whether a URL may be fetched, by RFC 9309: the groups that name your product token (else `*`), longest match wins with `*` and `# @cogitator-ai/core

Core runtime for Cogitator AI agents. Build and run LLM-powered agents with tool calling, streaming, reflection, Tree-of-Thought reasoning, learning optimization, and time-travel debugging.

## Installation

```bash
pnpm add @cogitator-ai/core zod
```

Optional peer dependencies, installed only for the features that use them:

| Package                           | Needed for                                                      |
| --------------------------------- | --------------------------------------------------------------- |
| `@aws-sdk/client-bedrock-runtime` | `BedrockBackend` (`bedrock/...` models)                         |
| `@cogitator-ai/sandbox`           | Tools with `sandbox: { type: 'docker' \| 'wasm' }`              |
| `pg`                              | `sqlQuery` / `vectorSearch` on PostgreSQL, `PostgresTraceStore` |
| `better-sqlite3`                  | `sqlQuery` on SQLite                                            |
| `nodemailer`                      | `sendEmail` over SMTP                                           |
| `langfuse`                        | `LangfuseExporter`                                              |

Full documentation: [cogitator.app/docs](https://cogitator.app/docs) — start with [Agents](https://cogitator.app/docs/core/agents) and [Cogitator](https://cogitator.app/docs/core/cogitator).

## Quick Start

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string(),
  }),
  execute: async ({ expression }) => {
    return { result: eval(expression) };
  },
});

const agent = new Agent({
  name: 'math-assistant',
  instructions: 'You are a helpful math assistant',
  model: 'openai/gpt-6.1-sol',
  tools: [calculator],
});

const cog = new Cogitator({
  llm: {
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});
const result = await cog.run(agent, {
  input: 'What is 25 * 4?',
});

console.log(result.output);
```

## Features

- **Multi-Provider LLM Support** - Ollama, OpenAI, Anthropic, Google, Azure OpenAI, Bedrock, vLLM, Mistral, Groq, Together, DeepSeek
- **Type-Safe Tools** - Zod-validated tool definitions, `toolset()` for typed tool tuples
- **Streaming Responses** - Real-time token and reasoning streaming
- **Structured Output** - `responseFormat` with a Zod schema, validated and repaired once on mismatch
- **Handoffs & Approvals** - Pass a conversation to another agent; pause runs for human approval and resume them later
- **Prompt Versions & A/B Tests** - Versioned instructions per agent with `cog.prompts`
- **Memory Integration** - In-memory, Redis, PostgreSQL, SQLite, MongoDB and Qdrant adapters
- **26 Built-in Tools** - Web search, SQL, email, GitHub, filesystem, and more
- **Reflection Engine** - Self-improvement through tool call analysis
- **Tree-of-Thought** - Advanced reasoning with branch exploration
- **Agent Optimizer** - DSPy-style learning from traces
- **Time Travel** - Checkpoint, replay, fork, and compare executions
- **Causal Reasoning** - Pearl's do-calculus, counterfactuals, d-separation
- **Resilience** - Retry, circuit breaker, and fallback patterns
- **PII Masking** - Personal data and secrets replaced with placeholders before they reach the provider
- **Observability** - Full tracing with spans and callbacks

---

## LLM Backends

### Supported Providers

```typescript
const agent = new Agent({
  name: 'assistant',
  instructions: 'You are helpful.',

  // Ollama (local, default backend when no provider prefix is present)
  model: 'ollama/llama3.1:8b',

  // Cloud providers use the same provider/model format:
  // model: 'openai/gpt-6.1-sol'
  // model: 'anthropic/claude-sonnet-5-5'
  // model: 'google/gemini-3.8-flash'
  // model: 'vllm/mistral-7b'
});
```

### Backend Configuration

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      ollama: {
        baseUrl: 'http://localhost:11434',
      },
      openai: {
        apiKey: process.env.OPENAI_API_KEY!,
      },
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
      google: {
        apiKey: process.env.GOOGLE_API_KEY!,
      },
      vllm: {
        baseUrl: 'http://localhost:8000/v1',
      },
    },
  },
});
```

The runtime does not read provider keys from the environment: pass them under `providers` (or build the config with `loadConfig()` from `@cogitator-ai/config`, which reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the rest). Ollama defaults to `http://localhost:11434`. A model string without a known provider prefix runs on `llm.defaultProvider` (Ollama when unset). An agent without `model` uses `llm.defaultModel`. `llm.backends` registers backends of your own by name (`model: 'my-backend/some-model'`), and `llm.retry` (2 retries with exponential backoff by default, `false` to disable) applies to every backend the runtime creates. Azure (`endpoint`, `apiKey`, `apiVersion`, `deployment`), Bedrock (`region`, credentials) and Mistral / Groq / Together / DeepSeek (`apiKey`) are configured the same way under `providers`.

See [LLM Backends](https://cogitator.app/docs/core/llm-backends) for every provider's options.

### Provider Notes

- **OpenAI** — the official backend uses the Responses API and defaults to `gpt-6.1-sol`. Requests are stateless (`store: false`); reasoning items are round-tripped between tool-call turns via `ToolCall.replay`. Reasoning models (o-series, GPT-5+) get no `temperature` / `top_p` and, on Chat Completions, `max_completion_tokens`. Requests with stop sequences fall back to Chat Completions (the Responses API has no stop parameter). OpenAI-compatible providers (Azure, Mistral, Groq, Together, DeepSeek, vLLM, custom `baseUrl`) stay on Chat Completions. Force either path with `providers.openai.api: 'responses' | 'chat-completions'`. Usage includes `cachedInputTokens` and `reasoningTokens` when reported.
- **Azure** — a deployment serving a reasoning model gets no `temperature` / `top_p` and `max_completion_tokens`, told by its name (`azure/gpt-5`) or by `providers.azure.model` when the name is your own. `apiVersion` defaults to `2025-04-01-preview`.
- **Anthropic** — defaults to `claude-sonnet-5-5`. Sampling params are omitted for Claude 4.7+, 5.x and Fable (they reject non-default values); Claude 4.0 – 4.6 get at most one of `temperature` / `top_p` (`temperature` wins). `json_schema` uses native structured outputs on Claude 4.5+. Forced tool choice falls back to `auto` with a system-prompt instruction and a one-time warning on Opus/Sonnet 5.5 and Fable.
- **Bedrock** — Claude models follow the same sampling and tool-choice rules; `json_object` and `json_schema` response formats are supported (schema enforced via `outputConfig.textFormat` on Claude 4.5 – 4.6, system-prompt instruction otherwise).
- **Google** — Gemini has no `null` schema type, so `.nullable()` fields in response schemas and tool parameters are sent as `nullable: true`.

### Direct Backend Usage

```typescript
import { createLLMBackend, parseModel } from '@cogitator-ai/core';

const { provider, model } = parseModel('openai/gpt-6.1-sol'); // { provider: 'openai', model: 'gpt-6.1-sol' }

const backend = createLLMBackend(provider ?? 'ollama', {
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
});

const response = await backend.chat({
  model,
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' },
  ],
});
```

`response.finishReason` is the same for every provider: `stop`, `tool_calls`, `length`, `content_filter`, `refusal` or `error`. Only a `tool_calls` turn runs tools: a finished turn with complete tool calls is one even when the provider reported `stop` (vLLM, LM Studio and other OpenAI-compatible servers do for forced tools), and a turn cut at the token limit, filtered or refused carries no tool calls, so a call cut off mid-arguments never runs with partial or empty ones. A finished turn whose streamed tool arguments are not valid JSON fails with `LLM_INVALID_RESPONSE`. The built-in backends settle each turn with `normalizeTurn()`, and the runtime applies it to every turn, backends of your own included.

### LLM Plugin System

Register custom LLM backends:

```typescript
import { registerLLMBackend, defineBackend, createLLMBackendFromPlugin } from '@cogitator-ai/core';

const myPlugin = defineBackend({
  provider: 'my-provider',
  metadata: {
    name: 'My Custom Provider',
    version: '1.0.0',
    description: 'Custom LLM backend',
  },
  create: (config) => new MyBackend(config),
});

registerLLMBackend(myPlugin);
const backend = createLLMBackendFromPlugin('my-provider', { apiKey: '...' });
```

A backend's `provider` field is an `LLMBackendProvider`: a built-in provider name or one of your own, such as the plugin's provider or its key in `llm.backends`.

`cog.route(model)` returns the backend and model name a run would use, and `cog.knowsProvider(name)` tells whether a `name/...` model prefix routes to that provider (a backend in `llm.backends`, a built-in provider or a registered plugin) or stays part of the model name on `llm.defaultProvider`.

### LLM Debug Wrapper

Wrap any backend for request/response logging:

```typescript
import { withDebug } from '@cogitator-ai/core';

const debugBackend = withDebug(backend, {
  logStream: true,
  maxContentLength: 500,
});
```

### LLM Error Handling

```typescript
import { LLMError } from '@cogitator-ai/core';

try {
  await backend.chat(request);
} catch (error) {
  if (error instanceof LLMError) {
    console.log('Provider:', error.provider, error.model);
    console.log('Code:', error.code); // ErrorCode, e.g. LLM_RATE_LIMITED
    console.log('HTTP status from the provider:', error.details?.statusCode);
    console.log('Retryable:', error.retryable, 'after', error.retryAfter, 'ms');
  }
}
```

`error.message` always carries what the provider said (`[openai] Bad request: Unsupported parameter: ...`). `LLM_CONTEXT_LENGTH_EXCEEDED` is reported only for the providers' own context overflow errors, not for any bad request that mentions tokens, and Bedrock errors are classified by their AWS exception name and HTTP status.

`llmUnavailable`, `llmTimeout`, `llmInvalidResponse`, `llmConfigError` and `wrapSDKError` build these errors in your own backends, and `providerErrorIn` reads the error a router such as OpenRouter puts in the body of a successful response; `withLLMRetry(backend, options)` / `RetryingBackend` add retries with `Retry-After` support to any backend.

---

## Agent Configuration

```typescript
import { Agent, calculator, webSearch } from '@cogitator-ai/core';

const agent = new Agent({
  id: 'custom-id',
  name: 'research-assistant',
  instructions: 'You research topics thoroughly',
  model: 'openai/gpt-6.1-sol',
  tools: [webSearch, calculator],

  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  maxIterations: 15,
  onIterationLimit: 'answer', // when tools use up maxIterations: one more turn without tools
  timeout: 120_000,
  stopSequences: ['DONE'],
  // responseFormat, reasoning, handoffs, skills, description are covered below
});

// Clone with modifications
const variant = agent.clone({
  name: 'fast-assistant',
  temperature: 0.3,
  maxTokens: 1024,
});
```

### Skills and Serialization

A skill bundles tools with the instructions for using them; `skills` merges them into the agent:

```typescript
import { Agent, defineSkill, httpRequest, ToolRegistry } from '@cogitator-ai/core';

const apiSkill = defineSkill({
  name: 'http-api',
  version: '1.0.0',
  description: 'Call JSON APIs',
  tools: [httpRequest],
  instructions: 'Prefer GET requests and summarize responses.',
  env: ['API_TOKEN'], // checked by validateSkill()
});

const agent = new Agent({
  name: 'integrator',
  model: 'openai/gpt-5.5',
  instructions: 'Answer with data from the API.',
  skills: [apiSkill],
});

const snapshot = agent.serialize(); // plain JSON; tools are stored by name
const registry = new ToolRegistry();
registry.register(httpRequest);
const restored = Agent.deserialize(snapshot, { toolRegistry: registry });
```

To run an agent in another process (queue jobs, workflow jobs, distributed swarm turns), send it in the agent wire format instead: `toAgentWire(agent)` keeps every setting (stop sequences, timeout, handoffs, the response schema as JSON Schema, ...) and `fromAgentWire(payload, { cogitator, tools })` rebuilds it, refusing unknown keys and routing the model exactly as the sender would. `toAgentWireRunResult` / `fromAgentWireRunResult` do the same for a run's outcome, cost included.

See [Agents](https://cogitator.app/docs/core/agents).

### Structured Output

`responseFormat` asks the model for JSON. With a Zod schema the answer is validated and parsed into `result.structured`:

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { z } from 'zod';

const Weather = z.object({ city: z.string(), celsius: z.number() });

const extractor = new Agent({
  name: 'extractor',
  model: 'openai/gpt-5.5',
  instructions: 'Extract the weather report.',
  responseFormat: { type: 'json_schema', schema: Weather }, // or { type: 'json' } for any JSON
});

const cog = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const result = await cog.run(extractor, { input: 'Paris, 21 degrees' });
const weather = Weather.parse(result.structured);
```

When the final answer does not fit the schema, the run asks the model once more with the validation problem (for example `celsius: expected number, received string`) and does not save the rejected answer to the thread; if the retry fails too, `structured` is `undefined` and `structuredError` says why. Streamed runs keep the first answer, since the client has already seen it. JSON wrapped in prose or code fences is still read. See [Structured Outputs](https://cogitator.app/docs/core/structured-outputs).

### Reasoning and Prompt Caching

`reasoning` sets how hard a reasoning model thinks, in one vocabulary for every provider (Anthropic adaptive thinking and effort, OpenAI `reasoning.effort`, Gemini thinking levels or budgets, Ollama `think`), and can ask for a readable summary:

```typescript
const analyst = new Agent({
  name: 'analyst',
  model: 'anthropic/claude-opus-5-5',
  instructions: 'Explain the numbers.',
  reasoning: { effort: 'high', summary: true }, // none | minimal | low | medium | high | xhigh | max
});

const result = await cog.run(analyst, {
  input,
  stream: true,
  onReasoning: (d) => process.stdout.write(d),
});
result.reasoning; // the summary
result.usage.reasoningTokens; // billed as output
```

Reasoning that has to travel with tool calls (Claude thinking blocks, OpenAI reasoning items, Gemini thought signatures) is sent back while the agent works through a tool loop.

Runs cache their prompt by default: Anthropic and Bedrock requests mark their stable prefix, OpenAI and Gemini cache on their own, and `usage.cachedInputTokens` / `cacheWriteTokens` are priced at the model's cache prices (1-hour writes, `cacheWrite1hTokens`, at their own price). `llm.promptCache: { ttl: '1h' }` or `false` changes it.

---

## Tools

### Creating Tools

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  execute: async ({ city, units = 'celsius' }, context) => {
    console.log(`Run ID: ${context.runId}`);
    return { temperature: 22, units, city };
  },
});
```

`tool()` also takes `category`, `tags`, `sideEffects`, `requiresApproval`, `timeout` and `sandbox`. A parameter with `.default()` is optional in the JSON Schema the model sees; `execute` receives the default when the model leaves it out. Tools passed to `new Agent({ tools })` lose their individual parameter types in a plain array; `toolset(...tools)` keeps them as a typed tuple that agents still accept:

```typescript
import { tool, toolset } from '@cogitator-ai/core';
import { z } from 'zod';

function createSearchTools() {
  return toolset(
    tool({
      name: 'search',
      description: 'Search the catalog',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ hits: [query] }),
    }),
    tool({
      name: 'fetch_item',
      description: 'Fetch one item',
      parameters: z.object({ id: z.number() }),
      execute: async ({ id }) => ({ id }),
    })
  );
}

const [search, fetchItem] = createSearchTools();
await search.execute({ query: 'lamp' }, ctx); // typed as { query: string }
```

A result object with a base64 image in `image` or `imageBase64` (PNG, JPEG, GIF or WebP, plain or as a `data:` URL) reaches the model as an image, with the rest of the result as JSON, so a vision model sees a screenshot instead of its base64 text. Anthropic, Bedrock and the OpenAI Responses API get the image inside the tool result, Google after the turn's function responses, Ollama in the tool message's `images`, and Chat Completions backends (OpenAI-compatible, Azure) in a user message after the turn's tool messages:

```typescript
const screenshot = tool({
  name: 'screenshot',
  description: 'Capture the dashboard as a PNG',
  parameters: z.object({}),
  execute: async () => ({ page: 'dashboard', image: (await capture()).toString('base64') }),
});
```

See [Tools](https://cogitator.app/docs/core/tools) and [Custom Tools](https://cogitator.app/docs/tools/custom-tools).

### Handoffs

`handoffs` lets an agent pass the conversation to another one: each target becomes a `transfer_to_<name>` tool, and the rest of the run goes on as the target — its instructions, tools and model — with the whole conversation:

```typescript
const triage = new Agent({
  name: 'triage',
  model: 'openai/gpt-5.5',
  instructions: 'Hand the customer to the right specialist.',
  handoffs: [billing, techSupport],
});

const result = await cog.run(triage, { input: 'How much do I owe on INV-204?' });
result.handoffs; // [{ from: 'triage', to: 'billing', reason }]
result.finalAgent; // 'billing'
```

A handoff can also be `{ agent, toolName, description }` to name the tool or describe when to use it. `onHandoff` on the run options reports each switch as it happens.

### Approvals

A tool with `requiresApproval` (`true` or a function of its arguments) never runs without a person's decision. Decide inline with `onApproval`, or let the run pause and resume it later:

```typescript
const result = await cog.run(agent, { input: 'Refund order A-1', threadId, userId });

if (result.status === 'paused') {
  // result.pendingApprovals: [{ toolCallId, toolName, arguments, description }]
  const done = await cog.resume(agent, threadId, {
    userId,
    decisions: { [result.pendingApprovals![0].toolCallId]: { approved: true } },
  });
}
```

Nothing of the paused turn runs until every call in it is decided. Paused runs live in the thread's memory (or process memory, or your `runCheckpoints` store), so a resume can come after a restart; a new message on the thread instead declines the waiting calls.

`cog.resume()` takes the thread id or the returned `result.checkpoint`; `defaultDecision` answers every call `decisions` leaves out. To decide while the run waits, pass `onApproval: (request) => ({ approved: true })` (or return `'pause'`) to `cog.run()`. See [Tool Approvals](https://cogitator.app/docs/tools/approvals).

### PII Masking

`security.pii` replaces emails, phones, card numbers (Luhn-checked), IBANs, SSNs, IP addresses, API keys and your own patterns with placeholders before every LLM request, so the provider never sees them:

```typescript
const cog = new Cogitator({
  security: {
    pii: {
      mode: 'mask', // 'redact' keeps placeholders in the answer, 'block' rejects such input
      custom: [{ type: 'customer_id', pattern: /CUS-\d{6}/ }],
      onDetect: (counts) => audit.log(counts), // { email: 1 } — never the values
    },
  },
});
```

In `mask` mode the answer, its stream and tool call arguments get the real values back, so `send_email({ to: '[EMAIL_1]' })` reaches the tool as the real address. `detect` limits the built-in kinds (`PII_TYPES`: `email`, `phone`, `credit_card`, `iban`, `ssn`, `ip_address`, `api_key`). `PiiMasker`, `PiiVault` and `withPiiMasking` work outside a run too. See [Security](https://cogitator.app/docs/advanced/security).

### Tool Context

Every tool receives a context object:

```typescript
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal; // aborted on run cancel or tool timeout
  threadId?: string;
  userId?: string; // the run's userId
  channelType?: string;
  channelId?: string;
}
```

### Sandboxed Tools

Execute tools in isolated Docker or WASM environments:

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const shellTool = tool({
  name: 'run_shell',
  description: 'Execute shell commands safely',
  parameters: z.object({
    command: z.string(),
  }),
  sandbox: {
    type: 'docker',
    image: 'ubuntu:22.04',
  },
  timeout: 30000,
  execute: async ({ command }) => command,
});
```

A Docker-sandboxed tool does not call `execute`: the sandbox runs the `command` argument with `sh -c` (plus optional `cwd` / `env` arguments) and returns its output. A WASM tool gets its arguments as JSON on stdin and its JSON stdout is parsed as the result. Sandboxing needs `@cogitator-ai/sandbox` installed (options go in `new Cogitator({ sandbox })`).

When Docker is unavailable (or `@cogitator-ai/sandbox` is missing), a Docker-sandboxed tool runs its command directly on the host with a warning; set `sandbox.allowNativeFallback: false` to make those calls fail instead. WASM tools never fall back to the host: they run their own `execute` only when `@cogitator-ai/sandbox` is missing or fails to start, and a WASM sandbox that cannot load the module returns an error. Each Docker execution gets a fresh container (the pool keeps them warm); `sandbox.pool.reuseContainers: true` reuses containers between executions with the same settings, which is faster but lets files and processes leak from one execution to the next.

`timeout` is enforced for every tool: native tools get an aborted `context.signal` and the model receives a `Tool "<name>" timed out after <ms>ms` error; sandboxed tools forward it to the sandbox executor. The sandbox is initialized lazily on the first sandboxed call, and that call already runs inside it.

### Tool Registry

```typescript
import { ToolRegistry } from '@cogitator-ai/core';

const registry = new ToolRegistry();

registry.register(calculator);
registry.registerMany([datetime, webSearch, fileRead]);

const tool = registry.get('calculator');
const names = registry.getNames();
const schemas = registry.getSchemas();
```

### Built-in Tools

#### Utility Tools

| Tool            | Description                      |
| --------------- | -------------------------------- |
| `calculator`    | Evaluate math expressions        |
| `datetime`      | Get current date/time            |
| `uuid`          | Generate UUIDs                   |
| `randomNumber`  | Random number generation         |
| `randomString`  | Random string generation         |
| `hash`          | Hash strings (md5, sha256, etc.) |
| `base64Encode`  | Encode to base64                 |
| `base64Decode`  | Decode from base64               |
| `sleep`         | Delay execution                  |
| `jsonParse`     | Parse JSON strings               |
| `jsonStringify` | Stringify to JSON                |
| `regexMatch`    | Match regex patterns             |
| `regexReplace`  | Replace with regex               |
| `fileRead`      | Read file contents               |
| `fileWrite`     | Write to files                   |
| `fileList`      | List directory contents          |
| `fileExists`    | Check if file exists             |
| `fileDelete`    | Delete files                     |
| `httpRequest`   | Make HTTP requests               |
| `exec`          | Execute shell commands           |

#### Web & Search Tools

| Tool        | Description                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `webSearch` | Search the web or news (Tavily, Brave, Serper) with date, domain, country and language filters |
| `webScrape` | Extract content from web pages                                                                 |

#### Database Tools

| Tool           | Description                                |
| -------------- | ------------------------------------------ |
| `sqlQuery`     | Execute SQL queries (PostgreSQL, SQLite)   |
| `vectorSearch` | Semantic search with embeddings (pgvector) |

#### Communication Tools

| Tool        | Description                    |
| ----------- | ------------------------------ |
| `sendEmail` | Send emails (Resend API, SMTP) |

#### Development Tools

| Tool        | Description                                      |
| ----------- | ------------------------------------------------ |
| `githubApi` | GitHub API (issues, PRs, files, commits, search) |

#### Multimodal Tool Factories

Not part of `builtinTools`. `createAnalyzeImageTool` takes an `llm` backend; the other three call the OpenAI API (`apiKey` or `OPENAI_API_KEY`).

| Factory                     | Tool              | Default model                                                                                                                                                                       |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAnalyzeImageTool`    | `analyzeImage`    | `gpt-6.1-sol` (`defaultModel`) on the backend you pass in                                                                                                                           |
| `createGenerateImageTool`   | `generateImage`   | `gpt-image-2.5-flare`; returns `imageBase64` (`url` only from legacy `dall-e-*` endpoints). `size` / `quality` default to `auto`; legacy `standard` / `hd` map to `medium` / `high` |
| `createTranscribeAudioTool` | `transcribeAudio` | `gpt-transcribe`; `whisper-1` when word timestamps are requested without an explicit model                                                                                          |
| `createGenerateSpeechTool`  | `generateSpeech`  | `gpt-4o-mini-tts`                                                                                                                                                                   |

```typescript
import { Agent, builtinTools } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'utility-agent',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-6.1-sol',
  tools: builtinTools, // Tool[]
});
```

#### Assistant Tool Factories

Also not in `builtinTools`, these build tools around your own stores. `createMemoryTools` and `createSchedulerTools` return typed tuples (see `toolset()`), so destructured tools keep their parameter types:

| Factory                                                                                                        | Tools                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `createMemoryTools({ graphAdapter, agentId, coreFacts?, embeddingFn? })`                                       | `remember`, `recall`, `forget` on a knowledge graph                               |
| `createSchedulerTools({ store, defaultChannel?, defaultUserId? })`                                             | `schedule_task`, `list_tasks`, `cancel_task` on a `TimerStore`                    |
| `createDeviceTools()`, `createCapabilitiesTool(doc)`, `createSelfTools({ toolsDir })` / `loadCustomTools(dir)` | Device info, a capabilities description, and tools an agent writes to a directory |

### Web Search Tool

Search the web using Tavily, Brave, or Serper APIs:

```typescript
import { Agent, webSearch } from '@cogitator-ai/core';

// Auto-detects from TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY
const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [webSearch],
});

// Or specify provider explicitly in tool call
// provider: 'tavily' | 'brave' | 'serper'
```

### Web Scrape Tool

Extract content from web pages:

```typescript
import { Agent, webScrape } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [webScrape],
});

// Supports simple selectors (tag, .class, #id), text/markdown/html output, link/image extraction
```

### SQL Query Tool

Execute SQL queries against PostgreSQL or SQLite:

```typescript
import { Agent, sqlQuery } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [sqlQuery],
});

// Uses DATABASE_URL env var by default
// Supports parameterized queries for safety
// Read-only by default (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN)
```

Read-only queries on PostgreSQL run inside `BEGIN TRANSACTION READ ONLY` (always rolled back), so writes hidden in functions are rejected by the database. SQLite opens the file with `readonly: true`. With `readOnly: false`, row-less statements return `rows: []` and the affected row count in `rowCount`.

**Dependencies:** `pg` for PostgreSQL, `better-sqlite3` for SQLite

### Vector Search Tool

Semantic search using embeddings with pgvector:

```typescript
import { Agent, vectorSearch } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [vectorSearch],
});

// Embedding providers: OpenAI, Ollama, Google
// Auto-detects from OPENAI_API_KEY, OLLAMA_BASE_URL / OLLAMA_URL / OLLAMA_HOST, or GOOGLE_API_KEY
// Default models: text-embedding-3-small, nomic-embed-text, gemini-embedding-001
```

**Dependencies:** `pg` with pgvector extension

### Email Tool

Send emails via Resend API or SMTP:

```typescript
import { Agent, sendEmail } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [sendEmail],
});

// Resend: Set RESEND_API_KEY
// SMTP: Set SMTP_HOST, SMTP_USER, SMTP_PASS
// Supports HTML, CC/BCC, reply-to
```

**Dependencies:** `nodemailer` for SMTP

### GitHub API Tool

Interact with GitHub repositories:

```typescript
import { Agent, githubApi } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-5.5',
  tools: [githubApi],
});

// Set GITHUB_TOKEN env var
// Actions: get_repo, list_issues, get_issue, create_issue, update_issue,
//          list_prs, get_pr, create_pr, get_file, list_commits,
//          search_code, search_issues
```

---

## Run Options

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const agent = new Agent({
  name: 'analyst',
  instructions: 'Analyze data.',
  model: 'openai/gpt-5.5',
});
const controller = new AbortController();

const result = await cog.run(agent, {
  input: 'Analyze this data...',
  images: ['https://example.com/chart.png'],
  audio: [{ data: base64Wav, format: 'wav' }],

  threadId: 'thread_123',
  userId: 'user_456', // owns the thread, scopes memory, reaches tools as context.userId
  threadAccess: 'owner', // default; 'shared' lets any user continue the thread
  context: { task: 'analysis' }, // extra values for the system prompt

  timeout: 60000,
  signal: controller.signal,
  stream: true,
  onToken: (token) => process.stdout.write(token),
  onReasoning: (delta) => process.stdout.write(delta),
  reasoning: { effort: 'low' }, // overrides the agent's reasoning for this run

  useMemory: true,
  loadHistory: true,
  saveHistory: true,
  parallelToolCalls: false, // default: tool calls of one turn run one after another

  onApproval: (request) => ({ approved: request.toolName !== 'delete_account' }),
  onHandoff: (handoff) => console.log(`${handoff.from} -> ${handoff.to}`),
  onToolCall: (call) => console.log('Tool:', call.name),
  onToolResult: (result) => console.log('Result:', result.result),
  onSpan: (span) => console.log('Span:', span.name),
  onRunStart: ({ runId }) => console.log('Started:', runId),
  onRunComplete: (result) => console.log('Completed'),
  onRunError: (error) => console.error('Error:', error),
  onMemoryError: (error, op) => console.warn(`Memory ${op} failed`),
});
```

`audio` inputs are transcribed with OpenAI `gpt-transcribe` (`llm.providers.openai.apiKey` or `OPENAI_API_KEY`) and prepended to `input` before guardrails and prompt-injection checks run. History loaded from memory is repaired before it is sent: tool results without their assistant call and tool calls without results are dropped, so a truncated window never produces an invalid provider request.

### Run Result

```typescript
interface RunResult {
  output: string;
  structured?: unknown; // parsed output when the agent has a responseFormat
  runId: string;
  agentId: string;
  threadId: string;
  modelUsed?: string; // differs from agent.model when cost routing picked another
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
  reasoning?: string; // reasoning summary, with reasoning.summary
  truncated?: boolean; // the last answer stopped at maxTokens
  blocked?: 'content_filter' | 'refusal'; // the last answer was filtered or refused
  prompt?: RunPrompt; // versioned instructions / A/B variant used
  handoffs?: HandoffEvent[];
  finalAgent?: string;
  status?: 'completed' | 'paused';
  pendingApprovals?: ToolApprovalRequest[];
  checkpoint?: RunCheckpoint; // pass to cog.resume()
  toolCalls: ToolCall[];
  messages: Message[];
  trace: { traceId: string; spans: Span[] };
  reflections?: Reflection[];
  reflectionSummary?: ReflectionSummary;
}
```

All fields are `readonly`. The run timeout comes from the run, the agent, `limits.defaultTimeout`, or 120 s.

A run whose last answer the provider withheld still completes, with `blocked` saying why: `content_filter` when its safety system filtered the answer (OpenAI and Azure `content_filter`, Gemini `SAFETY` and the like, Bedrock guardrails), `refusal` when the model declined (OpenAI `refusal`, Anthropic `refusal`). `output` holds what the model said before it stopped, the explanation of a refusal or often nothing, and the run does not ask again.

---

## Memory Integration

Configure memory for conversation persistence:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'redis',
    redis: {
      url: 'redis://localhost:6379',
      keyPrefix: 'cogitator:',
    },
    contextBuilder: {
      maxTokens: 4000,
      strategy: 'recent',
    },
  },
});

// Or PostgreSQL
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: {
      connectionString: 'postgresql://...',
    },
  },
});

// Or in-memory
const cog = new Cogitator({
  memory: {
    adapter: 'memory',
    inMemory: {
      maxEntries: 1000,
    },
  },
});
```

`adapter` also accepts `'sqlite'` (`sqlite.path`), `'mongodb'` (`mongodb.uri`) and `'redis'` (`redis.url`, or `redis.host` + `redis.port`, or `redis.cluster`). Qdrant stores embeddings, not threads: configure it in `memory.qdrant` next to a thread adapter, together with `memory.embedding` and `memory.contextBuilder.includeSemanticContext`, and semantic context is retrieved from it. The Postgres adapter sizes its vector column to the `memory.embedding` model. Runs with a `threadId` load history from and save messages to the adapter.

The adapter connects on the first run. To read threads before that (for example in an API route), use `getMemory()`, which connects it on first use; `cog.memory` stays `undefined` until something connected it:

```typescript
import { unwrap } from '@cogitator-ai/memory';

const memory = await cog.getMemory(); // undefined when memory is not configured
if (memory) {
  const entries = unwrap(await memory.getEntries({ threadId: 'thread_123', limit: 20 }));
}
```

See [Memory](https://cogitator.app/docs/memory) and [Memory Adapters](https://cogitator.app/docs/memory/adapters).

---

## Reflection Engine

Enable self-improvement through reflection on tool calls and runs:

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator({
  reflection: {
    enabled: true,
    reflectionModel: 'openai/gpt-6-luna',
    reflectAfterToolCall: true,
    reflectAtEnd: true,
    minConfidenceToStore: 0.7,
    maxInsightsPerAgent: 50,
  },
});

const result = await cog.run(agent, { input: 'Complete this task...' });

console.log('Reflections:', result.reflections);
console.log('Summary:', result.reflectionSummary);

const insights = await cog.getInsights(agent.id);
console.log('Learned insights:', insights);
```

### Standalone Reflection Engine

```typescript
import { ReflectionEngine, InMemoryInsightStore, createLLMBackend } from '@cogitator-ai/core';

const backend = createLLMBackend('openai', {
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
});
const insightStore = new InMemoryInsightStore();

const engine = new ReflectionEngine({
  llm: backend,
  insightStore,
  config: {
    enabled: true,
    reflectAfterToolCall: true,
    minConfidenceToStore: 0.7,
  },
});

const result = await engine.reflectOnToolCall(action, agentContext);
if (result.shouldAdjustStrategy) {
  console.log('Suggested action:', result.suggestedAction);
}
```

`reflectOnError`, `reflectOnRun`, `getRelevantInsights` and `getSummary(agentId)` cover the other stages. See [Reflection](https://cogitator.app/docs/advanced/reflection).

---

## Tree-of-Thought Reasoning

Explore multiple reasoning paths before deciding:

```typescript
import { ThoughtTreeExecutor } from '@cogitator-ai/core';

const executor = new ThoughtTreeExecutor(cog, {
  branchFactor: 3,
  maxDepth: 3,
  explorationStrategy: 'best-first',
  confidenceThreshold: 0.3,
});

const result = await executor.explore(agent, 'Solve this complex problem...', {
  timeout: 60_000,
  onProgress: (stats) => console.log('Explored:', stats.exploredNodes),
});

console.log('Answer:', result.output);
console.log(
  'Best path:',
  result.bestPath.map((node) => node.branch.thought)
);
console.log('Nodes in tree:', result.tree.nodes.size);
console.log('Stats:', result.stats);
```

### ToT Configuration

Every field is optional; defaults are in `DEFAULT_TOT_CONFIG`:

```typescript
const executor = new ThoughtTreeExecutor(cog, {
  branchFactor: 3, // branches generated per node
  beamWidth: 2, // best candidates queued per expanded node
  maxDepth: 5,
  explorationStrategy: 'beam', // 'beam' | 'best-first' | 'dfs'
  confidenceThreshold: 0.3, // prune branches scored below
  terminationConfidence: 0.8, // stop once a branch reaches this
  maxTotalNodes: 50, // executed nodes
  maxIterationsPerBranch: 3, // iteration cap for each branch run
  onBranchEvaluated: (branch, score) => console.log(branch.thought, score.composite),
});
```

Candidates beyond `beamWidth` stay pending, so a failed branch backtracks to the next best one. `beam` runs the tree level by level, `best-first` always runs the node whose own branch scored highest, and `dfs` goes deep first. The executor's own generation, evaluation and synthesis calls use the agent's routed model and count into `usage` (tokens and cost) and `stats`. See [Tree-of-Thought](https://cogitator.app/docs/advanced/reasoning).

---

## Agent Optimizer (Learning)

DSPy-style optimization through execution traces:

```typescript
import { AgentOptimizer, InMemoryTraceStore } from '@cogitator-ai/core';

const traceStore = new InMemoryTraceStore();
const optimizer = new AgentOptimizer({
  llm: cog.getLLMBackend('openai/gpt-6.1-sol'),
  model: 'gpt-6.1-sol',
  traceStore,
  cogitator: cog,
});

const result = await optimizer.compile(
  agent,
  [
    { input: 'Calculate 2+2', expected: '4' },
    { input: 'Calculate 10*5', expected: '50' },
  ],
  { maxRounds: 3 }
);

console.log('Optimized instructions:', result.instructionsAfter);
console.log('Score:', result.scoreBefore, '→', result.scoreAfter);
```

With `cogitator`, `compile()` runs the trainset with the original agent (those runs score it and become demo candidates) and again with the optimized instructions, so `scoreAfter` is measured. Without it, `compile()` works on the traces already stored and `scoreAfter` is the instruction optimizer's estimate.

### Built-in Metrics

```typescript
import {
  createSuccessMetric,
  createExactMatchMetric,
  createContainsMetric,
} from '@cogitator-ai/core';

const successMetric = createSuccessMetric(); // 1 when no tool call failed
const exactMatch = createExactMatchMetric(); // compares the output (or a field path) with `expected`
const containsMetric = createContainsMetric(['refund', 'order']); // share of keywords found, passes at >= 0.5
```

Each is a `MetricFn` (`(trace, expected?) => MetricResult`); `MetricEvaluator` combines built-in and custom metrics, including LLM-judged ones.

### Demo Selection

```typescript
import { DemoSelector, InMemoryTraceStore } from '@cogitator-ai/core';

const selector = new DemoSelector({
  traceStore: new InMemoryTraceStore(),
  maxDemos: 5, // per agent (default 10)
  minScore: 0.8, // traces scoring lower are not used as demos
  diversityWeight: 0.3,
});

await selector.addDemo(trace);
const demos = await selector.selectDemos(agent.id, currentInput, 3);
const fewShot = selector.formatDemosForPrompt(demos);
```

See [Learning](https://cogitator.app/docs/advanced/learning).

---

## Prompt Auto-Optimization

Capture prompts, run A/B tests, monitor performance, and automatically optimize agent instructions.

### Prompt Versions

`cog.prompts` versions an agent's instructions on top of the ones in code. A deployed version is used by every following run of that agent, and each run's outcome is recorded against the version (or A/B variant) it used:

```typescript
const v2 = await cog.prompts.deploy(writer, 'You write release notes. Lead with what changed.');

const result = await cog.run(writer, { input, threadId });
result.prompt; // { key: 'writer', versionId: v2.id, version: 2 }

await cog.prompts.rollbackTo(writer); // previous version, recorded as a new one
await cog.prompts.history(writer); // newest first, with metrics

await cog.prompts.startABTest(writer, {
  name: 'shorter notes',
  treatment: 'You write release notes in at most five bullet points.',
  treatmentAllocation: 0.3, // share of threads
  minSampleSize: 50,
});
```

Versions are kept per agent `id` when set, else per `name`. They live in process memory unless `new Cogitator({ prompts: { versions, abTests } })` gets durable stores (`PostgresTraceStore` provides both via `instructionVersions()` and `abTests()`); `prompts.score` scores runs (default: 1 for a completed run) and `prompts.autoDeployWinner` deploys a significant A/B winner. See [Prompt Versions](https://cogitator.app/docs/advanced/prompt-versions).

The classes below are the building blocks `cog.prompts` uses, available for your own pipelines.

### Prompt Logger

Wrap any LLM backend to capture all prompts:

```typescript
import { wrapWithPromptLogger, PostgresTraceStore } from '@cogitator-ai/core';

const store = new PostgresTraceStore({
  connectionString: process.env.DATABASE_URL!,
});

await store.connect();

const wrappedBackend = wrapWithPromptLogger(openaiBackend, store, {
  captureContent: true,
  captureTools: true,
});

wrappedBackend.setContext({ runId, agentId: agent.id, threadId });
```

### A/B Testing Framework

Test instruction variants with statistical analysis:

```typescript
import { ABTestingFramework } from '@cogitator-ai/core';

const abTesting = new ABTestingFramework({
  store: abTestStore,
  defaultConfidenceLevel: 0.95,
  defaultMinSampleSize: 50,
});

const test = await abTesting.createTest({
  agentId: 'agent-1',
  name: 'Instruction Experiment',
  controlInstructions: 'You are a helpful assistant.',
  treatmentInstructions: 'You are an expert assistant. Be concise.',
  treatmentAllocation: 0.5,
});

await abTesting.startTest(test.id);

const variant = abTesting.selectVariant(test);
const instructions = abTesting.getInstructionsForVariant(test, variant);

await abTesting.recordResult(test.id, variant, score, latency, cost);

const { test: completed, outcome } = await abTesting.completeTest(test.id);
console.log('Winner:', outcome.winner);
console.log('p-value:', outcome.pValue);
console.log('Effect size:', outcome.effectSize);
```

### Prompt Monitor

Real-time performance monitoring with degradation detection:

```typescript
import { PromptMonitor } from '@cogitator-ai/core';

const monitor = new PromptMonitor({
  windowSize: 60 * 60 * 1000,
  scoreDropThreshold: 0.15,
  latencySpikeThreshold: 2.0,
  errorRateThreshold: 0.1,
  enableAutoRollback: true,
  onAlert: (alert) => {
    console.log(`Alert: ${alert.type} (${alert.severity})`);
  },
});

const alerts = monitor.recordExecution(trace);

const metrics = monitor.getCurrentMetrics('agent-1'); // null before any execution
console.log('Avg score:', metrics?.avgScore);
console.log('P95 latency:', metrics?.p95Latency);
```

### Rollback Manager

Version control for agent instructions:

```typescript
import { RollbackManager } from '@cogitator-ai/core';

const rollback = new RollbackManager({ store: versionStore });

const version = await rollback.deployVersion(
  'agent-1',
  'New optimized instructions',
  'optimization',
  'opt-run-123'
);

const result = await rollback.rollbackToPrevious('agent-1');
if (result.success) {
  console.log('Rolled back to version:', result.previousVersion?.version);
}

const history = await rollback.getVersionHistory('agent-1', 10);
```

### Auto-Optimizer

Automated optimization pipeline with A/B testing and rollback:

```typescript
import { AutoOptimizer } from '@cogitator-ai/core';

const optimizer = new AutoOptimizer({
  enabled: true,
  triggerAfterRuns: 100,
  minRunsForOptimization: 20,
  requireABTest: true,
  maxOptimizationsPerDay: 3,
  agentOptimizer,
  abTesting,
  monitor,
  rollbackManager,
  onOptimizationComplete: (run) => {
    console.log('Optimization completed:', run.status);
  },
  onRollback: (agentId, reason) => {
    console.log('Rollback triggered:', reason);
  },
});

await optimizer.recordExecution(trace);
```

It optimizes the agent's deployed version, so deploy one first. To serve its A/B tests on live traffic, give `new Cogitator({ prompts: { abTests, versions } })` the same stores as `abTesting` and `rollbackManager` and the agent an explicit `id`: the Cogitator then assigns variants per thread and records the results, traces carry the variant (`trace.prompt`) so the optimizer does not count them twice, and the optimizer deploys the winner (leave `prompts.autoDeployWinner` off). `PostgresTraceStore` backs all of it: `traces()` for `AgentOptimizer`, `abTests()` and `instructionVersions()` for the rest. See [Learning](https://cogitator.app/docs/advanced/learning#ab-tests-on-live-traffic).

---

## Time Travel Debugging

Checkpoint, replay, fork, and compare agent executions:

```typescript
import { TimeTravel, InMemoryCheckpointStore } from '@cogitator-ai/core';

const timeTravel = new TimeTravel(cogitator);

const result = await cogitator.run(agent, { input: 'Original task...' });
const checkpoints = await timeTravel.checkpointAll(result, 'original'); // one per tool call

const replayResult = await timeTravel.replayLive(agent, checkpoints[2].id);
console.log('Replayed from the third tool call:', replayResult.output);

const forkResult = await timeTravel.fork(agent, checkpoints[2].id, {
  input: 'Modified task...',
});
console.log('Forked result:', forkResult.result.output);

const diff = await timeTravel.compareWithOriginal(forkResult.result);
console.log(timeTravel.formatDiff(diff));
```

### Forking Variants

```typescript
const forkWithContext = await timeTravel.forkWithContext(
  agent,
  checkpointId,
  'Additional context: the user is an expert'
);

const forkWithMock = await timeTravel.forkWithMockedTool(agent, checkpointId, 'api_call', {
  status: 'success',
  data: 'mocked data',
});

const forkWithMocks = await timeTravel.forkWithMockedTools(agent, checkpointId, {
  api_call: { status: 'success' },
  database_query: { rows: [] },
});

const forkWithNewInput = await timeTravel.forkWithNewInput(
  agent,
  checkpointId,
  'Completely different task...'
);

const variants = await timeTravel.forkMultiple(agent, checkpointId, [
  { input: 'Variant A' },
  { input: 'Variant B' },
  { additionalContext: 'Be more concise' },
]);
```

### Replay Modes

```typescript
const deterministicReplay = await timeTravel.replayDeterministic(agent, checkpointId);

const liveReplay = await timeTravel.replayLive(agent, checkpointId, {
  skipTools: ['send_email'],
  modifiedToolResults: { web_search: { results: [] } },
});
```

Checkpoints are anchored on tool calls: checkpoint `i` holds the conversation after `i` tool calls, stopping before the result of the call it is anchored on. `stepsReplayed` is that index, `stepsExecuted` counts the replay's tool calls, and `divergedAt` uses the original run's numbering. Mocked tool results are keyed by tool name (in deterministic replays also by call id): the tool answers with the given value and never runs. Tools in `skipTools` are removed from the replayed agent. Checkpoints, replays and forks store their traces in the trace store, so `compare()` and `compareWithOriginal()` can read them.

---

## Causal Reasoning

Full causal reasoning framework implementing Pearl's Ladder of Causation:

- **Level 1 (Association)**: Observational queries P(Y|X)
- **Level 2 (Intervention)**: do-calculus P(Y|do(X))
- **Level 3 (Counterfactual)**: "What if" queries P(Y_x|X', Y')

### Building Causal Graphs

```typescript
import { CausalGraphBuilder, CausalInferenceEngine } from '@cogitator-ai/core';

const graph = CausalGraphBuilder.create('medical-study')
  .treatment('X', 'Drug Treatment')
  .outcome('Y', 'Recovery')
  .confounder('Z', 'Age')
  .from('Z')
  .causes('X')
  .from('Z')
  .causes('Y')
  .from('X')
  .causes('Y', { strength: 0.8 })
  .build();

const engine = new CausalInferenceEngine(graph);
```

### Effect Identification

```typescript
const identifiable = engine.isIdentifiable('X', 'Y');
if (identifiable.identifiable) {
  console.log('Effect is identifiable:', identifiable.reason); // e.g. backdoor criterion
  console.log('Adjustment set:', identifiable.adjustmentSet?.variables);
}
```

### Interventional Queries

```typescript
const effect = engine.computeInterventionalEffect({
  target: 'Y',
  interventions: { X: 1 },
  conditions: { Z: 0.5 },
});

console.log('Expected effect:', effect.effect);
console.log('Formula:', effect.formula, 'identifiable:', effect.isIdentifiable);
```

### Counterfactual Reasoning

```typescript
import { evaluateCounterfactual } from '@cogitator-ai/core';

const result = evaluateCounterfactual(graph, {
  target: 'Y',
  intervention: { X: 1 },
  factual: { X: 0, Y: 0.2 },
  question: 'What would Y be if X was 1?',
});

console.log('Factual value:', result.factualValue);
console.log('Counterfactual value:', result.counterfactualValue);
```

Counterfactuals use the nodes' structural equations (`withEquation()` on the builder): `linear`, `logistic`, `polynomial`, or `custom` with a safe arithmetic expression over the parent ids in `customFn` (`'2 * price - log(demand)'`; `+ - * / ^`, parentheses, `abs exp log sqrt pow min max tanh sigmoid`). Nodes without an equation keep their factual values.

### D-Separation Analysis

```typescript
import { dSeparation, findBackdoorAdjustment } from '@cogitator-ai/core';

const separated = dSeparation(graph, 'X', 'Y', ['Z']);
console.log('D-separated:', separated.separated);

const backdoor = findBackdoorAdjustment(graph, 'X', 'Y');
if (backdoor?.isValid) {
  console.log('Backdoor adjustment set:', backdoor.variables);
}
```

### Causal Discovery from Traces

```typescript
import { CausalExtractor, CausalHypothesisGenerator } from '@cogitator-ai/core';

const extractor = new CausalExtractor({ llmBackend: backend });

const { nodes, edges } = await extractor.extractFromToolResult(
  { id: 'call_1', name: 'database_query', arguments: { table: 'users' } },
  { rows: 100, cached: true },
  { taskDescription: 'Count active users' },
  graph
);

const generator = new CausalHypothesisGenerator({ llmBackend: backend });
const hypotheses = await generator.generateFromFailure(trace, { agentId: 'agent-1' });
```

`CausalReasoner` ties these together for agents (`predictEffect`, `explainCause`, `planForGoal`, `evaluateToolCall`, `analyzeErrorCausally`). See [Causal Reasoning](https://cogitator.app/docs/advanced/causal-reasoning).

---

## Error Handling & Resilience

### Retrying LLM Calls

Agent runs retry failed LLM calls on their own: rate limits, 5xx, timeouts and dropped connections, with exponential backoff and the provider's `Retry-After`. Streams are retried only before the first chunk. Tune or turn this off with `llm.retry`:

```typescript
import { Cogitator, GoogleBackend, withLLMRetry } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    retry: { maxRetries: 3, maxRetryAfter: 30_000, onRetry: (e) => console.warn(e) },
    // retry: false — no retries
  },
});

// A backend used on its own
const backend = withLLMRetry(new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! }), {
  maxRetries: 3,
});
```

### Retry with Backoff

```typescript
import { withRetry, retryable } from '@cogitator-ai/core';

const result = await withRetry(() => unreliableApiCall(), {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential',
  jitter: 0.1,
  onRetry: (error, attempt, delay) => {
    console.log(`Retry ${attempt} after ${delay}ms: ${error.message}`);
  },
});

const retryableFetch = retryable(fetch, { maxRetries: 3 });
const response = await retryableFetch('https://api.example.com');
```

### Circuit Breaker

```typescript
import { CircuitBreaker, CircuitBreakerRegistry } from '@cogitator-ai/core';

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenRequests: 3,
  onStateChange: (from, to) => console.log(`Circuit ${from} -> ${to}`),
});

// Throws CIRCUIT_OPEN while open; counts successes and failures (by default only retryable errors, see isFailure)
const result = await breaker.execute(() => riskyOperation());

console.log(breaker.getState(), breaker.getStats());

const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });
const apiBreaker = registry.get('payments-api');
```

### Fallback Patterns

```typescript
import {
  CircuitBreakerRegistry,
  withFallback,
  withGracefulDegradation,
  createLLMFallbackExecutor,
} from '@cogitator-ai/core';

const result = await withFallback({
  primary: () => primaryCall(),
  fallbacks: [
    { name: 'secondary', fn: () => fallbackCall() },
    { name: 'cache', fn: () => cachedResult() },
  ],
  retry: { maxRetries: 2 },
  onFallback: (from, to, error) => console.warn(`${from} -> ${to}: ${error.message}`),
});

const degraded = await withGracefulDegradation(() => fullFeatureCall(), {
  defaultValue: [],
  onDegraded: (error) => console.warn('Degraded:', error.message),
});

const executeWithFallback = createLLMFallbackExecutor(
  {
    providers: [
      { provider: 'openai', model: 'gpt-6.1-sol' },
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { provider: 'ollama', model: 'llama3.3:70b' },
    ],
  },
  new CircuitBreakerRegistry()
);
const response = await executeWithFallback((provider, model) =>
  cog.getLLMBackend(`${provider}/${model}`).chat({ model, messages })
);
```

---

## Prompt Injection Detection

Protect your agents from jailbreak attempts, prompt injections, and other adversarial inputs. See [Security](https://cogitator.app/docs/advanced/security).

```typescript
import { Cogitator, PromptInjectionDetector } from '@cogitator-ai/core';

// Standalone usage
const detector = new PromptInjectionDetector({
  detectInjection: true, // "Ignore previous instructions..."
  detectJailbreak: true, // DAN, developer mode attacks
  detectRoleplay: true, // Malicious roleplay scenarios
  detectEncoding: true, // Base64, hex encoded attacks
  detectContextManipulation: true, // [SYSTEM], <|im_start|> injections
  classifier: 'local', // 'local' (fast) or 'llm' (accurate)
  action: 'block', // 'block' | 'warn' | 'log'
  threshold: 0.7,
});

const result = await detector.analyze('Ignore all previous instructions and...');
// { safe: false, threats: [...], action: 'blocked', analysisTime: 2 }

// Integrated with Cogitator runtime
const cog = new Cogitator({
  security: {
    promptInjection: {
      detectInjection: true,
      detectJailbreak: true,
      action: 'block',
      threshold: 0.7,
    },
  },
});

// Throws a CogitatorError with code PROMPT_INJECTION_DETECTED when an attack is found
await cog.run(agent, { input: userInput });
```

### Detection Types

| Type                   | Examples                                              |
| ---------------------- | ----------------------------------------------------- |
| `direct_injection`     | "Ignore previous instructions", "Your new prompt is"  |
| `jailbreak`            | DAN prompts, "developer mode enabled", "unrestricted" |
| `roleplay`             | "Pretend you are evil AI", "From now on you are"      |
| `encoding`             | Base64 payloads, hex escape sequences, unicode tricks |
| `context_manipulation` | `[SYSTEM]:`, `<\|im_start\|>`, markdown role markers  |

### Custom Patterns & Allowlist

```typescript
const detector = new PromptInjectionDetector({
  action: 'block',
  patterns: [/secret\s+backdoor/i], // Custom regex patterns
  allowlist: ['ignore the previous search'], // Legitimate phrases
});

// Dynamic updates
detector.addPattern(/company\s+specific\s+attack/i);
detector.addToAllowlist('ignore previous results');
```

### LLM-Based Classification

For higher accuracy with complex attacks:

```typescript
const detector = new PromptInjectionDetector({
  classifier: 'llm',
  llmBackend: openaiBackend,
  llmModel: 'gpt-6-luna',
  action: 'block',
});
```

Inside `Cogitator` (`security.promptInjection`), omit `llmBackend` and pass a `provider/model` id as `llmModel`; without `llmModel` the classifier uses the running agent's model.

### Statistics & Callbacks

```typescript
const detector = new PromptInjectionDetector({
  action: 'block',
  onThreat: (result, input) => {
    console.log('Attack detected:', result.threats);
    logToSecurity(input, result);
  },
});

await detector.analyze('...');
const stats = detector.getStats();
// { analyzed: 100, blocked: 5, warned: 0, allowRate: 0.95 }
```

---

patterns, a 4xx robots.txt allows everything, a 5xx or a network failure allows nothing until the cache (one hour by default) expires. It implements `RobotsChecker`, which `WebLoader` in `@cogitator-ai/rag` and `BrowserSession` in `@cogitator-ai/browser` take as `robots`:

```typescript
import { RobotsPolicy } from '@cogitator-ai/core';

const robots = new RobotsPolicy({ userAgent: 'NewsBot/1.0 (+https://example.com/bot)' });
await robots.allows('https://example.com/news/today'); // true or false
```

The token defaults to the User-Agent's first word (`NewsBot`); pass `token` to match another. `robotsRulesFor(text, token)` and `robotsAllowsPath(rules, path)` expose the parser for robots.txt files you already have.

`createWebScrapeTool({ userAgent, robots })` builds a `web_scrape` tool with your User-Agent and a robots.txt check on every hop, redirects included (a disallowed page comes back as an `error`). The plain `webScrape` keeps the default User-Agent and checks nothing.

### Public hosts only

A model chooses the URLs `web_scrape` and `http_request` fetch, and the audio URL `transcribe_audio` reads, so a page it read or a prompt it was given can point it at `http://169.254.169.254/` (a cloud's credentials), `http://localhost:8080/admin` or a database on the internal network. These tools reach only the public internet: a URL on a loopback, private, link-local, carrier-grade NAT, multicast or documentation address, `localhost`, `*.local`, `*.internal` or a metadata host is refused, every redirect target is checked again, and a hostname is checked by the address it resolves to when the request connects, so a name that resolves elsewhere a moment later (DNS rebinding) is refused too. A refused URL comes back to the model as an `error` naming it.

An agent meant to work on a trusted network opts in, or brings its own client:

```typescript
import { createHttpRequestTool, createWebScrapeTool } from '@cogitator-ai/core';

const intranet = createWebScrapeTool({ allowPrivateNetwork: true });
const api = createHttpRequestTool({ fetch: proxiedFetch });
```

A `fetch` of your own is trusted with every URL, so it should apply your network policy. `createTranscribeAudioTool` takes the same two options.

The guard is yours to use too: `fetchPublic` is a `fetch` for public hosts, `createPublicFetch({ allowPrivateNetwork, maxRedirects, resolver, isBlocked })` builds one to your rules, `assertPublicUrl(url)` checks a URL up front, `assertPublicHost(url)` checks the addresses its host resolves to as well and `isPrivateAddress(ip)` classifies an address. They run on `node:http`, in Node and Bun alike, and a refusal throws a `PrivateNetworkError`.

With `robots`, the tool checks a URL and the addresses its host resolves to before it reads the site's robots.txt. `RobotsPolicy` reads robots.txt with the global `fetch` unless given another: `new RobotsPolicy({ userAgent, fetch: fetchPublic })` keeps those reads on public hosts too.

Requests carry `DEFAULT_USER_AGENT` and `Accept: */*` unless the caller sets its own headers.

### Web Search

`webSearch` searches through Tavily, Brave or Serper, whichever key is set first (`TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`). The same filters work on all three: `topic: 'news'`, `recency` (`day`, `week`, `month`, `year`) or a `dateRange`, `includeDomains` / `excludeDomains`, `country`, `language` and `page`. A filter a provider cannot apply comes back as an `error` instead of being dropped. Results carry `publishedAt` when the provider reports a date.

```typescript
import { createWebSearchTool } from '@cogitator-ai/core';

const search = createWebSearchTool({ provider: 'tavily', apiKeys: { tavily: config.tavilyKey } });
// a model can call it with { query: 'solar storms', topic: 'news', recency: 'week', language: 'en' }
```

## Tool Caching

Cache tool results to avoid redundant API calls with exact or semantic matching. See [Tool Caching](https://cogitator.app/docs/tools/tool-caching).

### Exact Match Caching

```typescript
import { tool, withCache } from '@cogitator-ai/core';
import { z } from 'zod';

const webSearch = tool({
  name: 'web_search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    return await searchApi(query);
  },
});

const cachedSearch = withCache(webSearch, {
  strategy: 'exact',
  ttl: '1h',
  maxSize: 1000,
  storage: 'memory',
});

await cachedSearch.execute({ query: 'weather in Paris' }, ctx);
await cachedSearch.execute({ query: 'weather in Paris' }, ctx); // cache hit

console.log(cachedSearch.cache.stats());
// { hits: 1, misses: 1, size: 1, evictions: 0, hitRate: 0.5 }
```

### Semantic Caching

Similar queries hit the cache based on embedding similarity:

```typescript
import { withCache } from '@cogitator-ai/core';
import { OpenAIEmbeddingService } from '@cogitator-ai/memory';

// Any EmbeddingService ({ embed, embedBatch, dimensions, model }) works
const embeddingService = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',
});

const cachedSearch = withCache(webSearch, {
  strategy: 'semantic',
  similarity: 0.95, // 95% similarity threshold
  ttl: '1h',
  maxSize: 1000,
  storage: 'memory',
  embeddingService,
});

await cachedSearch.execute({ query: 'weather in Paris' }, ctx);
await cachedSearch.execute({ query: 'Paris weather forecast' }, ctx); // semantic hit
```

### Redis Storage

For production with persistence. `redisClient` takes any `RedisClientLike`; an ioredis client and a `createRedisClient()` client from `@cogitator-ai/redis` (standalone or cluster) fit as they are:

```typescript
import { withCache } from '@cogitator-ai/core';
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);

const cachedTool = withCache(webSearch, {
  strategy: 'semantic',
  similarity: 0.95,
  ttl: '1h',
  maxSize: 1000,
  storage: 'redis',
  redisClient: redis,
  keyPrefix: 'myapp:cache',
  embeddingService,
});
```

Keys live under `keyPrefix` (a `:` is appended when missing and never doubled): entries at `<prefix>:entry:<cache key>`, the LRU order in `<prefix>:lru` and the entry count in `<prefix>:counter`. Cached tools sharing a prefix share one LRU and `maxSize`; `cache.clear()` deletes every key under the prefix.

### Cache Management

```typescript
const cached = withCache(searchTool, config);

// Get statistics
const stats = cached.cache.stats();

// Invalidate specific entry
await cached.cache.invalidate({ query: 'specific query' });

// Clear all entries
await cached.cache.clear();

// Pre-warm cache
await cached.cache.warmup([
  { params: { query: 'common query 1' }, result: { data: '...' } },
  { params: { query: 'common query 2' }, result: { data: '...' } },
]);
```

### Cache Callbacks

```typescript
const cached = withCache(searchTool, {
  strategy: 'exact',
  ttl: '1h',
  maxSize: 100,
  storage: 'memory',
  onHit: (key) => console.log('Cache hit:', key),
  onMiss: (key) => console.log('Cache miss:', key),
  onEvict: (key) => console.log('Evicted:', key),
});
```

`onEvict` fires for entries removed by `cache.invalidate()` and for entries evicted to stay under `maxSize`, in memory and in Redis.

To build a storage yourself, `createToolCacheStorage()` takes the same `onEvict`, called with the key of each entry evicted to make room:

```typescript
import { createToolCacheStorage } from '@cogitator-ai/core';

const storage = createToolCacheStorage('redis', {
  redisClient: redis,
  keyPrefix: 'myapp:cache',
  maxSize: 5000,
  onEvict: (key) => console.log('Evicted:', key),
});
```

---

## Constitutional AI (Guardrails)

Built-in content safety with input/output filtering, tool guards, and critique-revision loops:

```typescript
import {
  Cogitator,
  ConstitutionalAI,
  createConstitution,
  DEFAULT_PRINCIPLES,
} from '@cogitator-ai/core';

const constitutional = new ConstitutionalAI({
  llm: backend,
  constitution: createConstitution([...DEFAULT_PRINCIPLES, customPrinciple]),
  config: { strictMode: true },
});

const inputResult = await constitutional.filterInput('user message');
if (!inputResult.allowed) {
  console.log('Blocked:', inputResult.blockedReason, inputResult.harmScores);
}

const outputResult = await constitutional.filterOutput('agent response', messages);
const guardResult = await constitutional.guardTool(
  deleteFileTool,
  { path: '/etc/passwd' },
  toolContext
);
console.log(guardResult.approved, guardResult.riskLevel, guardResult.reason);

const revision = await constitutional.critiqueAndRevise('draft answer', messages);

// Integrated with the Cogitator runtime: on when `guardrails` is set (unless enabled: false)
const cog = new Cogitator({
  guardrails: {
    model: 'openai/gpt-6-luna', // judge model; default: llm.defaultModel, else the first run's agent model
    filterToolResults: true,
  },
});
```

Fields left out take `DEFAULT_GUARDRAIL_CONFIG` (input, output and tool-call filtering plus critique-revision on). `InputFilter`, `OutputFilter`, `ToolGuard` and `CritiqueReviser` are the layers `ConstitutionalAI` uses; each takes `{ config, constitution }` plus `llm` for the LLM-backed ones. `cog.getGuardrails()` and `cog.setConstitution()` work before the first run when `guardrails.model` or `llm.defaultModel` names the judge model; a constitution set earlier applies once the guardrails are built.

With `strictMode`, every call of a tool with `sideEffects` needs approval and goes through the run's [approval flow](#approvals) like a `requiresApproval` tool: `onApproval`, then `guardrails.onToolApproval`, else the run pauses. `ToolGuard` fails closed: a call that needs approval and was not approved by that flow or by `onToolApproval` is denied. See [Constitutional AI](https://cogitator.app/docs/advanced/constitutional-ai).

---

## Cost-Aware Routing

Automatically route tasks to the optimal model based on complexity, budget, and latency requirements:

```typescript
import { Cogitator, CostAwareRouter } from '@cogitator-ai/core';

const router = new CostAwareRouter({
  config: {
    enabled: true,
    budget: {
      maxCostPerRun: 0.5,
      maxCostPerDay: 10.0,
      warningThreshold: 0.8,
      onBudgetWarning: (current, limit) => console.warn(`$${current} of $${limit}`),
    },
  },
});

const requirements = router.analyzeTask('Say hello'); // complexity, reasoning, speed, cost sensitivity
const recommendation = await router.recommendModel('Say hello');
console.log('Use model:', recommendation.provider, recommendation.modelId);
console.log('Estimated cost:', recommendation.estimatedCost, recommendation.reasons);

// Integrated with Cogitator
const cog = new Cogitator({
  costRouting: {
    enabled: true,
    autoSelectModel: true, // pick the model per run; result.modelUsed tells which
    budget: { maxCostPerDay: 10.0 },
  },
});

cog.getCostSummary(); // tracked costs, also before the first run
const estimate = await cog.estimateCost({ agent, input: 'Summarize this report' });
console.log(estimate.expectedCost);
```

With `costRouting.enabled`, every run is checked against `budget`, with or without `autoSelectModel`: before it starts by its estimated cost, from the task's complexity and the model's price, and before every model call by what has really been spent, the run's own cost against `maxCostPerRun` and every run's in the last hour and day against the other limits. A run that reaches a limit throws a `CogitatorError` with code `BUDGET_EXCEEDED` (HTTP 429). Each call's cost is recorded as soon as it is answered, so failed and cancelled runs count and runs side by side see each other's spending. `autoSelectModel` only picks models of providers the runtime can call (`llm.backends`, plugins, `llm.defaultProvider`, the agent's own provider, or `llm.providers` entries with credentials) and keeps the agent's model when none fits. The router exposes the same steps: `recommendAvailableModel(input, isProviderAvailable)` (undefined when no provider fits) and `checkRunBudget(input, model)`.

See [Cost Routing](https://cogitator.app/docs/advanced/cost-routing).

---

## Context Management

Automatic context window management with compression strategies:

```typescript
const cog = new Cogitator({
  context: {
    strategy: 'hybrid', // 'truncate' | 'sliding-window' | 'summarize' | 'hybrid'
    compressionThreshold: 0.8, // compress above 80% of the usable window
    outputReserve: 0.15, // share of the model's context kept for the answer
    windowSize: 10, // recent messages kept verbatim by sliding-window / hybrid
    summaryModel: 'openai/gpt-6-luna', // model that writes summaries
  },
});
```

Setting `context` turns compression on; pass `enabled: false` to keep the config but switch it off. The strategies are also exported as classes (`TruncateStrategy`, `SlidingWindowStrategy`, `SummarizeStrategy`, `HybridStrategy`) and `ContextManager` can be used on its own. See [Context Management](https://cogitator.app/docs/advanced/context-management).

---

## Observability

Export traces to Langfuse or any OTLP-compatible backend:

```typescript
import { createLangfuseExporter, createOTLPExporter } from '@cogitator-ai/core';

const langfuse = createLangfuseExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  baseUrl: 'https://cloud.langfuse.com',
  enabled: true,
});

await langfuse.init(); // needs the optional `langfuse` package

const otlp = createOTLPExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  headers: { Authorization: 'Bearer ...' },
  serviceName: 'my-agents',
  enabled: true,
});
otlp.start(); // flushes every 5 seconds

let runId = '';
const result = await cog.run(agent, {
  input: 'Analyze this data...',
  onRunStart: (data) => {
    runId = data.runId;
    langfuse.onRunStart({ ...data, agentName: agent.name });
  },
  onToolCall: (call) => langfuse.onToolCall(runId, call),
  onToolResult: (toolResult) => langfuse.onToolResult(runId, toolResult),
  onSpan: (span) => otlp.exportSpan(runId, span),
  onRunComplete: (runResult) => langfuse.onRunComplete(runResult),
});
```

Both exporters do nothing unless `enabled: true` is set, so you can build them unconditionally and switch them per environment. They are not attached automatically; wire them to the run callbacks as above. See [Observability](https://cogitator.app/docs/deployment/observability).

---

## Agent as Tool

Use one agent as a tool for another — enables hierarchical agent architectures:

```typescript
import { Cogitator, Agent, agentAsTool } from '@cogitator-ai/core';

const researcher = new Agent({
  name: 'researcher',
  instructions: 'Research topics thoroughly',
  model: 'openai/gpt-6.1-sol',
  tools: [webSearch],
});

const researchTool = agentAsTool(cog, researcher, {
  name: 'research',
  description: 'Delegate research tasks to a specialist agent',
  timeout: 60_000,
  includeUsage: true,
  includeToolCalls: false,
  onApproval: () => ({ approved: false, reason: 'Not allowed in delegated runs' }),
});

const manager = new Agent({
  name: 'manager',
  instructions: 'Coordinate tasks and delegate research',
  model: 'openai/gpt-6.1-sol',
  tools: [researchTool],
});
```

Tool calls of the inner agent that need approval are declined unless `onApproval` decides them, since a delegated run cannot pause for a person; an `onApproval` that returns `'pause'` declines too. If the inner run pauses anyway, the tool returns `success: false` with an `error` naming the tools that waited. To hand the conversation over instead of calling a sub-agent, use [handoffs](#handoffs). See [Agent as Tool](https://cogitator.app/docs/tools/agent-as-tool).

---

## Logging

```typescript
import { getLogger, setLogger, createLogger, createLoggerFromConfig } from '@cogitator-ai/core';

const logger = createLogger({
  level: 'debug', // default 'info'; the default logger reads LOG_LEVEL
  format: 'json', // 'pretty' (default) or 'json'
  output: (entry, formatted) => process.stderr.write(formatted + '\n'),
});

setLogger(logger);

getLogger().info('Agent started', { agentId: agent.id });
getLogger().debug('Tool call', { tool: 'calculator', args: { expression: '2+2' } });
getLogger().warn('Rate limited', { retryAfter: 60 });
getLogger().error('Failed', { error: 'Connection timeout' });
```

`new Cogitator({ logging })` installs a logger built from the config with `createLoggerFromConfig()`. It is process-wide, so with several runtimes the last one created with `logging` wins:

```typescript
import { Cogitator, createLoggerFromConfig, setLogger } from '@cogitator-ai/core';

const cog = new Cogitator({
  logging: {
    level: 'warn', // 'debug' | 'info' | 'warn' | 'error' | 'silent'
    destination: 'file', // appends JSON lines to filePath
    filePath: './cogitator.log',
  },
});

setLogger(createLoggerFromConfig({ level: 'silent' })); // the same, without a runtime
```

Without `filePath`, or where there is no file system, `destination: 'file'` logs to the console with a warning.

---

## Type Reference

### Core Types

```typescript
import type {
  Agent,
  AgentConfig,
  Tool,
  ToolConfig,
  ToolContext,
  Message,
  MessageRole,
  ToolCall,
  ToolResult,
  CogitatorConfig,
  RunOptions,
  RunResult,
  Span,
} from '@cogitator-ai/core';
```

### LLM Types

```typescript
import type {
  LLMBackend,
  LLMProvider,
  LLMBackendProvider, // LLMProvider or the name of your own backend
  LLMConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMErrorContext,
  LLMDebugOptions,
  LLMPlugin,
} from '@cogitator-ai/core';
```

### Reasoning Types

```typescript
import type {
  ToTConfig,
  ToTResult,
  ToTStats,
  ThoughtTree,
  ThoughtNode,
  ThoughtBranch,
  BranchScore,
  ExplorationStrategy,
} from '@cogitator-ai/core';
```

### Learning Types

```typescript
import type {
  ExecutionTrace,
  ExecutionStep,
  TraceStore,
  Demo,
  MetricFn,
  MetricResult,
  OptimizerConfig,
  OptimizationResult,
} from '@cogitator-ai/core';
```

### Time Travel Types

```typescript
import type {
  ExecutionCheckpoint,
  ReplayOptions,
  ReplayResult,
  ForkOptions,
  ForkResult,
  TraceDiff,
  TimeTravelConfig,
} from '@cogitator-ai/core';
```

### Causal Types

```typescript
import type {
  CausalNode,
  CausalEdge,
  CausalGraph,
  CausalRelationType,
  InterventionQuery,
  CounterfactualQuery,
  CausalHypothesis,
  CausalEvidence,
  StructuralEquation,
} from '@cogitator-ai/core';
```

### Error Types

```typescript
import {
  CogitatorError,
  LLMError,
  ErrorCode,
  isRetryableError,
  getRetryDelay,
} from '@cogitator-ai/core';

try {
  await riskyOperation();
} catch (error) {
  if (error instanceof LLMError) {
    console.log('Provider:', error.provider);
    console.log('Provider status:', error.details?.statusCode);
  } else if (error instanceof CogitatorError) {
    console.log('Code:', error.code); // an ErrorCode, e.g. ErrorCode.THREAD_ACCESS_DENIED
    console.log('HTTP status:', error.statusCode);
    console.log('Retryable:', isRetryableError(error), 'retry in', getRetryDelay(error), 'ms');
  }
}
```

Runs that hit their `timeout` throw `RUN_TIMEOUT` (HTTP 504, `Run timed out after <n>ms`), runs over the cost-routing budget `BUDGET_EXCEEDED` (429), and input or output blocked by guardrails (`Input blocked: …` / `Output blocked: …`) `LLM_CONTENT_FILTERED` (400), so server adapters return those statuses and messages.

---

## Examples

### Research Agent with Memory

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const webSearch = tool({
  name: 'web_search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    return { results: await searchApi(query) };
  },
});

const cog = new Cogitator({
  memory: { adapter: 'redis', redis: { url: 'redis://localhost:6379' } },
  reflection: { enabled: true },
});

const researcher = new Agent({
  name: 'researcher',
  instructions: 'Research topics thoroughly using web search',
  model: 'openai/gpt-6.1-sol',
  tools: [webSearch],
});

const result = await cog.run(researcher, {
  input: 'Research the latest AI developments',
  threadId: 'research-session-1',
});
```

### Streaming Response

```typescript
const result = await cog.run(agent, {
  input: 'Write a story about...',
  stream: true,
  onToken: (token) => process.stdout.write(token),
});
```

### Full Observability

```typescript
const result = await cog.run(agent, {
  input: 'Analyze this data...',
  onRunStart: ({ runId }) => console.log(`Run ${runId} started`),
  onToolCall: (call) => console.log(`Calling ${call.name}`),
  onToolResult: (result) => console.log(`Result: ${JSON.stringify(result.result)}`),
  onSpan: (span) => {
    console.log(`[${span.name}] ${span.duration}ms`);
  },
  onRunComplete: (result) => {
    console.log(`Cost: $${result.usage.cost.toFixed(4)}`);
    console.log(`Tokens: ${result.usage.totalTokens}`);
  },
});
```

---

## License

MIT
