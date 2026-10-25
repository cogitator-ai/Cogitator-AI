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

Full documentation: [cogitator.app/docs](https://cogitator.app/docs), start with [Agents](https://cogitator.app/docs/core/agents) and [Cogitator](https://cogitator.app/docs/core/cogitator).

The package also ships the documentation of its own version as Markdown in `node_modules/@cogitator-ai/core/docs/`, starting at `docs/index.md`, so a coding agent reads the API of the version you installed instead of what it remembers. `cogitator mcp` from [`@cogitator-ai/cli`](https://www.npmjs.com/package/@cogitator-ai/cli) serves it to Claude Code, Cursor and Codex.

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
- **Tool Execution** - Concurrency-safe calls run together, lock keys keep writes of one file apart, `toolOutput()` with details and presentation for the UI, progress with `context.update()`, tool input streamed as the model writes it, stage timeouts
- **Streaming Responses** - Real-time token and reasoning streaming
- **Structured Output** - `responseFormat` with a Zod schema, validated and repaired once on mismatch
- **Handoffs & Approvals** - Pass a conversation to another agent; pause runs for human approval and resume them later
- **Permissions & Budgets** - Claude Code compatible allow, ask and deny rules, modes from plan to bypass, an audit log, and session budgets that pause instead of failing
- **Subagents & Commands** - Claude Code compatible `.claude/agents/*.md` subagents behind one `agent` tool, approvals that bubble up through nested checkpoints, background subagents continued by id, git worktree isolation, and `.claude/commands/*.md` templates expanded from `/name args`
- **Steering & Interrupts** - `cog.start()` handles to `steer`, `followUp`, `inject` and `abort` a run going on, double-texting strategies per thread, tools that pause a run to ask a person (`context.interrupt()`), cancellation that keeps what was shown and done
- **Prompt Versions & A/B Tests** - Versioned instructions per agent with `cog.prompts`
- **Memory Integration** - In-memory, Redis, PostgreSQL, SQLite, MongoDB and Qdrant adapters
- **Agent Memory Tools** - `search_memory`, `open_turns` and `list_entities` with a citation lock, and memory files under `/memories` through the `memory` tool, Anthropic's own `memory_20250818` on Claude 4 and later through the Anthropic backend, a tool with the same commands everywhere else
- **Memory Between Runs** - A pre-turn brief of cards quoting their sources (`memory.brief`), observations of entities (`memory.observations`), and a background pass that marks repeats stale and folds lessons into a playbook (`memory.consolidation`, `cog.consolidateMemory()`)
- **Forget, Redact, Rewind** - `cog.forget()`, `cog.redactEntries()` and `cog.rewind()` take turns, threads or a whole user out of memory with every summary, item, fact, vector and memory file derived from them
- **26 Built-in Tools** - Web search, SQL, email, GitHub, filesystem, and more
- **Reflection Engine** - Self-improvement through tool call analysis
- **Tree-of-Thought** - Advanced reasoning with branch exploration
- **Agent Optimizer** - DSPy-style learning from traces
- **Time Travel** - Checkpoint, replay, fork, and compare executions
- **Causal Reasoning** - Pearl's do-calculus, counterfactuals, d-separation
- **Resilience** - Retry, circuit breaker, and fallback patterns
- **PII Masking** - Personal data and secrets replaced with placeholders before they reach the provider
- **Run Middleware** - Hooks around every model and tool call, tripwire guards that stop a run
- **Agent Skills** - `SKILL.md` skills from the host or the workspace, activated on demand with `use_skill`, `write_todos` planning kept in the thread, deferred tools found with `tool_search`
- **Workspace** - Files and commands confined to one directory (`LocalWorkspace`, `DockerWorkspace`), `workspaceTools()`, long tool results saved there for the model to page through
- **Observability** - OpenTelemetry GenAI spans, one trace across runs, workflows and swarms, OTLP and Langfuse exporters

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
  // model: 'openrouter/deepseek/deepseek-v4-pro'
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
      openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY!, // chat models of every provider, and decision models
      },
      vllm: {
        baseUrl: 'http://localhost:8000/v1',
      },
    },
  },
});
```

The runtime does not read provider keys from the environment: pass them under `providers` (or build the config with `loadConfig()` from `@cogitator-ai/config`, which reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the rest). Ollama defaults to `http://localhost:11434`. A model string without a known provider prefix runs on `llm.defaultProvider` (Ollama when unset). An agent without `model` uses `llm.defaultModel`. `llm.backends` registers backends of your own by name (`model: 'my-backend/some-model'`), and `llm.retry` (2 retries with exponential backoff by default, `false` to disable) applies to every backend the runtime creates. Azure (`endpoint`, `apiKey`, `apiVersion`, `deployment`), Bedrock (`region`, credentials, `endpoint` for a VPC endpoint or a proxy) and Mistral / Groq / Together / DeepSeek (`apiKey`) are configured the same way under `providers`. Anthropic and Google take a `baseUrl` for a proxy or gateway (Google's includes the API version, default `https://generativelanguage.googleapis.com/v1beta`), and `anthropic`, `google`, `openai`, `openrouter` and `vllm` take `headers` sent with every request. Ollama takes `headers` for non-streaming and streaming chat requests to `/api/chat`. It preserves the JSON content type and lets `apiKey` override custom authorization headers regardless of casing. Invalid HTTP headers are rejected when constructing the backend.

See [LLM Backends](https://cogitator.app/docs/core/llm-backends) for every provider's options.

### Provider Notes

- **OpenAI** - the official backend uses the Responses API and defaults to `gpt-6.1-sol`. Requests are stateless (`store: false`), reasoning items are round-tripped between tool-call turns via `ToolCall.replay`. Reasoning models (o-series, GPT-5+) get no `temperature` / `top_p` and, on Chat Completions, `max_completion_tokens`. Requests with stop sequences fall back to Chat Completions (the Responses API has no stop parameter). OpenAI-compatible providers (Azure, Mistral, Groq, Together, DeepSeek, vLLM, custom `baseUrl`) stay on Chat Completions. Force either path with `providers.openai.api: 'responses' | 'chat-completions'`. Usage includes `cachedInputTokens` and `reasoningTokens` when reported.
- **Azure** - a deployment serving a reasoning model gets no `temperature` / `top_p` and `max_completion_tokens`, told by its name (`azure/gpt-5`) or by `providers.azure.model` when the name is your own. `apiVersion` defaults to `2025-04-01-preview`.
- **Anthropic** — defaults to `claude-sonnet-5-5`. Sampling params are omitted for Claude 4.7+, 5.x and Fable (they reject non-default values); Claude 4.0 – 4.6 get at most one of `temperature` / `top_p` (`temperature` wins). `json_schema` uses native structured outputs on Claude 4.5+. Forced tool choice falls back to `auto` with a system-prompt instruction and a one-time warning on Opus/Sonnet 5.5 and Fable.
- **Bedrock** — Claude models follow the same sampling and tool-choice rules; `json_object` and `json_schema` response formats are supported (schema enforced via `outputConfig.textFormat` on Claude 4.5 – 4.6, system-prompt instruction otherwise).
- **Google** - Gemini has no `null` schema type, so `.nullable()` fields in response schemas and tool parameters are sent as `nullable: true`. A prompt Gemini blocks fails with `LLM_CONTENT_FILTERED`.
- **OpenAI-compatible servers** - `profile` on `providers.openai` and `providers.vllm` says what the server takes: a preset (`openai`, `generic`, `vllm`, `ollama`, `lmstudio`, `llamacpp`, `groq`, `together`, `deepseek`, `mistral`, `openrouter`) or `{ server?, maxTokensField?, streamUsage?, reasoningEffort? }` over one. It decides `max_tokens` or `max_completion_tokens`, whether streams send `stream_options.include_usage`, and which `reasoning_effort` values go out (the nearest one the server takes, ties go higher). Mistral, Groq, Together and DeepSeek use their own preset, any other server `generic`, the request as before. See [Server Profiles](https://cogitator.app/docs/core/llm-backends#server-profiles).

```typescript
providers: {
  openai: { apiKey: 'lm-studio', baseUrl: 'http://localhost:1234/v1', profile: 'lmstudio' },
  vllm: { baseUrl: 'http://gpu-box:8000/v1', profile: { server: 'vllm', reasoningEffort: false } },
}
```

### Pricing

A call whose provider reports no cost is priced from `@cogitator-ai/models`, which knows the LiteLLM catalogue offline too. `llm.pricing` sets prices of your own in USD per million tokens, for a fine-tune, a model the catalogue lacks or a negotiated rate, and wins over the registry in run cost, cost-routing budgets, `cog.estimateCost()`, Tree of Thoughts and `cog.decide()`:

```typescript
const cog = new Cogitator({
  llm: {
    pricing: {
      'openai/ft:gpt-4o-mini:acme': { input: 0.3, output: 1.2 }, // this model string and those ending in it
      'llama3.3:70b': { input: 0.6, output: 0.6, inputCached: 0.06 }, // at any provider
    },
  },
});

cog.pricer.pricing('vllm/llama3.3:70b'); // { input: 0.6, output: 0.6, inputCached: 0.06 }
```

A key matches the model string or its tail after any `/`, case-insensitively. A call with no reported cost and no known price counts as $0, and the runtime warns once per such model, naming the `llm.pricing` key to set. Ollama and vLLM calls are free unless `llm.pricing` prices them, even when a reseller lists a model of the same name, and never warn. `cog.pricer` is a `CallPricer`.

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

`response.finishReason` is the same for every provider: `stop`, `tool_calls`, `length`, `content_filter`, `refusal` or `error`. Only a `tool_calls` turn runs tools: a finished turn with complete tool calls is one even when the provider reported `stop` (vLLM, LM Studio and other OpenAI-compatible servers do for forced tools), and a turn cut at the token limit, filtered or refused carries no tool calls, so a call cut off mid-arguments never runs with partial or empty ones. A finished call whose arguments are not valid JSON, or not a JSON object, never runs either: it keeps the reason in `argumentsError`, and the model gets `Invalid arguments: ...` as its result and can call again. The built-in backends settle each turn with `normalizeTurn()`, and the runtime applies it to every turn, backends of your own included.

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
    console.log('Kind:', error.kind); // why it failed, e.g. 'rate_limit' or 'quota'
    console.log('HTTP status from the provider:', error.details?.statusCode);
    console.log('Retryable:', error.retryable, 'after', error.retryAfter, 'ms');
  }
}
```

`error.kind` (also `details.kind`) is one of `rate_limit`, `quota`, `authentication`, `permission`, `not_found`, `invalid_request`, `context_overflow`, `content_filter`, `overloaded`, `server_error`, `timeout`, `network` and `invalid_response` (`LLMErrorKind` in `@cogitator-ai/types`). It is read from the provider's own error codes first and the HTTP status second: OpenAI-compatible servers by `error.code` / `error.type`, Anthropic by `error.type`, Gemini by `status` and its `QuotaFailure` / `ErrorInfo` details, Bedrock by the AWS exception name, also for an error inside a stream that already began. An exhausted quota is `LLM_QUOTA_EXCEEDED` and never retried, even as a 429: OpenAI `insufficient_quota`, `credit_balance_exhausted` and spend or usage limits, Anthropic `billing_error` and an `invalid_request_error` or `rate_limit_error` about a credit balance or a usage limit, a 402 from OpenRouter, Gemini `RESOURCE_EXHAUSTED` at 402 or on a per-day quota, Bedrock `ServiceQuotaExceededException`. A 504 is `LLM_TIMEOUT`. `classifyProviderError(provider, status, body)` returns the kind for backends of your own.

`error.message` always carries what the provider said (`[openai] Bad request: Unsupported parameter: ...`). `LLM_CONTEXT_LENGTH_EXCEEDED` is reported only for the providers' own context overflow errors, not for any bad request that mentions tokens.

A call the caller aborts fails with the abort reason (`signal.reason`) instead of a retryable LLM error, on every backend and also for a stream that already began, including the OpenAI and Bedrock streams whose SDKs used to end quietly. `abortReason(signal)` returns that error.

### Fallback Models

An agent with `fallbackModels` keeps answering when its model cannot. A turn moves to the next model, in order, when `model` is down, overloaded or timing out after its retries, out of quota, rejects the key or no longer exists. `content_filter` and `invalid_request` failures and an aborted run never move:

```typescript
const agent = new Agent({
  name: 'support',
  model: 'anthropic/claude-sonnet-5-5',
  fallbackModels: [
    'openai/gpt-6.1-sol',
    { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
  ],
  instructions: 'Answer support questions.',
});

const result = await cog.run(agent, {
  input,
  onModelFallback: ({ from, to, error }) => console.warn(`${from} -> ${to}: ${error.message}`),
});
result.modelUsed; // 'openai/gpt-6.1-sol' when a fallback gave the final answer
```

Every turn starts from `model` again. Each model has a circuit breaker shared by the runtime's runs (`llm.modelCircuitBreaker`, default 5 failures in a row, 30 s), which opens at once on a lasting failure such as an exhausted quota. A stream moves only before its first token, a fallback turn is priced at the model that answered it and leaves an `llm.fallback` span, and when every model fails the run ends with `LLM_UNAVAILABLE` (or the error code every model failed with), the failures in `details.attempts`. Agents without `fallbackModels` behave as before.

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
  fallbackModels: ['anthropic/claude-sonnet-5-5'], // see Fallback Models
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

### Agent Skills from SKILL.md

Skills in the [Agent Skills](https://agentskills.io/specification) format are folders with a `SKILL.md` (YAML frontmatter with `name` and `description`, then instructions) and the files they need. A `SkillRegistry` finds them in `dirs`, in a `project` folder, with `user` in the home folder, and in the run's workspace (`.agents/skills`, `.cogitator/skills`, `.claude/skills`), the first of a name winning (`precedence: 'workspace'` puts the workspace before the host folders). Skills are trusted content: their instructions reach the model as they are, so load them only from places you trust. The model sees each skill's name and description in an `<available_skills>` section of the system prompt and activates one with the built-in `use_skill({ skill })`, which returns the body, the skill folder and its files. Host skills' files are read with `read_skill_file({ skill, path })`, confined to the skill folder, workspace skills' with `read_file`:

```typescript
import { Agent, SkillRegistry } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'maintainer',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You maintain this project.',
  skills: [new SkillRegistry({ project: process.cwd(), user: true })],
});
```

Frontmatter is read leniently: a skill without a description is skipped, other problems (a name that breaks the rules or differs from its folder, wrong types) load with a warning in the catalog's `diagnostics`. `allowed-tools` is kept on the skill as `allowedTools`, not enforced. Instructions past `maxInstructionChars` (20 000) are cut with a note, a workspace skill never follows a symbolic link, a repeated `use_skill` returns a short note, and the newest `use_skill` results (up to 40 000 characters) survive tool output clearing and compaction. See [Skills](https://cogitator.app/docs/core/skills).

### Todo Lists and Tool Search

`todos: true` gives the agent `write_todos({ todos: [{ id, content, status }] })`: each call replaces the list, at most one item is `in_progress`. The list is read back from the conversation, copied to the thread's metadata (`todos`, with the entry it was written at, so other branches do not take it) for later runs, reported with `onTodos` and returned as `result.todos`.

A tool marked `deferred: true` keeps its schema out of the requests. The run offers `tool_search({ query, limit })` instead, which ranks the deferred tools with BM25 over names, descriptions and parameters and loads the best ones from the next turn on. The loaded set is read from the `tool_search` results in the history, so resumed and forked runs keep it. A call to a deferred tool that was never loaded still runs. Loading a tool changes the tool list and so the prompt cache prefix.

```typescript
const agent = new Agent({
  name: 'back-office',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You run the back office. Plan multi-step work with write_todos.',
  tools: [lookupCustomer, tool({ ...invoiceConfig, deferred: true })],
  todos: true,
});
```

See [Todo Lists](https://cogitator.app/docs/core/todos) and [Tool Search](https://cogitator.app/docs/tools/tool-search).

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

Runs cache their prompt by default: Anthropic requests, and Claude through OpenRouter (`OpenAIBackend` with `provider: 'openrouter'`), mark the end of the agent's instructions, so runs with different input share them, the end of the history a memory context was built from and of the turn before it (`Message.cacheBreakpoint`), so the next turn on a thread reads the history from the cache, up to four marks in all, and the end of the conversation when another turn is likely (tools or earlier turns, `promptCache.conversation` overrides it), Bedrock requests mark their stable prefix, OpenAI and Gemini cache on their own, and `usage.cachedInputTokens` / `cacheWriteTokens` are priced at the model's cache prices (1-hour writes, `cacheWrite1hTokens`, at their own price). `llm.promptCache: { ttl: '1h' }` or `false` changes it.

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

`tool()` also takes `category`, `tags`, `sideEffects`, `requiresApproval`, `timeout`, `sandbox` and `maxResultLength`, plus `title`, `outputSchema` and MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), which an MCP server sends to its clients. `providerTypes` names the tool's type in a provider's own catalog, such as `{ anthropic: 'memory_20250818' }`: the Anthropic backend sends the tool as that type instead of its schema (the memory tool only to the Claude models that take it, Claude 4 and later), every other backend sends the schema. `withParsedArguments(tool)` keeps a tool's approval, sandbox, timeout and limits with a pass-through schema, for `cogitator.invokeTool()` calls whose arguments were already parsed with the tool's schema (by the MCP SDK or the AI SDK).

The name must be one every provider accepts: letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters (the strictest of the OpenAI, Anthropic, Gemini and Bedrock rules). `tool()` throws a `TypeError` for any other name, with a name that fits, instead of the run failing later with a provider error. `normalizeToolName('weather.get')` gives `weather_get` for names built from data, `normalizeToolNames(names)` keeps a whole set distinct, `isProviderSafeToolName(name)` checks one, and `assertToolName(name)` throws the same error for tools you build without `tool()`. A parameter with `.default()` is optional in the JSON Schema the model sees, and `execute` receives the default when the model leaves it out. Tools passed to `new Agent({ tools })` lose their individual parameter types in a plain array, while `toolset(...tools)` keeps them as a typed tuple that agents still accept:

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

For results with several parts or other media, return `toolContent(...)`: text and images reach the model as content, file parts (audio, PDFs) stay with the result for the application (`onToolResult`) and the model sees only a one-line description of each:

```typescript
import { toolContent } from '@cogitator-ai/core';

execute: async ({ text }) =>
  toolContent(
    { type: 'text', text: 'Speech synthesized' },
    { type: 'file', data: mp3.toString('base64'), mediaType: 'audio/mpeg', filename: 'speech.mp3' }
  );
```

A `json` part carries structured data: the application gets the value as it is, the model reads it as JSON. A `resource` part names a file, document or page by its `uri`, with an optional `name`, `description` and `mediaType`. With `text` the model reads the contents under a line naming the resource, with `data` (base64) it reads a description and the application gets the bytes, with neither it reads just the line, as a link:

```typescript
execute: async ({ id }) =>
  toolContent(
    { type: 'json', value: { id, status: 'shipped', carrier: 'DHL' } },
    { type: 'resource', uri: `file:///orders/${id}.md`, mediaType: 'text/markdown', text: notes }
  );
```

The model reads at most `limits.maxToolResultLength` characters of a result (default 100 000, about 25 000 tokens), so one huge output cannot fill the context. A longer result keeps its start and its end, with a note in the middle of how much was left out, and a tool's own `maxResultLength` overrides the limit. `onToolResult` still gets the whole result, while `RunResult.messages` and the thread history keep what the model read.

Tool parameter schemas reach every provider self-contained: definitions recursive `z.lazy()` schemas refer to travel in `parameters.$defs`, other refs are inlined (`toToolParameters` does this for any JSON Schema).

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

A paused run's `output` is not the agent's answer. `isPausedRun(result)` tells the two apart, the run result wire format (`toAgentWireRunResult`) keeps `status`, `pendingApprovals` and `checkpoint` across processes, and `AgentRunPausedError` (code `RUN_PAUSED`) reports a pause where the caller cannot wait for a decision.

To run a single tool call outside a run with the same checks (schema, approval, guardrails, sandbox, `tool.timeout`, the Cogitator's `wrapToolCall` middleware), use `cog.invokeTool(tool, args, { onApproval })`. A call nobody approves is refused with `pendingApproval` set, since there is no run to pause. Pass `{ agent }` for the gates a run of that agent applies: the guardrails are built with its model unless `guardrails.model` is set, as for a run of it, and its own `wrapToolCall` middleware wraps the call after the Cogitator's.

`onMemoryEntry(entry)` hears each entry a run saves to its thread (the input, each model turn, tool results, session events such as an `interrupt`), also for a run that is aborted or fails, before its promise rejects. An assistant entry with `metadata.interrupted: true`, as a voice turn the user talked over leaves it, reaches the model with `[interrupted by the user]` after its text (`historyMessage()` from `@cogitator-ai/types`), so the model does not take the part that was said as a finished reply.

### Steering, Interrupts and Cancellation

`cog.start()` runs an agent like `run()` and hands back what steers it while it goes on:

```typescript
const handle = cog.start(agent, { input: 'Plan the release', threadId });
handle.steer('Skip the changelog'); // after the current tool calls, before the next model call
handle.followUp('Then draft the announcement'); // once the agent would stop
handle.inject('The release moved to Friday'); // context for the next model call, never wakes the agent
const result = await handle.result; // or handle.abort(), which returns what was not delivered
```

`queue: { steering, followUp }` takes queued messages `'one-at-a-time'` (default) or `'all'` at once. Each delivered message is saved to the thread as a user message with `metadata.queued`, and a run that pauses returns the rest in `result.undelivered`. Queued messages pass the same `beforeRun` input checks as the input (PII `block`, prompt injection, input guardrails): a refused one is dropped and listed in `handle.refused` (`onRefusedMessage`), the run goes on.

`multitaskStrategy` (per run, or for every run in the config) says what a run does when its thread has a run going on: `enqueue`, `reject` (`THREAD_BUSY`), `interrupt` (the running one fails with `RUN_INTERRUPTED`) or `rollback` (interrupt, then branch from where the interrupted run started). Unset, runs of one thread go on side by side as before.

A tool pauses the run to ask a person with `context.interrupt({ reason, message, responseSchema, expiresAt })`. The run returns `status: 'paused'` with the question in `result.interrupts`, and `cog.resume(agent, threadId, { responses: { [interrupt.id]: answer } })` checks the answer against the schema (or fails with `INTERRUPT_ANSWER_INVALID`, `INTERRUPT_EXPIRED` after `expiresAt`) and runs the tool again, where `interrupt()` now returns the answer. Pending approvals are listed there too, as `kind: 'approval'`. `parseAnswer(text, schema)` and `answerFormat(schema)` from `@cogitator-ai/types` read a typed or spoken answer by the question's schema, `cog.pausedRun(threadId)` lists what a thread waits on and `cog.cancelPause(threadId, { userId, reason })` ends the pause with declined results.

### Permissions

Rules decide tool calls before anyone is asked, in the grammar of Claude Code's `permissions` settings: `allow`, `ask` and `deny` lists of `Tool` or `Tool(specifier)` rules. Claude Code's names map onto the workspace tools (`Bash` to `run_command`, `Read` to `read_file`, `Edit` to `edit_file`, `Write`, `Glob`, `Grep`) and a tool's own name works too. A deny of any layer wins, then ask, then allow:

```typescript
const cog = new Cogitator({
  permissions: {
    allow: ['Bash(npm test *)', 'Read'],
    ask: ['Bash(git push *)'],
    deny: ['Bash(rm -rf *)', 'Read(.env)'],
    settings: true, // also read .claude/settings.json, .cogitator/settings*.json, ~/.claude, managed files
  },
});

const coder = new Agent({
  name: 'coder',
  instructions,
  tools: workspaceTools(),
  workspace,
  permissions: { mode: 'acceptEdits' },
});
```

Command lines are tokenized as a shell reads them and matched on their argument vector: an allow needs every command fully understood and covered (no substitutions, wrappers that run other code, writes outside the workspace or unsafe variables), a deny or ask matches every command the line may run, wrappers, `sh -c` and `git` global options taken off. Path rules use gitignore patterns checked with `..` resolved and symlinks followed, and `Read`/`Edit` rules also cover the files shell commands name, a command that touches a whole directory (`rm -r`, `grep -r`, `find`, `cp -r`...) everything inside it. The grammar is Claude Code's, the differences are listed in the docs. A tool joins a family by declaring `access: { kind: 'read' | 'edit' | 'command', paths?, command? }`, MCP tools carry `mcp: { server, tool }` for `mcp__server__tool` rules. Modes: `default` (edits ask unless allowed), `acceptEdits` (edits inside the workspace run), `dontAsk` (what would ask is refused), `plan` (read-only until the model's `exit_plan_mode` plan is approved through an interrupt of kind `plan`), `auto` (a classifier model, `permissions.classifier`, decides what would ask) and `bypassPermissions` (everything but deny rules, only for isolated environments). `cog.start()` handles switch the mode with `setPermissionMode()`. An approval answers with `updatedArguments` (checked against the schema and the rules again) or `remember` ("always allow", saved to the session or a settings file). `resolvePermission(tool, args, context)` is the one decision behind the run loop, `invokeTool()` and `agentAsTool()`, and every decision is logged as an `approval` entry and reported to `onPermissionDecision`. While a skill is active, its `allowed-tools` are allow rules of the run. Nothing changes without `permissions`. See [Permissions](https://cogitator.app/docs/tools/permissions).

### Session Budgets

`budget: { session: { maxCostUsd, maxTokens, maxToolCalls }, agent: {...}, warnAt, onWarning }` (and `AgentConfig.budget`) limit what a thread spends across its runs and what each agent spends in it. A run that reaches a limit pauses with an interrupt of kind `budget` before its next model call or tool turn: resume with `{ action: 'stop' }` to end the run (`result.budgetStop`), or with a higher `budget` of the host's own to go on. `budget.allowRaise: true` lets an answer raise a limit (`{ action: 'continue', limit }`) or go past it (`{ action: 'continue' }`). The spending is kept in the thread's metadata (`result.sessionSpend`). `limits.onExceeded: 'interrupt'` makes `maxTokensPerRun` and the cost routing budgets pause the same way instead of failing. See [Session Budgets](https://cogitator.app/docs/core/budgets).

An aborted run keeps the text it streamed as an assistant message with `metadata.interrupted: true` (unless `saveInterruptedReply: false`), answers the tool calls it never started with `ABORTED_BEFORE_DISPATCH`, and never writes the late result of a tool that ignored the signal. History read from memory answers tool calls a crash left without a result with `OUTCOME_UNKNOWN` ("outcome unknown, verify before retrying"), without rewriting the log. See [Steering, Interrupts and Cancellation](https://cogitator.app/docs/core/run-control).

### Hooks

Commands, HTTP endpoints, model prompts and MCP tools that run at points of a run, in the format of Claude Code's `settings.json` `hooks`: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `Stop` and `Notification`:

```typescript
const cog = new Cogitator({
  hooks: {
    settings: { root: '/srv/repo', trusted: true }, // also .claude/settings*.json of that root, ~/.claude, managed files
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.js'],
              if: 'Bash(rm *)',
            },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'Are all tasks done? $ARGUMENTS' }] }],
    },
  },
});
```

A command gets the event's JSON on stdin (never on its command line) and answers with its exit code (2 blocks, with stderr as the reason) and JSON on stdout (`permissionDecision`, `updatedInput`, `additionalContext`, `decision`, `continue`, `updatedToolOutput`...), in its own process group killed at its `timeout`, with `CLAUDE_PROJECT_DIR` and `COGITATOR_PROJECT_DIR` set. HTTP hooks post the JSON to their URL only (no redirects, `allowedHttpHookUrls`), prompt hooks ask a model for `{ ok, reason }`, `mcp_tool` hooks call a tool through `hooks.mcp`. `PreToolUse` runs before the permission rules (`allow` skips an approval only the mode or the tool would ask for, an `ask` rule still asks, `defer` pauses the run), `PermissionRequest` answers an approval before `onApproval`. `PreToolUse` runs for each call right before it starts, and a hook that matches Claude Code's tool names (`Bash`, `Read`, `Edit`...) gets Claude Code's input shape. A project's own hooks run only for a trusted root (`trusted` with `root`, or `trustedRoots`), `hooks.env: { allow }` narrows the environment of commands, every handler run is logged as a `custom` entry and reported to `hooks.onHookRun`. The hooks are the run middleware `cogitator:hooks`, outermost. Nothing runs without `hooks`. See [Hooks](https://cogitator.app/docs/core/hooks).

### Project Instructions

`instructions: { projectFiles: true }` reads the `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` of the run's workspace, from the root down to its `cwd`, into the agent's system prompt, with `@path` imports (relative, at most 4 hops, cycles stopped, inside the workspace unless `allowImportsFrom` allows a directory), the rules of `.claude/rules/` (rules with `paths` frontmatter and the files of deeper directories join the conversation once a tool reads or edits a file they cover) and a size limit (`maxChars`, 32 000) with a notice of what was cut. `result.instructions` lists what was read, and the thread's log gets a `custom` entry. Off by default. See [Project Instructions](https://cogitator.app/docs/core/project-instructions).

### Subagents

`subagents` gives runs agents to delegate to, in the format of Claude Code's subagents: Markdown files with YAML frontmatter in `agents/` folders, and definitions in code shaped like Claude Code's `--agents` JSON. Runs get an `agent` tool that takes `description`, `prompt`, `subagent_type`, `model`, `run_in_background` and `name`, like Claude Code's `Agent` tool:

```markdown
---
name: reviewer
description: Reviews code changes. Use it after edits.
tools: Read, Grep, Glob
model: sonnet
permissionMode: plan
maxTurns: 8
---

You are a senior reviewer. Report concrete problems with file and line.
```

```typescript
const cog = new Cogitator({
  llm: { modelAliases: { sonnet: 'anthropic/claude-sonnet-5' } },
  subagents: {
    files: { root: '/srv/repo', trusted: true }, // .agents/agents, .cogitator/agents, .claude/agents
    agents: { researcher: { description: 'Researches a topic', prompt: 'You research.' } },
    approvalMode: 'bubble',
  },
});
```

The frontmatter fields are Claude Code's: `name` and `description` (required), `tools` and `disallowedTools` (permission rule names, `Agent` lets the subagent delegate further), `model` (`inherit`, an alias of `llm.modelAliases`, or `provider/model`), `permissionMode` (it can only narrow the delegating run's mode, never widen it), `maxTurns` (its `maxIterations`), `skills` (full instructions preloaded), `mcpServers` (names of servers the run has, or inline ones connected through `subagents.mcp`), `hooks` (`Stop` runs as `SubagentStop`), `memory` (`user`, `project` or `local`, a notes folder with an `agent_memory` tool and `MEMORY.md` in the prompt), `background`, `isolation: worktree` (a git worktree under `.cogitator/worktrees/`, removed when the subagent changed nothing), `color` and `effort`. A file without frontmatter or `name` is documentation, a broken one is skipped with a diagnostic (`subagents.onDiagnostic`). Precedence is managed, code, the host's `dirs`, the project (only once trusted, as for hooks), then the user's folders. A subagent gets the delegating run's mode and `session` rules, its tool calls are charged to the session of the run that delegated, an `Agent(name)` deny rule refuses it, `AgentConfig.subagents` limits which ones an agent may use, and `maxDepth` (3) caps nesting. A background subagent runs on its own run handle: `send_message` steers it or continues it once it finished, `task_output` reads its result, `task_stop` stops it, and a run that would stop waits for the ones it started and reads their results as a notice (a paused or failed run stops them). `cog.listSubagents()` lists them. See [Subagents](https://cogitator.app/docs/core/subagents).

### Commands

`commands` expands an input that names a command (`/review src/app.ts`) before the run starts, in the format of Claude Code's custom commands: Markdown files in `commands/` folders (`frontend/component.md` is `/frontend:component`) and templates in code. `$ARGUMENTS` is everything after the name, `$ARGUMENTS[N]` and `$N` the argument at 0-based position `N` (quotes keep words together), `$name` a named argument of `arguments`, `\$` escapes, `${CLAUDE_PROJECT_DIR}` is the project root, and arguments no placeholder takes are added as `ARGUMENTS: ...`. `allowed-tools` become allow rules of that run when permissions are set up, `model` runs it on another model, `description` and `argument-hint` are for a client's menu (`cog.listCommands()`). The project's files count once it is trusted, `result.command` reports what was expanded. See [Commands](https://cogitator.app/docs/core/commands).

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

In `mask` mode the answer, its stream and tool call arguments get the real values back, so `send_email({ to: '[EMAIL_1]' })` reaches the tool as the real address. `detect` limits the built-in kinds (`PII_TYPES`: `email`, `phone`, `credit_card`, `iban`, `ssn`, `ip_address`, `api_key`). In a run the masking is middleware closest to the model, so it also masks what your [middleware](#run-middleware) adds. `piiMiddleware(config)` masks the runs of one agent only, and `PiiMasker`, `PiiVault` and `withPiiMasking` work outside a run. See [Security](https://cogitator.app/docs/advanced/security).

### Tool Context

Every tool receives a context object:

```typescript
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal; // aborted on run cancel or tool timeout
  toolCallId?: string;
  threadId?: string;
  userId?: string; // the run's userId
  channelType?: string;
  channelId?: string;
  topicId?: string; // the topic of the chat, such as a Telegram forum topic or a Slack thread
  conversationId?: string; // the conversation, when channelId does not name it (Bluesky, Threads)
  deps?: unknown; // the run's deps, typed with ToolContext<YourDeps>
  interrupt?: <T>(request: InterruptRequest<T>) => Promise<T>; // pause the run to ask a person
  update?: (progress: ToolProgress) => void; // what the tool has so far, see Tool Execution
}
```

### Tool Execution

Tool calls of a step run one after another by default. With `parallelToolCalls: true` the calls that are safe to run together run as a pool of `maxParallelToolCalls` (default 10), and a call that is not safe is a barrier: it waits for every call before it, runs alone, then the rest go on. Results reach the model in call order. `isConcurrencySafe` (`true`, or a check of the call's arguments) defaults to the MCP `annotations.readOnlyHint`, so a tool that declares neither runs alone. After a call that asks a question (`context.interrupt()`) no further call of the step starts.

`lockKeys` names what a call changes: calls whose keys meet never run at the same time, in this run or any other of the process (`toolLocks`, a FIFO `KeyedLock`). `fileLockKey(path)` is `file:` and the real path, symlinks followed. The read tools of `workspaceTools()` and `file_read` / `file_list` / `file_exists` are concurrency-safe, `write_file`, `edit_file`, `file_write` and `file_delete` lock the file they change. Keys are let go only once the tool's own promise settles, also after a timeout or an abort, and they are re-entrant along the call lineage: a nested run or `invokeTool()` started from a tool takes a key that tool holds without waiting. Time waiting for a key or for the step does not count toward `toolMs` or `tool.timeout`. A call a `wrapToolCall` middleware made unsafe by changing its arguments waits for the running calls and runs alone (`StepGate`). A paused run keeps `parallelToolCalls`, `maxParallelToolCalls` and `timeouts` in `checkpoint.toolExecution`, and `resume()` reuses them unless its options set them.

```typescript
import { fileLockKey, tool, toolOutput } from '@cogitator-ai/core';

const saveNote = tool({
  name: 'save_note',
  description: 'Writes a note',
  parameters: z.object({ path: z.string(), text: z.string() }),
  isConcurrencySafe: true, // different files are written together
  lockKeys: async ({ path }) => [await fileLockKey(path)], // one file, one writer at a time
  presentation: ({ path }) => ({ label: 'Save note', icon: 'file-plus', detail: path }),
  execute: async ({ path, text }, context) => {
    context.update?.({ content: 'writing' }); // reaches onToolUpdate, never the model
    const diff = await notes.write(path, text);
    return toolOutput({ content: { path, saved: true }, details: { diff } });
  },
});

await cog.run(agent, {
  input: 'Save the meeting notes',
  parallelToolCalls: true,
  stream: true,
  timeouts: { stepMs: 60_000, chunkMs: 15_000, toolMs: 20_000 },
  onToolUpdate: ({ name, content }) => console.log(name, content),
  onToolInputDelta: ({ toolCallId, delta }) => preview(toolCallId, delta), // arguments as the model writes them
  onToolResult: ({ result, details, presentation }) => ui.step(presentation, result, details),
});
```

- `toolOutput({ content, details?, presentation? })`: the model reads `content`, `onToolResult` gets `details` and `presentation` too, and memory keeps them in the metadata of the call's `tool_result` entry, never in what a model reads back. `toolOutputContent(value)` is what a model reads of any result, and the AI SDK tools and realtime voice sessions send the model only `content` too. A tool's own `presentation` (a value or a function of the arguments) is used when the result carries none, failed calls too.
- `context.update({ content?, details?, presentation? })` reports progress to `onToolUpdate` (`invokeTool(..., { onUpdate })`), and servers stream it as the `tool-update` event. Updates after the tool returned are dropped.
- In a streamed run `onToolInputStart`, `onToolInputDelta`, `onToolInputAvailable` and `onToolInputAbandoned` (and the tool's own `onInputStart` / `onInputDelta` / `onInputAvailable` / `onInputAbandoned`) see each call while the model writes it. Available fires as soon as a call is complete, and every started call ends in `onToolCall` or in abandoned (`reason: 'incomplete'` when its arguments never came complete, `'discarded'` when the turn kept no such call). OpenAI-compatible backends, OpenAI Responses, Anthropic and Bedrock stream the arguments piece by piece and an `end` when the call is complete, Gemini and Ollama report each whole call at once. A custom backend emits `start`, `delta` and `end` parts in `delta.toolInput` of `chatStream`.
- `timeouts` (run or agent, merged field by field, all off by default): `totalMs` the whole run (`RUN_TIMEOUT`), `stepMs` one model call with its retries and fallbacks (`RUN_STEP_TIMEOUT`), `chunkMs` a streamed call without a chunk (`RUN_CHUNK_TIMEOUT`), `toolMs` the calls of tools without their own `timeout`, which fail with `errorCode: 'TOOL_TIMEOUT'` while the run goes on.

See [Concurrency](https://cogitator.app/docs/tools/concurrency), [Results and Progress](https://cogitator.app/docs/tools/results), [Streaming Tool Input](https://cogitator.app/docs/tools/streaming-input) and [Stage Timeouts](https://cogitator.app/docs/tools/timeouts).

### Tool Dependencies

Give tools a database client, an API key or the signed-in user without putting them in the prompt: pass them as `deps`, and annotate the tool's context with their type.

```typescript
import { Agent, tool, type ToolContext } from '@cogitator-ai/core';

interface AppDeps {
  db: Database;
  userId: string;
}

const listOrders = tool({
  name: 'list_orders',
  description: "List the signed-in user's orders",
  parameters: z.object({ limit: z.number().default(10) }),
  execute: async ({ limit }, { deps }: ToolContext<AppDeps>) =>
    deps.db.orders.findMany({ where: { userId: deps.userId }, take: limit }),
});

const agent = new Agent<AppDeps>({ name: 'support', instructions: '...', tools: [listOrders] });

await cog.run(agent, { input: 'Where is my order?', deps: { db, userId: session.userId } });
```

`deps` reach every tool of the run, handed-over agents, agents run as tools and `cog.invokeTool(tool, args, { deps })`, and never the model, memory, spans, the result or a paused run's checkpoint: pass them again to `resume()`. `new Agent<AppDeps>` makes `deps` required in `run()` and `resume()` and refuses tools whose deps type is unrelated to `AppDeps`. Declare every field the tools read in it: tool methods are compared loosely, so a tool reading a field `AppDeps` lacks still compiles. Server adapters, channels, swarms, workflows and the worker start runs without `deps` for now.

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

`timeout` is enforced for every tool: native tools get an aborted `context.signal` and the model receives a `Tool "<name>" timed out after <ms>ms` error; sandboxed tools forward it to the sandbox executor. Cancelling a run (`signal` in the run options) stops a sandboxed command too: the process is killed, its container removed or its WASM plugin closed, and the call fails with the abort reason. The sandbox is initialized lazily on the first sandboxed call, and that call already runs inside it.

### Workspace

A `Workspace` is the directory an agent works in: file access and commands that cannot leave its root (`..`, absolute paths elsewhere and symlinks out are refused with a `WorkspaceError` of code `OUTSIDE_ROOT`). `LocalWorkspace` is a directory of this machine, `DockerWorkspace` from `@cogitator-ai/sandbox` runs the commands in a container. `workspaceTools()` gives the agent `read_file` (by line range), `write_file`, `edit_file` (exact, unique replacement), `list_files`, `glob`, `grep` (in a worker thread, so a runaway pattern cannot block the process) and `run_command`, named apart from the global `file_*` and `exec` built-in tools.

```typescript
import { Agent, LocalWorkspace, workspaceTools } from '@cogitator-ai/core';

const workspace = new LocalWorkspace({ root: './project' });
const coder = new Agent({
  name: 'coder',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'Fix the failing test.',
  tools: workspaceTools(),
  workspace,
});

await cog.run(coder, { input: 'The parser test fails' });
await cog.run(coder, { input: 'Same for this project', workspace: otherWorkspace });
await workspace.dispose();
```

Tools and middleware get the run's workspace as `context.workspace` (`RunOptions.workspace`, else the agent's). A workspace starts itself on first use, the runtime only uses it, and whoever creates it disposes it. Only regular files are read and written, writes are atomic (a temporary file renamed over the target), and `remove` and `rename` check what they move and never replace an entry they did not check, so a symlink swapped in at the wrong moment cannot reach outside the root. `remove` and `rename` refuse with code `BUSY` while a command the workspace started still runs. Commands run in their own process group with a trimmed environment, a call returns when the command exits, its background processes stopped then unless `background: 'keep'`, and a timeout, an abort or `dispose()` kills the group. When a tool result is longer than the model may read and the agent has the `read_file` of `workspaceTools()`, the full text is saved in the workspace that `read_file` reads to `.cogitator/tool-results/<runId>/<toolCallId>.txt` (ignored by git, removed after `limits.toolResultRetention`, 7 days by default) and the model gets a preview with the path, to page through with `read_file`. `remove(path, { trash: true })` moves entries to `.cogitator/trash/`. See [Workspace](https://cogitator.app/docs/tools/workspace).

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

Registering a different tool under a name that is taken replaces it with a warning, since the model can only ever call one of them. Pass `{ replace: true }` to `register` or `registerMany` when replacing is the intent. In a run, a tool of the agent replaces a tool of the same name in `cogitator.tools` without a warning. A tool built without `tool()` whose `maxResultLength` is not a positive integer throws on `register`.

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

The file tools act with the permissions of your process. `restrictFileTools(tools, roots, { base, requireApproval })` confines them to directories (symlinks followed, a path outside answers with an error) and can make writes need approval, and `isPathAllowed(path, roots)` is the check itself:

```typescript
import { fileDelete, fileList, fileRead, fileWrite, restrictFileTools } from '@cogitator-ai/core';

const workspaceTools = restrictFileTools(
  [fileRead, fileList, fileWrite, fileDelete],
  ['./workspace'],
  {
    base: './workspace',
    requireApproval: (tool) => tool.sideEffects?.includes('filesystem') ?? false,
  }
);
```

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

| Factory                                                                                                        | Tools                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMemoryTools({ graphAdapter, agentId, coreFacts?, embeddingFn?, items?, memory? })`                      | `remember`, `recall`, `forget` on a knowledge graph and memory items (`items`). With `memory`, `remember` keeps a fact as the user's only when its `quote` is in one of the run user's own messages on the thread's active branch, and `recall` ranks the items with the `MemoryRetriever` of `hybrid` recall |
| `createMemorySearchTools({ memory, agentId, items?, embedding?, messageIndex?, timeZone?, placeOf? })`         | `search_memory`, `open_turns`, `list_entities`: the agent searches the turns of its thread and memory items itself, with references to cite. `cog.memorySearchTools(memoryAgentId)` builds them over the runtime's memory                                                                                     |
| `memoryFileTool({ memory, agentId, scope?, readOnly?, placeOf?, files? })`                                     | `memory`: notes under `/memories` with the commands of Anthropic's memory tool, sent as the native `memory_20250818` to Claude 4 and later. `memory.files` gives it to every agent                                                                                                                            |
| `createSchedulerTools({ store, defaultChannel?, defaultUserId? })`                                             | `schedule_task`, `list_tasks`, `cancel_task` on a `TimerStore`                                                                                                                                                                                                                                                |
| `createDeviceTools()`, `createCapabilitiesTool(doc)`, `createSelfTools({ toolsDir })` / `loadCustomTools(dir)` | Device info, a capabilities description, and tools an agent writes to a directory                                                                                                                                                                                                                             |

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
  context: { task: 'analysis' }, // data for the model, sent with the input
  deps: { db }, // values for the tools (context.deps), never sent to the model

  timeout: 60000,
  timeouts: { stepMs: 30_000, toolMs: 10_000 }, // deadlines of a model call and of a tool call
  signal: controller.signal,
  stream: true,
  onToken: (token) => process.stdout.write(token),
  onReasoning: (delta) => process.stdout.write(delta),
  reasoning: { effort: 'low' }, // overrides the agent's reasoning for this run

  useMemory: true,
  loadHistory: true,
  saveHistory: true,
  // history: earlierMessages, // the conversation you hold, read instead of the thread's memory
  branch: { fromEntryId: entryId, activate: false }, // run on a branch of the thread's memory
  brief: `Current date and time: ${new Date().toISOString()}`, // notes for this turn, sent with the input, not saved
  asOf: new Date('2026-03-09T18:00:00Z'), // the moment memory reads the turn at, now by default
  parallelToolCalls: true, // run the concurrency-safe calls of a step together (default: false)
  maxParallelToolCalls: 4, // most calls at once (default: 10)
  multitaskStrategy: 'enqueue', // wait while another run of this thread goes on
  toolChoice: 'required', // force a tool call until the model makes one, then 'auto'

  onApproval: (request) => ({ approved: request.toolName !== 'delete_account' }),
  onHandoff: (handoff) => console.log(`${handoff.from} -> ${handoff.to}`),
  onModelFallback: ({ from, to }) => console.warn(`${from} failed, using ${to}`),
  onToolCall: (call) => console.log('Tool:', call.name),
  onToolResult: (result) => console.log('Result:', result.result),
  onToolUpdate: (update) => console.log('Progress:', update.name, update.content),
  onToolInputDelta: ({ toolCallId, delta }) => console.log(toolCallId, delta), // needs stream: true
  onSpan: (span) => console.log('Span:', span.name),
  onRunStart: ({ runId }) => console.log('Started:', runId),
  onRunComplete: (result) => console.log('Completed'),
  onRunError: (error, runId, usage) => console.error('Error:', error, 'spent', usage?.cost),
  onMemoryError: (error, op) => console.warn(`Memory ${op} failed`),
  onMemoryEntry: (entry) => console.log('Saved', entry.type, entry.id),
});
```

`toolChoice` sets which tools the model may or must call. `'none'` keeps it from calling any on every turn. `'required'` or a named function (`{ type: 'function', function: { name: 'weather' } }`) forces a call on each turn until the model makes one, then the run goes back to `'auto'`, so the model can answer from the results instead of calling tools until `maxIterations`. A named function the agent does not have fails the run with `VALIDATION_ERROR`.

`audio` inputs are transcribed with OpenAI `gpt-transcribe` (`llm.providers.openai.apiKey` or `OPENAI_API_KEY`) and prepended to `input` before guardrails and prompt-injection checks run. History loaded from memory is repaired before it is sent: a tool call a stopped run left without a result gets one that says its outcome is unknown, and tool results without their assistant call are dropped, so a truncated window never produces an invalid provider request.

### Run Result

```typescript
interface RunResult {
  output: string;
  structured?: unknown; // parsed output when the agent has a responseFormat
  runId: string;
  agentId: string;
  threadId: string;
  modelUsed?: string; // the model of the final answer, when cost routing or a fallback picked it
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
  interrupts?: RunInterrupt[]; // what a paused run waits on: approvals and questions of tools
  undelivered?: QueuedRunMessage[]; // messages queued on a cog.start() handle it did not take
  checkpoint?: RunCheckpoint; // pass to cog.resume()
  toolCalls: ToolCall[];
  messages: Message[];
  trace: { traceId: string; spans: Span[] };
  reflections?: Reflection[];
  reflectionSummary?: ReflectionSummary;
  memory?: { threadId: string; branchPoint: string | null; leafId?: string }; // where the run wrote
}
```

All fields are `readonly`. The run timeout comes from the run, the agent, `limits.defaultTimeout`, or 120 s.

A run whose last answer the provider withheld still completes, with `blocked` saying why: `content_filter` when its safety system filtered the answer (OpenAI and Azure `content_filter`, Gemini `SAFETY` and the like, Bedrock guardrails), `refusal` when the model declined (OpenAI `refusal`, Anthropic `refusal`). `output` holds what the model said before it stopped, the explanation of a refusal or often nothing, and the run does not ask again.

A turn the provider ends in an error fails the run with `LLM_INVALID_RESPONSE` instead of passing for an empty answer, with the provider's explanation when it gives one (`ChatResponse.finishMessage`). Gemini, for instance, reports a function call it could not complete, often one cut by `maxTokens`, as `MALFORMED_FUNCTION_CALL`: the run fails with that message, and the cut call never runs. Anthropic and Bedrock `malformed_tool_use` and a failed Responses API answer end the same way.

### Run Observers

A run observer watches every run of a runtime, including the runs that agent tools start on it. Pass observers in the config, or attach one later with `observe()`, which returns the function that detaches it. `close()` closes them, so exporters flush:

```typescript
import { Cogitator, createOTLPExporter } from '@cogitator-ai/core';

const otlp = createOTLPExporter({ endpoint: 'http://localhost:4318/v1/traces', enabled: true });
otlp.start();

const cogitator = new Cogitator({ observers: [otlp.observer()] });
const stop = cogitator.observe({
  onRunStart: (event) => console.log(`${event.agentName} started ${event.runId}`),
  onSpan: (span, run) => console.log(run.runId, span.name, span.duration),
  onRunComplete: (result) => console.log(`cost $${result.usage.cost}`),
});
// ...
stop();
await cogitator.close(); // flushes the OTLP exporter
```

An observer that throws is logged without failing the run. `createLangfuseExporter(...).observer()` traces every run in Langfuse the same way.

### Run Middleware

Observers only watch. Middleware changes what a run does: it wraps each model call and each tool call, so masking, guards, caching, argument rewriting and logging live in one place instead of in every tool. Give middleware to the Cogitator (every run), the agent or the run:

```typescript
import { Agent, Cogitator, tripwire, type RunMiddleware } from '@cogitator-ai/core';

const timing: RunMiddleware = {
  name: 'timing',
  async wrapModelCall(call, next) {
    const started = Date.now();
    const response = await next(call);
    metrics.record(call.model, Date.now() - started);
    return response;
  },
};

const refundGuard: RunMiddleware = {
  name: 'refund-guard',
  beforeRun({ input }) {
    if (/refund/i.test(input)) tripwire('Refunds go to a person', { queue: 'billing' });
  },
};

const cog = new Cogitator({ middleware: [timing] });
const agent = new Agent({ name: 'support', instructions: '...', middleware: [refundGuard] });
await cog.run(agent, { input, middleware: [auditFor(userId)] });
```

| Hook                | When                                                  | What it can do                                                                  |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `startRun`          | A run starts, new or resumed                          | Return `{ context }` for after the system prompt, this run only                 |
| `beforeRun`         | A new run's input, before it is saved or sent         | Check it, return `{ context }` for after it. Not called on `resume()`           |
| `beforeModel`       | Before each model turn                                | Return `{ messages }` to change the conversation from then on                   |
| `wrapModelCall`     | Around each call, once per model a turn tries         | Change the request or the stream sink, call `next` again, or answer without it  |
| `afterModel`        | After each answer, before the run uses it             | Return `{ content }` or `{ toolCalls }` to replace them                         |
| `beforeToolCall`    | Before the permissions decide a tool call             | `deny`, `ask`, `allow` or `defer` it, or change its arguments                   |
| `decideApproval`    | A call asks for approval, before `onApproval`         | Approve or decline it as a person would                                         |
| `wrapToolCall`      | Around each tool call that passed approval            | Change the arguments (checked against the schema again), or answer for the tool |
| `afterToolBatch`    | Every call of a step resolved                         | Add context (`context.addContext`) or end the run (`context.stop`)              |
| `beforeStop`        | The agent would stop with a final answer              | Return `{ continueWith }` to keep it going                                      |
| `beforeCompaction`  | Before a compaction of the turn or the thread         | Return `{ skip: true }`                                                         |
| `afterCompaction`   | After a compaction ran                                | Log or react                                                                    |
| `beforeModelSwitch` | A handoff would move the run to another model         | Return `{ block }` to keep the run on its agent                                 |
| `onNotification`    | The run needs a person                                | Tell someone                                                                    |
| `afterRun`          | A run ended: `event.status` completed, paused, failed | Work for the next run (extraction, compaction) or cleanup                       |

Every hook gets the run's context: `runId`, `threadId`, the agent, `userId`, the channel, `iteration`, `signal`, `deps`, a `state` map the run's middleware share, `parentRunId` for a delegated run, `permissionMode`, and `addContext(text)`, `stop(reason)` (the run completes with `result.stopped`) and `logEvent(event, note)` (a `custom` entry of the thread). The [hooks](#hooks) run first, then the Cogitator's middleware, then the agent's, then the run's, then the built-in ones: PII masking (`security.pii`), prompt injection (`security.promptInjection`), guardrails (`guardrails`), tool output clearing (`context.clearToolOutputs`), compaction (`context`), extraction of memory items after the run (`memory.extraction`), compaction of the thread after the run (`memory.compaction`), memory upkeep in the background after the run (`memory.observations`, `memory.consolidation`) and the brief of what memory holds for a turn (`memory.brief`), closest to the model. `before*` and `afterRun` hooks run in that order, `wrap*` hooks nest with the first outermost, `afterModel` runs in reverse. After a handoff the agent the run went on as brings its own middleware. To see each turn as the run keeps it, after every layer, pass `onModelTurn` in the run options: it gets `{ content, toolCalls, model }` before the turn's tools run.

`tripwire(reason, info?)` stops the run as a guard that tripped: it fails with `GUARDRAIL_TRIPPED` (HTTP 400), the middleware, the reason and `info` in `details`, and `isTripwire(error)` tells it apart. Any other error a hook throws fails the run as it is, and a hook still running when the run is cancelled or times out is no longer waited for. Arguments a `wrapToolCall` hook changes are checked against the tool's schema and `requiresApproval` again, and an approval never carries over to them. Every call a `wrapModelCall` hook sends counts toward usage and budgets, an answer it gives without the model counts nothing and still reaches `onToken` in a streamed run. A middleware with `holdsStream: true` makes a streamed run hold each turn's text until the turn is done, so text a hook retries, blocks or replaces never reaches `onToken`. A tripwire raised inside a tool, such as a nested `agentAsTool()` run, stops the outer run too. The Cogitator's `wrapToolCall` hooks also wrap `invokeTool()`, which throws an error they throw (a tripwire among them) while a failing tool still comes back in `error`. `toAgentWire()` does not carry middleware and warns when an agent has some. `piiMiddleware`, `promptInjectionMiddleware`, `guardrailsMiddleware`, `clearToolOutputsMiddleware`, `compactionMiddleware`, `memoryCompactionMiddleware`, `memoryBriefMiddleware` and `memoryUpkeepMiddleware` build the built-in ones, to give a feature to one agent only. `memoryCitations()` is a middleware to add yourself, the citation lock of the memory search tools (see [Memory Integration](#memory-integration)). `afterRun(event, context)` runs once a run ended, before `run()` returns or throws: check `event.status` (`completed` and `paused` carry `result`, `failed` carries `error`). An error it throws is logged, the run keeps its outcome.

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
      maxTokens: 4000, // optional: without it the history gets what the run's model has room for
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

`adapter` also accepts `'sqlite'` (`sqlite.path`), `'mongodb'` (`mongodb.uri`) and `'redis'` (`redis.url`, or `redis.host` + `redis.port`, or `redis.cluster`). Qdrant stores embeddings, not threads: configure it in `memory.qdrant` next to a thread adapter, together with `memory.embedding` and `memory.contextBuilder.includeSemanticContext`, and semantic context is retrieved from it. The Postgres adapter sizes its vector column to the `memory.embedding` model. Runs with a `threadId` load history from and save messages to the adapter. With `contextBuilder`, the agent's instructions are always sent and counted in the budget, and a part of the context that fails to load (history, facts, semantic search) is passed to `onMemoryError` as a `'load'` failure while the run goes on.

The context is ordered for the prompt cache: the system message (the instructions), then the history with cache breakpoints on its last message and on the last message of the turn before, then one user message with a `<memory_context>` block in front of the input: what memory recalled for the turn (facts, semantic results), the run's `brief`, its `context` and the insights of reflection. Only the input is saved to the thread. Without `contextBuilder.maxTokens` the runtime gives the builder the model's window minus the answer and the tool schemas, once, with `reserveTokens: 0`, and the builder counts the input in it. The `agent.run` span reports the tokens of each partition as `context.tokens.<partition>`. See [Memory Context and Prompt Caching](https://cogitator.app/docs/core/cogitator#memory-context-and-prompt-caching).

`memory.compaction` compacts a run's thread after the run, once the conversation of its branch passes `at` (default 0.8) of the window of the model the run ended on:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    compaction: {
      at: 0.8,
      keepRecentTokens: 20_000, // default: the less of 20000 and a quarter of the window
      beforeCompact: () => ({ instructions: 'Keep every price that was quoted.' }), // or false to skip
      afterCompact: (result) => console.log(result),
    },
  },
});
```

The thread is compacted hierarchically (see [Hierarchical Compaction](https://cogitator.app/docs/memory#hierarchical-compaction)): the newest turns stay verbatim and the rest becomes a handoff of grounded atoms, written by `summaryModel` or the model the run ended on, which the next run reads in their place. `run()` returns once it is done. A thread that outgrows its window again within two turns of its last compaction is not compacted again, with a warning to use `context.clearToolOutputs` instead, a run on another branch than the active one is left alone, and a compaction that fails is logged while the run keeps its result. `anthropicCompactionSummarizer({ model, client?, apiKey?, maxTokens? })` is a `SummarizeFn` for `CompactionService` that has Anthropic's compaction on request (`ANTHROPIC_COMPACTION_BETA`, `compact-2026-09-04`) write the answer, which is checked like any other, and the signed block is not kept.

`memory.extraction` extracts memory items from a run's conversation after the run, which later runs of the same user read as facts with `contextBuilder.includeFacts`:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    contextBuilder: { strategy: 'recent', includeFacts: true },
    extraction: {
      scope: 'user', // default, or 'agent' / 'thread'
      timeZone: 'Europe/Lisbon', // a thread's metadata.timeZone wins, UTC by default
      mode: 'shadow', // items stay suggested until activated, 'apply' by default
      afterExtract: (items) => console.log(items.map((item) => item.content)),
    },
  },
});
```

The entries of the active branch new since the last extraction (the thread keeps its cursor in `metadata.memoryExtraction`, `EXTRACTION_CURSOR`), or a first extraction's run entries (a first extraction that fails is taken up by the next one, and the thread keeps its place after every window), are read in windows by `extraction.model` (the model the run ended on by default), every item checked against its quotes: only what the user said with quotes that hold becomes `active`. Items are kept under the agent's configured `id`, else its `name` (`memoryAgentId(agent)`, also on the `afterRun` event), and belong to the run's own user, never the thread's owner. A window the model could not answer three extractions in a row is left out, never one a provider or storage failure stopped, and runs of one thread extract one after another. A run without a user keeps its items in the thread's scope, and a thread `metadata.timeZone` that is not an IANA zone falls back to `timeZone`. The calls are counted in the run's costs and `usage`, a failure is logged while the run keeps its result and the thread waits a minute (doubling up to an hour) before the next try. It is the built-in middleware `cogitator:memory-extraction` (`memoryExtractionMiddleware`), whose `afterRun` runs before the compaction's. With `includeFacts`, a store that keeps memory items (every built-in one) gives the context the items the run's agent, user and thread see that hold now, one state per slot, in place of `FactAdapter` facts. See [Extraction After a Run](https://cogitator.app/docs/memory#extraction-after-a-run).

Without a `strategy`, `contextBuilder` uses `hybrid` when `memory.embedding` is set and `recent` otherwise: on the [memory benchmarks](https://cogitator.app/docs/memory/benchmarks) `hybrid` averaged 44.9% over seven datasets against 18.0% for `recent`, as much as `relevant` (44.6%) at three quarters of its cost. Set `strategy: 'recent'` to keep the newest turns only. Compaction and extraction stay off by default: compaction saves input tokens and helps on threads up to about 100K tokens but was no better than `recent` on longer ones, and extraction gained less than `hybrid` everywhere, so turn it on with `extraction.mode: 'shadow'` first, which keeps every new item `suggested` and out of the context until you activate it.

`contextBuilder.strategy: 'hybrid'` keeps the newest turns as history and recalls older turns and memory items a search of memory finds for the turn into the `<memory_context>` block (`Earlier in this conversation:` and `From memory:`). `memory.reranker`, any `Reranker` such as `CohereReranker` from `@cogitator-ai/rag`, reorders the best 30 hits. The search resolves the time a turn names ("yesterday") from the run's `asOf` (now by default, set it to replay or evaluate a recorded conversation) in the thread's `metadata.timeZone`, else `contextBuilder.timeZone`, else `extraction.timeZone`, else UTC, and reads memory items as of `asOf`. A run counts the facts and recalled items it sent to the model (`timesRetrieved`, `lastRetrievedAt`) once it finishes or pauses, in the background, and `close()` waits for those writes. See [Recall](https://cogitator.app/docs/memory#recall).

With `relevant` or `hybrid` and `memory.embedding`, every memory gets a message index: in the embedding store when there is one, else in process (a lasting store without one keeps up to 50,000 vectors, of the threads used lately). Every entry of a thread is embedded once in the background, an embedding per message, plus one of the input per turn. After importing a conversation, `indexMemory(threadId)` embeds what the index has not reached yet, a page at a time, and returns once the vectors are stored:

```typescript
await cog.indexMemory('imported-thread'); // does nothing without an index
```

`memory.files` gives every agent the `memory` tool: notes under `/memories` it views and edits across conversations, with the commands of Anthropic's memory tool. Claude 4 and later get it as Anthropic's native `memory_20250818` tool (`ToolConfig.providerTypes`), every other model as a tool with the same commands. The runtime lists the files a run sees in its memory context, each with its size and first line, up to `indexChars` (2000), and the agent views them when it needs them:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    files: { scope: 'user' }, // 'user' (the thread for a run without a user), 'agent' or 'thread', and readOnly
  },
});
```

Every change is a version of its own, kept under the agent's memory id: a run in a thread sees the versions of its own branch, an edit of a file another writer changed since the run viewed it fails, and two writers never add the same version. A store that keeps no memory files is warned about once and the tool is left out. See [Memory Files](https://cogitator.app/docs/memory#memory-files). The memory tool refuses every change of `/memories/playbook.md`, `/memories/playbook.next.md` and anything under `/memories/observations/`, a rename into one of them included, with `<path> is kept by memory itself and is read-only here`, and views them as any other file (`MemoryFileAccess.reserved`, `MEMORY_RESERVED_PATHS`).

`memorySearchTools(memoryAgentId)` returns tools an agent searches memory with on its own: `search_memory` (earlier turns of the thread and memory items in one ranked list, the search of `hybrid` recall), `open_turns` (turns whole with the turns around them) and `list_entities` (what memory knows about, with item counts). Their results carry references, `[item:<id>]` and `[turn:<id>]`, and the `memoryCitations()` middleware takes out of a final answer each reference the run never opened, calling `onUncited`:

```typescript
import { Agent, Cogitator, memoryCitations } from '@cogitator-ai/core';

const cog = new Cogitator({
  memory: { adapter: 'sqlite', sqlite: { path: './memory.db' } },
  middleware: [memoryCitations({ onUncited: (references) => console.warn(references) })],
});

const agent = new Agent({
  name: 'concierge',
  instructions: 'Answer from memory. Cite what you rely on as [turn:<id>] or [item:<id>].',
  tools: await cog.memorySearchTools('concierge'), // the agent's memory id: its configured id, else its name
});
```

See [Agent Memory Tools](https://cogitator.app/docs/memory#agent-memory-tools).

Memory also works between runs, each piece off unless set, all of them on every built-in thread store:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    contextBuilder: { strategy: 'hybrid', maxTokens: 8000 },
    extraction: {},
    brief: { model: 'google/gemini-3.5-flash-lite' }, // cards for the turn before its first model call
    observations: {}, // what memory makes of each entity, next to the facts
    consolidation: { everyRuns: 20, playbook: 'apply' }, // repeats go stale, lessons reach the playbook
  },
});

const report = await cog.consolidateMemory(agent, { userId: 'ana' }); // a pass now, such as from a worker
```

- `memory.brief` (`model`, `maxCards` up to 4, `timeoutMs` 4000, `maxTokens` 600, `prompt`): before the first model call of a run a cheap model reads what memory found for the input, its 12 best sources among the earlier turns of the run's branch and the memory items it sees, ranked as `hybrid` recall ranks them, and writes cards (a constraint, knowledge, a consequence or an open thread), each quoting its source. Only cards whose quote the source holds word for word go into the turn's memory context, marked as a hint, never into the system message. A timeout, a failure, a run without memory or nothing found leaves the turn as it was. A `maxCards` outside 1 to 4, a `timeoutMs` not above 0 or a `maxTokens` that is not a whole number above 0 throws when the runtime builds the brief. A quote must hold at least three words, and the prompt tells the model the sources and the message are data.
- `memory.observations` (`model`, `maxEntities` 3, `minItems` 3, `prompt`): after a run, in the background, the observations whose facts changed are written again as memory files under `/memories/observations/`, each statement citing the items it stands on. A turn whose input names an entity, or that recalls one of its items, gets up to three of them next to the facts, with `memory.contextBuilder` set (they are written either way).
- `memory.consolidation` (`model`, `everyRuns` 20, `afterCompaction` true, `maxChanges` 10, `maxSubjects` 10, `playbook` `apply`, `shadow` or `false`, `showPlaybook` true, `prompt`, `afterConsolidate`): every `everyRuns` runs of a thread, and after `memory.compaction` compacted it (a compaction that changed nothing starts none), a pass in the background marks as stale the items a model finds to repeat or contradict a newer one, at most `maxSubjects` subjects a pass, the next pass going on where it stopped, folds new `active` lessons, never one from a tool or a page, into `/memories/playbook.md` in at most three edits, then writes the observations. Each run then sees the playbook as a hint while `showPlaybook` is on, which alone decides it: `playbook: false` only stops new lessons from reaching it. `shadow` writes the edited playbook to `/memories/playbook.next.md` for a review instead.

No run waits for upkeep: passes run one at a time per memory scope, the model calls they make count in the cost router but not in a run's usage, and `close()` stops the passes under way. `consolidateMemory(agent, { userId?, threadId?, since? })` runs a pass now and returns what it changed (`MemoryConsolidationReport`, with `dedupe: { complete, through? }`), for the memory `memory.extraction.scope` keeps the agent's items in. With the `user` extraction scope (the default) it needs a `userId`, or a `threadId` for the memory of runs without a user, with `thread` a `threadId` (even with a `userId`), and with `agent` nothing. It throws `VALIDATION_ERROR` when neither `memory.consolidation` nor `memory.observations` is set, or when memory keeps no memory items. A pass on demand asks `consolidation.model` for repeats and lessons and `observations.model` for observations, each falling back to the agent's model (`llm.defaultModel` when the agent has none), while a pass after a run falls back to the model the run ended on. See [Between Runs](https://cogitator.app/docs/memory#between-runs). With `security.pii` the model calls of the brief, the observations and the consolidation, like those of memory extraction and compaction, are masked as a run's own calls are, since they go through the same routed backend. In `redact` mode nothing is restored, so placeholders such as `[EMAIL_1]` end up in what memory keeps (items, observations, the playbook, summaries), numbered per call. A version of the playbook or of an observation a model wrote (`author: 'model'`) is never shown to runs or read as an observation, only those memory itself or a user wrote. A playbook every user of the agent shares (a scope without a user, project or thread, as with `memory.extraction.scope: 'agent'`) takes only `system` lessons in `apply` mode, since one user's lesson would reach every other user, and `shadow` drafts the rest for review. When `report.dedupe.complete` is false a cap stopped the look for repeats, and calling again with `since: report.dedupe.through` goes on from there.

The adapter connects on the first run. To read threads before that (for example in an API route), use `getMemory()`, which connects it on first use; `cog.memory` stays `undefined` until something connected it:

```typescript
import { unwrap } from '@cogitator-ai/memory';

const memory = await cog.getMemory(); // undefined when memory is not configured
if (memory) {
  const entries = unwrap(await memory.getEntries({ threadId: 'thread_123', limit: 20 }));
}
```

### Runs on Branches

A thread's memory is a tree of entries. A run goes on after the thread's active leaf by default, `branch` runs it from another entry: history is read along the branch ending at `fromEntryId` (`null` for none), and the run's entries go after it. `activate: false` keeps the thread's active leaf where it was, so the run writes a branch of its own:

```typescript
const first = await cog.run(agent, { input: 'Plan a day in Rome', threadId: 'trip' });
await cog.run(agent, { input: 'Make it cheaper', threadId: 'trip' });

const other = await cog.run(agent, {
  input: 'Make it a museum day instead',
  threadId: 'trip',
  branch: { fromEntryId: first.memory!.leafId!, activate: false },
});
// other saw the first question and answer, not the cheaper plan
```

`result.memory` says where a run wrote (`threadId`, `branchPoint`, `leafId`). A branch needs an adapter with `getPath` (every built-in one) and an entry of the thread, else the run fails with `VALIDATION_ERROR`. The runtime also records session events as entries: `model_change` on a fallback, `approval` when a run pauses, `interrupt` when one is aborted or times out. A paused run resumes on its branch. A run with `activate: false` leaves the thread's paused run alone and is resumed with its checkpoint, not the thread id.

### Forgetting, Redacting and Rewinding

Deleting a turn alone does not forget it: a fact, a summary or a playbook rule memory wrote from it would still reach the next run. These methods follow the lineage of what memory derived into every store:

```typescript
await cog.forget({ entryIds: [entry.id] }); // the entries, a user message with its replies
await cog.forget({ threadId: 'chat' }); // a thread
await cog.forget({ userId: 'ana' }, { agents: [assistant] }); // every thread and everything kept for the user
await cog.redactEntries([entry.id], { reason: 'the user asked' }); // '[redacted]' in place
await cog.rewind('chat', earlier.id); // the turns after it stay on their branch, their items go stale
```

- With deleted or redacted entries go their copies in forks (`metadata.memoryForks`), the compaction summaries that cover or quote them (the next compaction writes them again), the memory items, facts (when the memory adapter is a fact store) and graph nodes and edges (with `graph`) that stand only on them (those that stand on more lose the quotes of them), their vectors, the memory file versions written at them (a file whose version in front was redacted is then deleted, so its path leaves the listing once no version on any branch still holds its text), and every version of an observation or a playbook that names an item or a lesson that went, the playbook in front first written again without those rules. A user message takes its replies, up to the next user message on every branch, unless `keepReplies: true`.
- `redactEntries` keeps each entry in its place, with its parent, its role and its tool call ids, `[redacted]` in its text, tool arguments and tool results and `reason` in `metadata.redacted`. Its tool calls lose their replay state and argument error, and a user message loses its sender `name`. An event entry among the ids or their replies (`model_change`, `approval`, `interrupt`, `label`, `custom`, or a `compaction` among the ids) is deleted, not redacted, and listed in `entries.deleted`.
- `forget({ threadId })` also purges the items and entities and redacts the memory file versions kept for that thread alone (their files then deleted), and takes the copies of its entries in its forks. `forget({ userId })` deletes every thread whose `metadata.userId` is the user whole (the messages others wrote in it too), the messages the user wrote in threads of others (those that list the user in `metadata.memoryUserIds`) with their replies, everything of the user's scope, and the facts, graph nodes and edges and embeddings whose `metadata.userId` is the user. It lists every thread to find them.
- `forget` and `redactEntries` drop the paused runs of the threads they touch (`threads` and `threadsChanged` in the report), also from a `runCheckpoints` store of your own, and a fork does not copy the paused run of its origin.
- `rewind` deletes nothing: the memory items that stood only on the turns after `toEntryId` become `stale` (`staleBecause: { reason: 'rewound' }`). It marks them before it moves the thread, so one that failed can be made again (a rewind the store refuses leaves them as they were), and a thread that stands at `toEntryId` already is left as it is. Memory extraction and compaction under way stop before their next model call once the run's branch is no longer the active one. Compaction refuses to write a summary whose entries were deleted or redacted while it was written, and extraction drops the items whose entries went while the model answered.

Items, files, facts and the graph are kept by the memory id of an agent (its configured `id`, else its name). Every run notes in the thread's metadata the memory id of its agent and of every agent it hands over to (`metadata.memoryAgentIds`), and the user it ran for (`metadata.memoryUserIds`), and a call goes through the memory of the agents the threads name. A thread written before this release names only the agents that ran in it since, so pass `agents` (agents or their memory ids) for the ones before, and for a user without threads. The lists are read again just before each write, which narrows, but does not close, the window in which two runs writing at once keep only one name. `graph` is a knowledge graph of your own to go through. Each call returns a `MemoryCascadeReport`. `MemoryCascadeCall` (`agents`, `graph`, `keepReplies`) is the type of the options of `forget` and `redactEntries`, and `rewind` takes only `agents`.

All three throw `CogitatorError` (`VALIDATION_ERROR`) when no memory is configured or the agents to go through are not known (a thread that names none and no `agents`, or a user without threads), `redactEntries` also when the adapter cannot redact, and `rewind` also when the adapter has no branches. A store that fails part of the way throws its own error, and the call can be made again, as derived memory goes before the entries.

See [Memory](https://cogitator.app/docs/memory), [Memory Adapters](https://cogitator.app/docs/memory/adapters) and [Runs on Branches](https://cogitator.app/docs/core/cogitator#runs-on-branches).

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

Steps are the run's own tool calls: a run that continues a thread keeps the earlier turns as history in its checkpoints, but their tool calls are not counted. A step past the last tool call, such as step 0 of a run without tool calls, is the moment before the final answer.

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

### Replays on Branches

Checkpoints keep where their run wrote in memory (`checkpoint.memory`). A live replay or a fork goes on a branch of the original thread from the entry the run started after, with `activate: false`: it reads the earlier conversation from memory, the thread's active leaf does not move, and two forks of one run never see each other's entries. `replay.memory` says where it wrote. A replay goes on a thread of its own (`replay_<runId>_<id>`) instead when the checkpoint has no place in memory, the memory has no `getPath`, the thread belongs to another user than the replay's `userId` (an option of replays and forks), the entry the run started after is gone, or `modifiedMessages` change the conversation before the run's input.

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

Agent runs retry failed LLM calls on their own: rate limits, 5xx, timeouts and dropped connections, with exponential backoff and the provider's `Retry-After`. An exhausted quota (`LLM_QUOTA_EXCEEDED`) is not retried. Streams are retried only before the first chunk. Tune or turn this off with `llm.retry`:

```typescript
import { Cogitator, GoogleBackend, withLLMRetry } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    retry: {
      maxRetries: 3,
      maxRetryAfter: 30_000,
      requestTimeout: 180_000, // abort and retry a call that hangs
      onRetry: (e) => console.warn(e),
    },
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

`RobotsPolicy` reads and caches a site's robots.txt and answers whether a URL may be fetched, by RFC 9309: the groups that name your product token (else `*`), longest match wins with `*` and `$` patterns, a 4xx robots.txt allows everything, a 5xx or a network failure allows nothing until the cache (one hour by default) expires. It implements `RobotsChecker`, which `WebLoader` in `@cogitator-ai/rag` and `BrowserSession` in `@cogitator-ai/browser` take as `robots`:

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

Fields left out take `DEFAULT_GUARDRAIL_CONFIG` (input, output and tool-call filtering plus critique-revision on). `InputFilter`, `OutputFilter`, `ToolGuard` and `CritiqueReviser` are the layers `ConstitutionalAI` uses, each takes `{ config, constitution }` plus `llm` for the LLM-backed ones. `cog.getGuardrails()` and `cog.setConstitution()` work before the first run when `guardrails.model` or `llm.defaultModel` names the judge model, a constitution set earlier applies once the guardrails are built. With `filterOutput` on, a streamed run hands `onToken` each turn in one chunk after the output check (the answer, its revision, or nothing when it is blocked), so blocked text never streams.

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

Old tool outputs can be cleared on their own, before any compression, the way Anthropic's `clear_tool_uses` context edit does, for every provider:

```typescript
const cog = new Cogitator({
  context: {
    enabled: false, // no compression, only clearing
    clearToolOutputs: { trigger: 100_000, keep: 3, exclude: ['read_plan'], clearAtLeast: 0 },
  },
});
```

Once a turn's conversation reaches `trigger` tokens, every tool result but the `keep` most recent ones gets a note in place of its output, which names the call and tells the model to get it back with the built-in tool `recall_tool_output({ toolCallId })` (from the run, or from the thread's memory). `clearInputs` clears the calls' arguments too, `clearAtLeast` waits until a clearing frees that many tokens so the prompt cache is not broken for little, and an awaited `onBeforeClear({ calls, tokens, tokensFreed, model }, context)` lets the application keep what matters first. It hears only of the calls the run made itself, since outputs loaded from memory are in memory already. The run goes on with the notes, while `RunResult.messages` and a paused run's checkpoint get the cleared outputs and arguments back. `recall_tool_output` reads memory only for a run that uses it, and only the branch the run is on. The `agent.run` span reports `context.cleared_tool_outputs`, `context.cleared_tool_output_tokens` and `context.clearings`.

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

Both exporters do nothing unless `enabled: true` is set, so you can build them unconditionally and switch them per environment. They are not attached automatically: wire them to the run callbacks as above, pass them in `observers`, or register them for every runtime of the process:

```typescript
import { registerTelemetry } from '@cogitator-ai/core';

const unregister = registerTelemetry(otlp.observer());
```

Spans follow the OpenTelemetry GenAI semantic conventions (`invoke_agent`, `chat`, `execute_tool` with `gen_ai.*` attributes, next to the older `llm.*`, `tool.*` and `run.*` ones), streamed model calls record their time to first chunk, and the OTLP exporter sends the convention's span names. Runs that belong together share one trace: a run started inside a tool joins the run that called the tool, workflows and swarms put their agents under their own span, and `trace` in the run options (with `parseTraceparent` for an incoming `traceparent` header) puts a run under any parent. Prompts and answers go on the spans only when asked for, with `telemetry: { captureContent: true }` or `captureContent` on an observer. See [Observability](https://cogitator.app/docs/deployment/observability).

---

## Decision Models

Decision models answer typed questions about a state with probabilities instead of text. `cog.decide()` asks them, such as TypeSafe's Jev on OpenRouter's Decisions API:

```typescript
const result = await cog.decide({
  model: 'openrouter/typesafe/jev-1.13',
  state: 'I was charged twice for my subscription this month, please refund one of them.',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should answer this message?',
      criteria: {
        billing: 'Payments and refunds',
        technical: 'Bugs and errors',
        sales: 'Plans and pricing',
      },
    },
    spam: {
      type: 'noul',
      instructions: 'Is this message spam?',
      criteria: { true: 'Advertising or nonsense', false: 'A real customer' },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is it?',
      criteria: ['later', 'this week', 'today'],
    },
  },
});

result.answers.team.choice; // 'billing' | 'technical' | 'sales', typed from the question
result.answers.spam; // { type: 'noul', probability: 0.04, value: false }
result.usage.cost; // USD, reported by OpenRouter or priced by llm.pricing and the registry
```

- `noul` asks yes or no and answers with a `probability` and a `value` by `threshold` (0.5), `choice` answers with one of its options, `confidence` and `probabilities`, `score` with a position on its ordered levels.
- The request is checked before the call (`VALIDATION_ERROR`) and the answer after (`LLM_INVALID_RESPONSE` for a missing answer, another type or an option the question does not have).
- It is retried by the same policy as LLM calls (`llm.retry`, with `LLMRetryPolicy` and `retryLLMCall` exported for calls of your own), recorded with the cost router, and reported to run observers as a run with one `llm.decide` span.
- `decisionTool(cog, { name, description, model, questions })` gives an agent a tool that asks fixed questions about the state it passes.
- A chat agent on a decision model fails with `CONFIGURATION_ERROR` instead of OpenRouter's 400. `llm.decisionBackends` takes a `DecisionBackend` of another provider.

OpenRouter is a built-in provider (`llm.providers.openrouter`, `OPENROUTER_API_KEY` through `@cogitator-ai/config`). Docs: [Decision Models](https://cogitator.app/docs/core/decisions).

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

Tool calls of the inner agent that need approval are declined unless `onApproval` decides them (`approvalMode: 'decline'`, the default), and an `onApproval` that returns `'pause'` declines too. If the inner run pauses anyway, the tool returns `success: false` with an `error` naming the tools that waited. With `approvalMode: 'bubble'` the inner agent's approvals go to the calling run's `onApproval`, and when the inner run pauses (an approval nobody decided, a question of one of its tools) the calling run pauses too: the inner checkpoint is kept in `checkpoint.turn.children[toolCallId]`, its interrupts and approvals come back under ids starting with `<toolCallId>/` (`o1/i1`, and `o1/m1/l1` two levels down), and a resume that answers them goes on inside the inner run, permission rules checked again. `messages: 'conversation'` (or a function) shows the inner agent the calling run's conversation before its task, `onDelegationStart` and `onDelegationComplete` hear each delegation. To hand the conversation over instead of calling a sub-agent, use [handoffs](#handoffs). See [Agent as Tool](https://cogitator.app/docs/tools/agent-as-tool).

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

Runs that hit their `timeout` throw `RUN_TIMEOUT` (HTTP 504, `Run timed out after <n>ms`), runs over the cost-routing budget `BUDGET_EXCEEDED` (429), and input or output blocked by guardrails (`Input blocked: …` / `Output blocked: …`) `LLM_CONTENT_FILTERED` (400), so server adapters return those statuses and messages. A failed run still reports what its finished model calls used and cost: `onRunError` gets it as its third argument, a `RUN_TIMEOUT` error carries it in `details.usage`, and each `llm.chat` span has its call's cost in `llm.cost`.

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
