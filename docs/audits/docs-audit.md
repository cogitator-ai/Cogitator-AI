# Docs Audit Report

## docs/AGENTS.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — document was fundamentally incorrect, almost every code example and API reference was wrong

### Issues Found (22 total)

#### Critical (15) — Completely wrong APIs/types

| #   | Location                  | Issue                                                                                                                                  | Fix                                                                                                           |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Agent interface           | `memory: MemoryConfig` shown on Agent — does not exist, memory is on CogitatorConfig                                                   | Removed from interface, added note about runtime-level config                                                 |
| 2   | Agent interface           | `sandbox: SandboxConfig` shown on Agent — does not exist on AgentConfig                                                                | Removed                                                                                                       |
| 3   | Agent interface           | `contextWindow`, `iterationTimeout`, `toolRetry`, `onError`, `humanApproval`, `hooks` — none exist on AgentConfig                      | Removed all from Agent, documented at correct locations                                                       |
| 4   | Context Window section    | `contextWindow` and `memory.summarization` on Agent — API wrong                                                                        | Rewrote with correct `CogitatorConfig.context` API                                                            |
| 5   | Built-in Tools            | Import from `@cogitator-ai/tools` — package doesn't exist                                                                              | Changed to `@cogitator-ai/core`                                                                               |
| 6   | Built-in Tools            | `shellExecute`, `webFetch`, `codeInterpreter` — don't exist                                                                            | Changed to `exec`, `webScrape`; removed `codeInterpreter`                                                     |
| 7   | MCP section               | `mcpServer()` from `@cogitator-ai/tools` — function doesn't exist                                                                      | Rewritten with `MCPClient.connect()` and `connectMCPServer()` from `@cogitator-ai/mcp`                        |
| 8   | Error Handling section    | `toolRetry` and `onError` on Agent — don't exist                                                                                       | Rewrote with `withRetry()` utility and `RunOptions.onRunError`                                                |
| 9   | Human-in-the-Loop section | `humanApproval` on Agent and `cog.on('approval_required')` — neither exists                                                            | Rewrote with `requiresApproval` on tools, `GuardrailConfig.onToolApproval`, and `approvalNode()` in workflows |
| 10  | Lifecycle Hooks section   | `hooks` on Agent — doesn't exist; callbacks are on RunOptions                                                                          | Rewrote with correct RunOptions callbacks                                                                     |
| 11  | Serialization             | `loadAgent` from `@cogitator-ai/core` — doesn't exist                                                                                  | Replaced with `Agent.deserialize()`                                                                           |
| 12  | Testing                   | `import from '@cogitator-ai/testing'` — package is `@cogitator-ai/test-utils`                                                          | Fixed package name                                                                                            |
| 13  | Testing                   | `MockLLM`, `MockTool` — classes don't exist; actual: `MockLLMBackend`, `createTestTool`                                                | Rewrote entire testing example                                                                                |
| 14  | Testing                   | `agent.run()` — Agent has no `run()` method, use `cog.run(agent, opts)`                                                                | Fixed                                                                                                         |
| 15  | Evaluation                | `import { evaluate, EvalDataset } from '@cogitator-ai/eval'` — package is `@cogitator-ai/evals`, actual API is `EvalSuite` + `Dataset` | Rewrote with correct API                                                                                      |

#### Medium (5) — Incorrect defaults/model formats

| #   | Location          | Issue                                                         | Fix                                          |
| --- | ----------------- | ------------------------------------------------------------- | -------------------------------------------- |
| 16  | Agent interface   | `topP` shown with "default 1" — actually undefined            | Fixed                                        |
| 17  | Basic Agent       | `model: 'llama3.3:latest'` missing provider prefix            | Changed to `'ollama/llama3.3:latest'`        |
| 18  | Agent with Tools  | `model: 'gpt-4o'` missing prefix                              | Changed to `'openai/gpt-4o'`                 |
| 19  | Structured Output | `model: 'claude-sonnet-4-5'` missing prefix                   | Changed to `'anthropic/claude-sonnet-4-5'`   |
| 20  | Integration test  | `Cogitator({ llm: { provider, model } })` — wrong field names | Changed to `defaultProvider`, `defaultModel` |

#### Minor (2) — Missing documented fields

| #   | Location        | Issue                                  | Fix   |
| --- | --------------- | -------------------------------------- | ----- |
| 21  | Agent interface | `provider` field missing from doc      | Added |
| 22  | Agent interface | `stopSequences` field missing from doc | Added |

### Rewritten Sections (features existed but were documented on wrong object)

These features exist in the codebase but the original doc incorrectly placed them on the `Agent` class. They've been rewritten with the correct APIs:

| Section                   | Original (wrong)                                  | Corrected                                                                                                                |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Context Window Management | `contextWindow` + `memory.summarization` on Agent | `CogitatorConfig.context` with 4 strategies (truncate, sliding-window, summarize, hybrid)                                |
| Error Handling / Retry    | `toolRetry` + `onError` on Agent                  | `withRetry()` / `retryable()` utilities from `@cogitator-ai/core`, plus `RunOptions.onRunError`                          |
| Human-in-the-Loop         | `humanApproval` on Agent + `cog.on()` events      | `requiresApproval` on tools, `GuardrailConfig.onToolApproval`, `approvalNode()` in workflows                             |
| Lifecycle Hooks           | `hooks: { onStart, beforeLLM, ... }` on Agent     | `RunOptions` callbacks (onRunStart, onToken, onToolCall, onToolResult, onSpan, onRunComplete, onRunError, onMemoryError) |

### Removed Sections (truly non-existent)

- Agent Lifecycle state machine diagram (core Agent is stateless — only `SwarmAgent` has states)
- YAML agent serialization / `loadAgent` (YAML only for `CogitatorConfig`, Agent serialization is JSON via `serialize()`/`deserialize()`)

### Added Sections

- **RunOptions** — full reference with all callbacks
- **RunResult** — interface reference
- **Cloning** — `agent.clone()` method
- **Serialization** — `agent.serialize()` / `Agent.deserialize()` with actual API
- **Model format** — explicit note that models use `provider/model` format
- **Azure/Bedrock** — added model format examples
- **Context Window Management** — `CogitatorConfig.context` with strategy table
- **Retry and Error Handling** — `withRetry()`, `retryable()`, LLM retryable errors
- **Human-in-the-Loop** — tool `requiresApproval`, guardrail `onToolApproval`, workflow `approvalNode()`
- **Run Lifecycle Callbacks** — all RunOptions hooks with observability exporter mention

---

## docs/API.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — document was fundamentally incorrect, almost every section had wrong APIs

### Issues Found (60+ total)

#### Critical — Non-existent APIs / completely wrong types

| #   | Section           | Issue                                                                                                 | Fix                                                                                                                                                                                                                          |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CogitatorConfig   | `telemetry` field does not exist                                                                      | Removed; added `reflection`, `guardrails`, `costRouting`, `security`, `context`, `logging`                                                                                                                                   |
| 2   | CogitatorConfig   | `memory` block had wrong structure (`embeddings` key, missing adapters)                               | Rewrote to match actual `MemoryConfig` with `adapter`, `redis`, `postgres`, `sqlite`, `mongodb`, `qdrant`, `embedding` (singular)                                                                                            |
| 3   | CogitatorConfig   | `sandbox` shown as `{ type, docker, wasm }` — wrong type name                                         | Referenced `SandboxManagerConfig` from `@cogitator-ai/sandbox`                                                                                                                                                               |
| 4   | CogitatorConfig   | `llm.providers` only showed 5 providers                                                               | Added all 10: azure, bedrock, mistral, groq, together, deepseek                                                                                                                                                              |
| 5   | CogitatorConfig   | `ollama` provider config missing `apiKey?` field                                                      | Fixed                                                                                                                                                                                                                        |
| 6   | CogitatorConfig   | Azure provider shown as `{ apiKey }` — missing `endpoint`, `apiVersion`, `deployment`                 | Fixed                                                                                                                                                                                                                        |
| 7   | Cogitator methods | `workflow(workflow): WorkflowRunner` — method doesn't exist                                           | Removed; documented `WorkflowBuilder` + `WorkflowExecutor` from `@cogitator-ai/workflows`                                                                                                                                    |
| 8   | Cogitator methods | `swarm(swarm): SwarmRunner` — method doesn't exist                                                    | Removed; documented `new Swarm(cogitator, config)` from `@cogitator-ai/swarms`                                                                                                                                               |
| 9   | Cogitator methods | `memory: MemoryManager` — wrong type                                                                  | Fixed to `memory: MemoryAdapter \| undefined`                                                                                                                                                                                |
| 10  | Cogitator methods | `on(event, handler)` / `off(event, handler)` — don't exist                                            | Removed; noted Cogitator has no event emitter, use RunOptions callbacks                                                                                                                                                      |
| 11  | Cogitator methods | Missing methods undocumented                                                                          | Added: `estimateCost()`, `getInsights()`, `getReflectionSummary()`, `getGuardrails()`, `setConstitution()`, `getCostSummary()`, `getCostRouter()`, `getLLMBackend()`                                                         |
| 12  | RunOptions        | `context?: Record<string, any>`                                                                       | Fixed to `Record<string, unknown>`                                                                                                                                                                                           |
| 13  | RunOptions        | Missing 9 fields                                                                                      | Added: `images`, `audio`, `useMemory`, `loadHistory`, `saveHistory`, `onRunStart`, `onRunComplete`, `onRunError`, `onSpan`, `onMemoryError`, `parallelToolCalls`                                                             |
| 14  | RunResult         | `structured?: any`                                                                                    | Fixed to `unknown`                                                                                                                                                                                                           |
| 15  | RunResult         | Missing fields                                                                                        | Added: `modelUsed?`, `reflections?`, `reflectionSummary?`                                                                                                                                                                    |
| 16  | AgentConfig       | `memory?: MemoryConfig \| boolean` — not in AgentConfig                                               | Removed                                                                                                                                                                                                                      |
| 17  | AgentConfig       | `sandbox?: SandboxConfig` — not in AgentConfig                                                        | Removed                                                                                                                                                                                                                      |
| 18  | AgentConfig       | `hooks?: AgentHooks` — not in AgentConfig                                                             | Removed                                                                                                                                                                                                                      |
| 19  | AgentConfig       | Missing `id?` and `provider?` fields                                                                  | Added                                                                                                                                                                                                                        |
| 20  | AgentHooks        | Entire interface doesn't exist                                                                        | Removed whole section                                                                                                                                                                                                        |
| 21  | ResponseFormat    | `schema: ZodSchema \| JSONSchema` — only Zod supported                                                | Fixed to `schema: ZodType`                                                                                                                                                                                                   |
| 22  | Agent methods     | `toYAML(): string` — doesn't exist                                                                    | Replaced with `serialize(): AgentSnapshot`                                                                                                                                                                                   |
| 23  | Agent methods     | `static fromYAML(yaml): Agent` — doesn't exist                                                        | Replaced with `static deserialize(snapshot, options?): Agent` and `validateSnapshot()`                                                                                                                                       |
| 24  | ToolConfig        | `parameters: ZodSchema<TParams>` — `ZodSchema` is not a valid Zod type name                           | Fixed to `ZodType<TParams>`                                                                                                                                                                                                  |
| 25  | ToolConfig        | `retry?: RetryConfig` — not in ToolConfig                                                             | Removed                                                                                                                                                                                                                      |
| 26  | ToolConfig        | Missing `category?` and `tags?` fields                                                                | Added                                                                                                                                                                                                                        |
| 27  | ToolContext       | 5 out of 6 fields don't exist (`tools`, `memory`, `swarm`, `progress`)                                | Rewrote to actual: `{ agentId, runId, signal }` only                                                                                                                                                                         |
| 28  | Built-in Tools    | Import from `@cogitator-ai/tools` — package doesn't exist                                             | Fixed to `@cogitator-ai/core`                                                                                                                                                                                                |
| 29  | Built-in Tools    | `fileSearch` — doesn't exist                                                                          | Replaced with `fileExists`                                                                                                                                                                                                   |
| 30  | Built-in Tools    | `webFetch` — doesn't exist                                                                            | Replaced with `webScrape` and `httpRequest`                                                                                                                                                                                  |
| 31  | Built-in Tools    | `webScreenshot` — doesn't exist                                                                       | Removed                                                                                                                                                                                                                      |
| 32  | Built-in Tools    | `codeInterpreter` — doesn't exist                                                                     | Removed                                                                                                                                                                                                                      |
| 33  | Built-in Tools    | `sqlExecute` — doesn't exist                                                                          | Removed                                                                                                                                                                                                                      |
| 34  | Built-in Tools    | 14 tools undocumented                                                                                 | Added: `uuid`, `randomNumber`, `randomString`, `hash`, `base64Encode`, `base64Decode`, `sleep`, `jsonParse`, `jsonStringify`, `regexMatch`, `regexReplace`, `exec`, `vectorSearch`, `sendEmail`, `githubApi`, `builtinTools` |
| 35  | Workflow          | `new Workflow(config)` with `WorkflowConfig` — completely wrong                                       | Rewrote to `WorkflowBuilder` fluent API with `.addNode()`, `.addConditional()`, `.addLoop()`, `.addParallel()`, `.build()`                                                                                                   |
| 36  | Workflow          | `step()` function — doesn't exist                                                                     | Replaced with `agentNode()`, `toolNode()`, `functionNode()`                                                                                                                                                                  |
| 37  | Workflow          | `StepConfig` interface — doesn't exist                                                                | Removed                                                                                                                                                                                                                      |
| 38  | Workflow          | `WorkflowContext` interface — actual is `NodeContext`                                                 | Fixed                                                                                                                                                                                                                        |
| 39  | Workflow          | `WorkflowRunner` interface — actual is `WorkflowExecutor` class                                       | Rewrote                                                                                                                                                                                                                      |
| 40  | Workflow          | `cog.workflow(workflow)` — doesn't exist                                                              | Removed                                                                                                                                                                                                                      |
| 41  | SwarmConfig       | Strategy `'collaborative'` — doesn't exist                                                            | Replaced with `'negotiation'`                                                                                                                                                                                                |
| 42  | SwarmConfig       | `specialists?: Record<string, Agent>` — doesn't exist                                                 | Removed                                                                                                                                                                                                                      |
| 43  | SwarmConfig       | `errorHandling.retry?: RetryConfig` — wrong type                                                      | Fixed to inline `{ maxRetries, backoff, initialDelay?, maxDelay? }`                                                                                                                                                          |
| 44  | SwarmConfig       | `observability.metrics` — doesn't exist in SwarmConfig.observability                                  | Removed; actual fields are `tracing`, `messageLogging`, `blackboardLogging`                                                                                                                                                  |
| 45  | Swarm             | `new Swarm(config)` — wrong signature                                                                 | Fixed to `new Swarm(cogitator, config)` + documented `SwarmBuilder`                                                                                                                                                          |
| 46  | Memory API        | `MemoryManager` interface — doesn't exist                                                             | Rewrote with actual `MemoryAdapter` interface                                                                                                                                                                                |
| 47  | Memory API        | `store()` / `retrieve()` / `buildContext()` / `summarize()` / `clear()` — none exist on MemoryAdapter | Replaced with actual methods: `addEntry()`, `getEntries()`, `clearThread()`, thread CRUD                                                                                                                                     |
| 48  | Memory API        | `Memory` interface — actual is `MemoryEntry`                                                          | Fixed                                                                                                                                                                                                                        |
| 49  | Memory API        | `RetrievalQuery` — actual is `MemoryQueryOptions`                                                     | Fixed                                                                                                                                                                                                                        |
| 50  | Events            | `cog.on('run:start', ...)` etc. — Cogitator has no event emitter                                      | Rewrote to show RunOptions callbacks instead                                                                                                                                                                                 |
| 51  | Events            | `workflow.on(...)` — no event emitter on Workflow                                                     | Rewrote to show `WorkflowExecuteOptions` callbacks                                                                                                                                                                           |
| 52  | Events            | Swarm events: `swarm.on(...)` handler parameter wrong                                                 | Fixed to `SwarmEvent` type; documented unsubscribe return value                                                                                                                                                              |
| 53  | Error Types       | `AgentError`, `ToolError`, `MemoryError`, `LLMError`, `TimeoutError`, etc. — none exist               | Replaced with single `CogitatorError` + `ErrorCode` enum usage                                                                                                                                                               |
| 54  | Error Types       | `error.toolName`, `error.provider`, `error.timeout` properties — don't exist                          | Fixed to use `error.code`, `error.details`, `error.retryable`, `error.retryAfter`                                                                                                                                            |
| 55  | TypeScript Types  | `WorkflowConfig` — doesn't exist                                                                      | Replaced with `WorkflowState`, `WorkflowNode`, `WorkflowResult`, etc.                                                                                                                                                        |
| 56  | TypeScript Types  | `RetrievalQuery` — wrong name                                                                         | Replaced with `MemoryQueryOptions`                                                                                                                                                                                           |
| 57  | TypeScript Types  | `Trace` type — doesn't exist as standalone export                                                     | Removed                                                                                                                                                                                                                      |
| 58  | TypeScript Types  | `Metrics` type — doesn't exist in core exports                                                        | Removed                                                                                                                                                                                                                      |
| 59  | TypeScript Types  | `Context` type — doesn't exist in this form                                                           | Removed                                                                                                                                                                                                                      |
| 60  | TypeScript Types  | `SwarmResult` was a separate type name — actual is `StrategyResult` for Swarm.run                     | Added `SwarmRunOptions`, `SwarmResult`, `SwarmStrategy`, `SwarmEvent`, `SwarmEventType`                                                                                                                                      |

### Result

Complete rewrite of API.md. All sections now reflect the actual source code:

- `CogitatorConfig` — all 10 providers, correct memory config with all 6 adapters
- `Cogitator` — correct methods only, no phantom `workflow()`/`swarm()`/`on()`
- `RunOptions` — all 16 fields documented
- `RunResult` — all fields including `modelUsed`, `reflections`
- `AgentConfig` — correct fields, no phantom `memory`/`sandbox`/`hooks`
- `Agent` — correct methods: `serialize()`/`deserialize()` not `toYAML()`/`fromYAML()`
- `ToolContext` — correct 3 fields only
- Built-in tools — all 22 exports from `@cogitator-ai/core`
- Workflow — `WorkflowBuilder` + `WorkflowExecutor` + `agentNode`/`toolNode`/`functionNode`
- `SwarmConfig` — all 7 strategies including `'negotiation'`, correct `observability`
- `MemoryAdapter` — correct interface, `MemoryEntry` and `MemoryQueryOptions`
- Events — RunOptions callbacks, WorkflowExecuteOptions callbacks, Swarm event emitter
- Error types — `CogitatorError` + `ErrorCode` enum

---

## docs/ARCHITECTURE.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — entire document described aspirational/non-existent architecture with wrong class names, wrong interfaces, and 13+ packages missing

### Issues Found (25 total)

#### Critical — Non-existent classes / wrong interfaces

| #   | Section               | Issue                                                                                                                      | Fix                                                                                                |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Gateway section       | `Gateway`, `Orchestrator`, `Scheduler`, `Registry Service` in control plane — none exist as described                      | Replaced with actual HTTP adapters (express/fastify/hono/koa/next)                                 |
| 2   | Gateway section       | tRPC router with `appRouter`, `protectedProcedure`, `AgentCreateSchema` — doesn't exist                                    | Removed; replaced with actual adapter API examples                                                 |
| 3   | Orchestrator section  | `TaskQueue` interface with `enqueue()`, `dequeue()`, `heartbeat()`, `complete()`, `fail()` — doesn't exist                 | Replaced with real `JobQueue` class from `@cogitator-ai/worker`                                    |
| 4   | Orchestrator section  | `BullMQTaskQueue implements TaskQueue` — class doesn't exist                                                               | Replaced with `JobQueue` with actual methods: `addAgentJob()`, `addWorkflowJob()`, `addSwarmJob()` |
| 5   | Orchestrator section  | `SmartLoadBalancer.selectWorker()` — class doesn't exist                                                                   | Removed; explained CostRouter handles model selection                                              |
| 6   | Memory section        | `MemoryManager` interface with `store()`, `retrieve()`, `buildContext()`, `summarize()`, `clear()` — none exist            | Replaced with actual `MemoryAdapter` interface                                                     |
| 7   | Memory section        | `Memory` interface — actual type is `MemoryEntry`                                                                          | Fixed                                                                                              |
| 8   | Memory section        | `RetrievalQuery` — actual type is `MemoryQueryOptions`                                                                     | Fixed                                                                                              |
| 9   | Memory section        | `ContextBuilder.buildContext()` shown with wrong `MemoryManager` API                                                       | Rewrote with actual `ContextBuilder` from `@cogitator-ai/memory`                                   |
| 10  | Sandbox section       | `DockerSandbox implements Sandbox` — class is `DockerSandboxExecutor`                                                      | Fixed class name; showed `SandboxManager` as the public API                                        |
| 11  | Sandbox section       | `execute(code, options)` signature — actual: `execute(request: SandboxExecutionRequest, config: SandboxConfig)`            | Fixed                                                                                              |
| 12  | AgentExecutor section | `this.memory.buildContext()`, `this.memory.store()` — these methods don't exist on MemoryAdapter                           | Removed phantom AgentExecutor example                                                              |
| 13  | LLM Backend section   | `listModels(): Promise<Model[]>` on LLMBackend — method doesn't exist                                                      | Removed from interface                                                                             |
| 14  | LLM Backend section   | `health(): Promise<HealthStatus>` on LLMBackend — method doesn't exist                                                     | Removed from interface                                                                             |
| 15  | LLM Backend section   | `OllamaBackend(private baseUrl: string = 'http://localhost:11434')` — actual: `constructor(config: OllamaConfig)`          | Fixed constructor                                                                                  |
| 16  | LLM Backend section   | `AnthropicBackend` missing constructor                                                                                     | Fixed to show `constructor(config: AnthropicConfig)`                                               |
| 17  | LLM Backend section   | `SmartLLMRouter` with `selectBestBackend()`, `selectFallbackBackend()` — doesn't exist                                     | Replaced with `CostRouter` documentation                                                           |
| 18  | Observability section | `AgentTrace` interface — doesn't exist                                                                                     | Replaced with actual `Span` type from `@cogitator-ai/types`                                        |
| 19  | Observability section | `exampleTrace` with wrong field names (`duration` instead of `startTime`/`endTime`, `parent` string instead of `parentId`) | Replaced with real `RunResult.trace` usage                                                         |
| 20  | Observability section | `Counter`, `Histogram`, `Gauge` as TypeScript types — not exported from the package                                        | Replaced with metric name strings                                                                  |

#### Medium — Wrong provider list / missing info

| #   | Section          | Issue                                                                                | Fix                                                                             |
| --- | ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 21  | Overview diagram | LLM backends showed `llama.cpp` as a provider — it's not a separate provider         | Removed `llama.cpp`; added `Bedrock`, `Mistral`, `Groq`, `Together`, `DeepSeek` |
| 22  | Overview diagram | gRPC listed as user interface — not implemented                                      | Removed gRPC                                                                    |
| 23  | Security section | `AuthConfig` with JWT/OIDC — described as if implemented; it's not a runtime feature | Replaced with actual sandbox isolation and constitutional AI guardrails         |

#### Missing Content (13 packages entirely undocumented)

| #   | Issue                                                                                                                                                                                    | Fix                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 24  | 13+ packages not mentioned: `rag`, `evals`, `voice`, `a2a`, `mcp`, `models`, `config`, `ai-sdk`, `self-modifying`, `neuro-symbolic`, `redis`, `openai-compat`, `worker`, `deploy`, `cli` | Added "Package Ecosystem" table listing all 31 packages |
| 25  | WASM tools not described despite being a key differentiator                                                                                                                              | Added WASM tools table with all 14 tools                |

### Result

Complete rewrite of ARCHITECTURE.md:

- Added **Package Ecosystem** table — all 31 packages across 8 layers
- Rewrote **Overview diagram** — updated LLM backends (11 providers), corrected component names, removed phantom services
- Replaced **Gateway** section with actual **HTTP Adapters** section (`express`, `fastify`, `hono`, `koa`, `next`) + OpenAI-compat usage
- Rewrote **Orchestrator** as **Distributed Job Queue** with real `JobQueue`/`WorkerPool` API
- Fixed **Memory** section with actual `MemoryAdapter` interface, `MemoryEntry`, `MemoryQueryOptions`, `ContextBuilder`
- Fixed **Sandbox** section with `SandboxManager` + `DockerSandboxExecutor`/WASM/Native, correct `SandboxExecutionRequest`
- Fixed **LLM Backend** section — removed phantom `listModels()`/`health()`, fixed all constructors, added provider table, documented `CostRouter`
- Fixed **Observability** — actual `Span` type, `OTLPExporter`, `RunResult.trace` usage
- Kept **Deployment** section (conceptually correct)
- Rewrote **Security** section with sandbox isolation + constitutional AI guardrails + prompt injection detection

---

## docs/DEPLOY.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Medium — 5 issues found, mix of doc errors and code not wired up

### Issues Found (5 total)

#### Code not implemented (3) — methods existed but were not called

| #   | Location             | Issue                                                                                                                                   | Fix                                                                                                                       |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Auto-Detection table | `memory: redis` → `services.redis: true` documented but `detectServices()` never called from `analyze()` — always `{}`                  | Wired up `detectServices()` in `analyze()`: loads full cogitator.yml via `loadConfig({ skipEnv: true })` and calls method |
| 2   | Auto-Detection table | `model: gpt-4o` → `secrets: [OPENAI_API_KEY]` documented but `detectSecrets()` never called from `analyze()`                            | Wired up `detectSecrets()` in `analyze()`: reads `fullConfig.llm.defaultModel` and calls method                           |
| 3   | Ollama Cloud warning | Warning for local Ollama on cloud target documented but `getDeployWarnings()` never called — `analyze()` always returned `warnings: []` | Wired up `getDeployWarnings()` in `analyze()`: populates `warnings` from model auto-detection                             |

#### Code limitation not documented (1)

| #   | Location        | Issue                                                                                                                                  | Fix                                                                                |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 4   | Secrets section | Doc says "The preflight check will warn if any listed secret is not set" — only `FlyProvider` checks secrets, `DockerProvider` did not | Added secrets preflight check to `DockerProvider.preflight()`, same pattern as Fly |

#### Doc errors (2)

| #   | Location               | Issue                                                                                           | Fix                                               |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 5   | fly.toml example       | Missing `[build]` section — actual template generates `[build]` after `primary_region`          | Added `[build]` to fly.toml example               |
| 6   | docker-compose example | Redis and Postgres healthchecks missing `timeout: 3s` and `retries: 3` — template includes them | Added both fields to both healthchecks in example |

### Code changes

- `packages/deploy/src/analyzer.ts` — wired up auto-detection in `analyze()`: loads cogitator.yml, calls `detectServices()`, `detectSecrets()`, `getDeployWarnings()`; updated `detectServices()` signature to be duck-typed
- `packages/deploy/src/providers/docker.ts` — added secrets preflight checks (mirrors FlyProvider)

### Verified correct

- All CLI flags (`-t`, `-c`, `--registry`, `--no-push`, `--dry-run`, `--region`) ✅
- All programmatic API (`Deployer`, `ProjectAnalyzer`, `ArtifactGenerator`, `DeployProvider`) ✅
- `DeployConfig` fields table (all 12 fields match `packages/types/src/deploy.ts`) ✅
- Dockerfile template (matches actual `dockerfile.ts` output) ✅
- fly.toml template (matches actual `fly-toml.ts` output after `[build]` fix) ✅
- Model-to-Secret mapping table ✅
- Future targets table (Railway/K8s/SSH in DeployTarget type but no provider registered) ✅
