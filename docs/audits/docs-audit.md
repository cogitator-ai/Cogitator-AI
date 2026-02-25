# Docs Audit Report

## docs/WORKFLOWS.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — entire document described a completely fictional API; every code example was broken

### Issues Found (18 total)

#### Critical (18) — All code was non-functional

| #   | Location                           | Issue                                                                                                                     | Fix                                                                                                        |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | All code examples (×30+)           | `import { Workflow, step } from '@cogitator-ai/workflows'` — neither `Workflow` class nor `step()` function exists        | Replaced with `WorkflowBuilder`, `WorkflowExecutor`, `agentNode`, `toolNode`, `functionNode`, `customNode` |
| 2   | Creating Workflows                 | `new Workflow({ name, steps: [...] })` — no such constructor; `Workflow` is a plain interface built via `WorkflowBuilder` | Rewrote all examples using `new WorkflowBuilder<S>(name).addNode(...).build()`                             |
| 3   | All step() calls                   | `step('name', { agent, input: (ctx) => ..., dependsOn: [...] })` — function doesn't exist; no `dependsOn` parameter       | Replaced with `.addNode('name', agentNode(agent, { inputMapper, stateMapper }), { after: [...] })`         |
| 4   | Execution — `cog.workflow()`       | `await cog.workflow(myWorkflow).run({ topic: '...' })` — `Cogitator` has no `.workflow()` method                          | Replaced with `new WorkflowExecutor(cog).execute(workflow, input, options)`                                |
| 5   | Result access — `result.output`    | `result.output` — `WorkflowResult` has no `.output` property                                                              | Changed to `result.state.fieldName` or `result.nodeResults.get('name')?.output`                            |
| 6   | WorkflowContext interface          | Described fictional `ctx.input.topic`, `ctx.steps['name'].output`, `ctx.meta.workflowId` etc.                             | Corrected to actual `NodeContext<S>`: `ctx.state`, `ctx.input`, `ctx.nodeId`, `ctx.workflowId`, `ctx.step` |
| 7   | Step types — `type: 'passthrough'` | No such type; step types don't exist at all                                                                               | Removed; replaced with `customNode()`                                                                      |
| 8   | Step types — `type: 'goto'`        | No such type; goto/loops are done via `addLoop()`                                                                         | Replaced iterative refinement example with `addLoop()`                                                     |
| 9   | Step `condition:` property         | Steps have no `condition` property; conditional routing uses `addConditional()`                                           | Replaced conditional examples with `addConditional(name, (state) => '...', { after: [...] })`              |
| 10  | Step `dependencyMode:` property    | Doesn't exist                                                                                                             | Removed; described actual fan-in via `after: ['a', 'b']`                                                   |
| 11  | Step `compensate:` inline          | Steps have no `compensate` property; saga compensation uses `CompensationManager` separately                              | Replaced saga example with `CompensationManager` usage                                                     |
| 12  | Step `fallback:` / `disabled:`     | Neither property exists on nodes                                                                                          | Removed; described retry via `executeWithRetry()`                                                          |
| 13  | Step `onStart/onComplete:`         | Steps have no lifecycle hooks; use `WorkflowExecuteOptions.onNodeStart/onNodeComplete` instead                            | Replaced with executor options                                                                             |
| 14  | Persisted state — `persistence:`   | `new Workflow({ persistence: { store: 'postgres' } })` — no such config field                                             | Replaced with `WorkflowExecutor(cog, checkpointStore)` + `execute(wf, input, { checkpoint: true })`        |
| 15  | Resume — `cog.workflow().resume`   | `cog.workflow(workflow).resume(runId)` — doesn't exist                                                                    | Replaced with `executor.resume(workflow, checkpointId)`                                                    |
| 16  | Triggers inside Workflow           | `new Workflow({ triggers: [{ type: 'cron', ... }] })` — `Workflow` has no `triggers` config                               | Replaced with `createTriggerManager()` + `triggerManager.register()`                                       |
| 17  | Events — `cog.workflow().on()`     | No `.on()` event emitter API; `result.trace` doesn't exist                                                                | Replaced with `executor.stream()` for events and `WorkflowExecuteOptions` callbacks for sync               |
| 18  | Dashboard config in Workflow       | `new Workflow({ dashboard: { enabled: true, ... } })` — doesn't exist                                                     | Removed; documented `WorkflowMetricsCollector` instead                                                     |

### Action

Full rewrite of WORKFLOWS.md — the document had zero accurate API examples. Every section was replaced with code that matches the actual implementation.

---

## docs/SWARMS.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — constructor API completely wrong throughout, 3 fake strategies, missing 7th strategy, multiple wrong method signatures

### Issues Found (15 total)

#### Critical (5) — Breaks code at runtime

| #   | Location                   | Issue                                                                                                    | Fix                                                                                                                  |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | All strategy examples (×6) | `new Swarm({...})` — actual constructor is `new Swarm(cogitator, {...})`                                 | Added `cog` as first arg everywhere                                                                                  |
| 2   | Hierarchical example       | `cog.run(devTeam, { input: '...' })` — `Cogitator.run()` doesn't accept Swarm; should be `devTeam.run()` | Changed to `devTeam.run({ input: '...' })`                                                                           |
| 3   | Swarm Patterns section     | `strategy: 'collaborative'`, `'specialist'`, `'adaptive'` — these don't exist in code; throw at runtime  | Replaced patterns: Peer-to-Peer → Expert Routing (auction), Self-Improving → Negotiation, removed specialist pattern |
| 4   | Pipeline examples          | `stages: [...]` at config root — `createStrategy` requires `pipeline: { stages: [...] }`                 | Moved all pipeline stages into `pipeline: { stages: [...] }`                                                         |
| 5   | Round-Robin example        | `routing: { sticky: true, stickyKey: ... }` — actual config key is `roundRobin:`                         | Changed to `roundRobin: { sticky: true, stickyKey: ... }`                                                            |

#### Wrong API (8)

| #   | Location                      | Issue                                                                                                        | Fix                                                                            |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 6   | API Reference — `run()`       | `run(input: any): Promise<SwarmResult>` — actual is `run(options: SwarmRunOptions): Promise<StrategyResult>` | Corrected signature; added SwarmRunOptions interface                           |
| 7   | API Reference — `getAgent()`  | Returns `Agent` — actual is `SwarmAgent \| undefined`                                                        | Corrected return type                                                          |
| 8   | API Reference — `sendMessage` | `sendMessage(agentName, message)` — method doesn't exist on Swarm                                            | Removed; documented `swarm.messageBus.send()` instead                          |
| 9   | API Reference — `emit()`      | `emit(event, data): void` — doesn't exist on Swarm                                                           | Removed; documented `swarm.events.emit()` instead                              |
| 10  | API Reference — `on()`        | `on(event: string, handler: Function): void` — returns `() => void` unsubscribe                              | Fixed signature; uses `SwarmEventType` not `string`                            |
| 11  | Observability config          | `metrics: { exporter: 'prometheus', labels: [...] }` and `dashboard: {...}` fields don't exist in types      | Removed; actual fields are `tracing`, `messageLogging`, `blackboardLogging`    |
| 12  | Blackboard `write()` example  | `swarm.blackboard.write(section, content)` — missing required 3rd arg `agentName`                            | Added `agentName` arg                                                          |
| 13  | SwarmConfig interface         | `strategy` showed `'collaborative' \| 'specialist' \| 'adaptive'` instead of `'negotiation'`                 | Replaced with `'negotiation'`; added coordination sub-configs that don't exist |

#### Missing (2)

| #   | Location       | Issue                                                                                          | Fix                                      |
| --- | -------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 14  | Strategies     | 7th strategy `negotiation` not mentioned anywhere                                              | Added full section with example          |
| 15  | API / Overview | `SwarmBuilder` / `swarm()` factory not documented; `AssessorConfig` / `dryRun()` not mentioned | Added SwarmBuilder and Assessor sections |

---

## docs/DOCKER.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Medium — model names were stale throughout, one section garbled, missing commands and env vars

### Issues Found (7 total)

#### Critical (4) — Wrong model name throughout

| #   | Location                        | Issue                                                                                    | Fix                           |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Quick Start Option 2            | `llama3.1:8b` in manual pull command — actual default in docker-compose is `llama3.2:3b` | Changed to `llama3.2:3b`      |
| 2   | Pre-installed Models table      | `llama3.1:8b` with `~2GB` — wrong model                                                  | Changed to `llama3.2:3b`      |
| 3   | Architecture ASCII diagram      | `• llama3.1:8b` inside Ollama box                                                        | Changed to `• llama3.2:3b`    |
| 4   | Apple Silicon / Troubleshooting | `ollama pull llama3.1:8b` in two places                                                  | Changed both to `llama3.2:3b` |

#### Medium (3) — Missing or garbled content

| #   | Location                | Issue                                                                                                                           | Fix                                                                     |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 5   | "Out of memory" section | Garbled: said "Instead of llama3.1:8b" then showed llama3.1:8b; wrong sizes                                                     | Rewrote: default is llama3.2:3b, alternatives are llama3.2:1b/phi3:mini |
| 6   | Commands Reference      | Missing `logs-pg` command (Makefile has it)                                                                                     | Added `make logs-pg` line                                               |
| 7   | Environment Variables   | Missing `SANDBOX_DEFAULT_TYPE`, `SANDBOX_DEFAULT_TIMEOUT`, `SANDBOX_MAX_CONTAINERS`, `NEXT_PUBLIC_APP_URL` (all in env.example) | Added all four to the key variables block                               |

#### Bonus (1) — Added missing context

| #   | Location        | Issue                                                      | Fix                                                                   |
| --- | --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| 8   | CPU Only option | No mention that CPU variant uses different embedding model | Added note: CPU uses `nomic-embed-text` not `nomic-embed-text-v2-moe` |

### Source of Truth Verified

| Claim                                   | Verified Against         | Result                            |
| --------------------------------------- | ------------------------ | --------------------------------- |
| PostgreSQL port 5432                    | docker-compose.yml       | ✅ Correct                        |
| Redis port 6379                         | docker-compose.yml       | ✅ Correct                        |
| Ollama port 11434                       | docker-compose.yml       | ✅ Correct                        |
| pgvector 768-dimension vectors          | docker/postgres/init.sql | ✅ Correct                        |
| IVFFlat index                           | docker/postgres/init.sql | ✅ Correct                        |
| `search_memory_by_embedding()` function | docker/postgres/init.sql | ✅ Correct (signature matches)    |
| `docker/env.example` path               | Filesystem               | ✅ Correct                        |
| `docker-compose.cpu.yml` exists         | Filesystem               | ✅ Correct                        |
| All `make` commands listed              | Makefile                 | ✅ Correct (after adding logs-pg) |
| DATABASE_URL format                     | docker/env.example       | ✅ Correct                        |

---

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

---

## docs/DISASTER_RECOVERY.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Medium — 9 issues, mostly wrong table names and phantom infrastructure references

### Issues Found (9 total)

#### Critical (3) — Wrong PostgreSQL table names throughout

All actual table names have the `cogitator_` prefix (defined in `docker/postgres/init.sql`). The doc used bare names from an imaginary schema.

| #   | Location                           | Issue                                                                                                                                                                     | Fix                                                      |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Scenario 3 / Verify data integrity | `SELECT COUNT(*) FROM agents` — table is `cogitator_agents`                                                                                                               | Changed to `cogitator_agents`                            |
| 2   | Scenario 3 / Verify data integrity | `FROM runs WHERE status = 'running' AND updated_at < ...` — table is `cogitator_runs`, column is `started_at` (no `updated_at`)                                           | Changed to `cogitator_runs` + `started_at`               |
| 3   | Scenario 5 / Data Corruption       | `SELECT id FROM runs WHERE NOT (result IS NULL OR result::text <> '')` — wrong table, wrong column (`output` not `result`), wrong query logic (condition is always false) | Rewrote as null/empty `output` check on `cogitator_runs` |

#### High (3) — Wrong table/index names in data corruption section

| #   | Location                           | Issue                                                                                                                                                                                    | Fix                                                                                 |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 4   | Scenario 5 / Identify corruption   | `FROM memory_vectors WHERE array_length(embedding, 1) != 1536` — wrong table (`cogitator_memory_entries`), wrong dimension (768 not 1536 per init.sql)                                   | Changed table to `cogitator_memory_entries`, dimension to 768, used `vector_dims()` |
| 5   | Scenario 5 / Isolate affected data | `UPDATE runs SET status = 'corrupted'` / `UPDATE agents SET enabled = false` — wrong table names, `cogitator_runs` has no `corrupted` status, `cogitator_agents` has no `enabled` column | Rewrote to use correct tables and existing columns                                  |
| 6   | Scenario 5 / Restore / Reindex     | `pg_restore --table=runs --table=memory_vectors` and `REINDEX INDEX memory_vectors_embedding_idx` — wrong table/index names                                                              | Changed to `cogitator_runs`, `cogitator_memory_entries`, `idx_memory_embedding`     |

#### Medium (3) — Phantom infrastructure / wrong identifiers

| #   | Location                        | Issue                                                                                                                                                                                    | Fix                                                                                     |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 7   | Sandbox Recovery / Docker       | `docker ps --filter "label=cogitator.sandbox=true"` and `curl -X POST .../admin/sandbox/reset` — `ContainerPool` never sets Docker labels; `/admin/sandbox/reset` endpoint doesn't exist | Replaced with `--filter "ancestor=alpine:3.19"` (actual default image) + worker restart |
| 8   | Sandbox Recovery / Docker image | `docker rmi cogitator/sandbox:latest` — actual default image in `DockerSandboxExecutor` is `alpine:3.19`, not `cogitator/sandbox:latest`                                                 | Changed to `alpine:3.19` with a note for custom images                                  |
| 9   | Sandbox Recovery / Extism       | `require('@extism/extism').version` — Extism ESM package exports no `.version` property                                                                                                  | Replaced with ESM-correct import check                                                  |

#### Medium (2) — Wrong Prometheus metric names

| #   | Location                 | Issue                                                                                              | Fix                                       |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 10  | Monitoring / Alerts YAML | `cogitator_workers_active` — actual metric exported from `metrics.ts` is `cogitator_workers_total` | Changed to `cogitator_workers_total`      |
| 11  | Monitoring / Alerts YAML | `cogitator_runs_failed_total` — actual metric is `cogitator_queue_failed_total`                    | Changed to `cogitator_queue_failed_total` |

#### Medium (1) — Wrong health endpoint paths

| #   | Location                        | Issue                                                                                                                                                                                                                                                        | Fix                                                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 12  | Monitoring / Health Check table | Listed `/health/ready`, `/health/live`, `/health/db`, `/health/redis`. Express adapter only exposes `/health` and `/ready`. Dashboard exposes `/api/health`, `/api/health/ready`, `/api/health/live`. `/health/db` and `/health/redis` don't exist anywhere. | Split into two tables by adapter, removed non-existent `/health/db` and `/health/redis` |

### Source of Truth Verified

| Claim                                                                    | Verified Against                                       | Result                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| Table names with `cogitator_` prefix                                     | `docker/postgres/init.sql`                             | ✅ All tables have prefix                        |
| `cogitator_runs.started_at` column                                       | `docker/postgres/init.sql`                             | ✅ Column exists (no `updated_at`)               |
| Vector embeddings are 768-dim                                            | `docker/postgres/init.sql` line 119                    | ✅ `vector(768)` nomic-embed-text-v2-moe         |
| Vector index name `idx_memory_embedding`                                 | `docker/postgres/init.sql`                             | ✅ Correct                                       |
| Default Docker sandbox image                                             | `packages/sandbox/src/executors/docker.ts` line 25     | ✅ `alpine:3.19`, not `cogitator/sandbox:latest` |
| No Docker labels on containers                                           | `packages/sandbox/src/pool/container-pool.ts`          | ✅ No `Labels` in `createContainer` call         |
| No `/admin/sandbox/reset` endpoint                                       | All server packages                                    | ✅ Endpoint doesn't exist                        |
| Prometheus metric `cogitator_workers_total`                              | `packages/worker/src/metrics.ts` line 53               | ✅ Correct name                                  |
| Prometheus metric `cogitator_queue_failed_total`                         | `packages/worker/src/metrics.ts` line 46               | ✅ Correct name                                  |
| Express health: `/health` and `/ready`                                   | `packages/express/src/routes/health.ts`                | ✅ Correct                                       |
| Dashboard health: `/api/health`, `/api/health/ready`, `/api/health/live` | `packages/dashboard/src/app/api/health/`               | ✅ All three exist                               |
| No `/health/db` or `/health/redis` endpoints                             | All packages                                           | ✅ Confirmed absent                              |
| BullMQ retry on job failure                                              | `packages/worker/src/queue.ts` (default `attempts: 3`) | ✅ Correct                                       |
| Extism package: `@extism/extism`                                         | `packages/sandbox/package.json`                        | ✅ Correct package name                          |

---

## docs/MEMORY.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — document described entirely aspirational architecture, every class/interface/schema was wrong

### Issues Found (20+ total)

#### Critical — Non-existent classes / wrong interfaces

| #   | Section                                                                                     | Issue                                                                                        | Fix                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture diagram                                                                        | L1/L2/L3/L4 hierarchy (Working Memory, Episodic, Semantic) — aspirational, never implemented | Replaced with actual adapter diagram + ContextBuilder                                                                     |
| 2   | WorkingMemory interface                                                                     | Doesn't exist (fields: messages, toolResults, scratchpad, tokenCount)                        | Actual type is `MemoryEntry`                                                                                              |
| 3   | WorkingMemoryManager class                                                                  | Doesn't exist (LRU cache, flushToEpisodic)                                                   | Actual is `InMemoryAdapter` (Map-based, no LRU)                                                                           |
| 4   | EpisodicMemory interface                                                                    | Doesn't exist                                                                                | Actual type is `MemoryEntry`                                                                                              |
| 5   | PostgreSQL `episodic_memories` table                                                        | Doesn't exist; wrong columns (no importance, no tokens, no agent_id FK to `agents`)          | Actual tables: `cogitator.threads`, `cogitator.entries`, `cogitator.facts`, `cogitator.embeddings`                        |
| 6   | SemanticMemory interface                                                                    | Doesn't exist (confidence, lastAccessed, source fields missing from real Embedding)          | Actual type is `Embedding` with different fields                                                                          |
| 7   | `semantic_memories` table with HNSW index                                                   | Wrong table, wrong index type                                                                | Actual: `cogitator.embeddings` with IVFFlat index (not HNSW); no `last_accessed`, no `confidence` columns                 |
| 8   | retrieveByRecency / retrieveBySimilarity / retrieveByImportance / retrieveHybrid            | Don't exist as functions                                                                     | Actual: `ContextBuilder.build()` with `strategy: 'recent' \| 'hybrid'`                                                    |
| 9   | ContextBuilder.buildContext(agent, currentInput)                                            | Wrong signature                                                                              | Actual: `build(options: BuildContextOptions)` with `{ threadId, agentId, systemPrompt?, currentInput? }`                  |
| 10  | Summarizer class (4 strategies)                                                             | Doesn't exist                                                                                | ContextBuilder has no summarization; `relevant` strategy not yet implemented                                              |
| 11  | ImportanceScorer class                                                                      | Doesn't exist                                                                                | No equivalent in codebase                                                                                                 |
| 12  | MemoryBackup class                                                                          | Doesn't exist                                                                                | No equivalent in codebase                                                                                                 |
| 13  | SharedMemoryPool interface                                                                  | Doesn't exist                                                                                | No equivalent in codebase                                                                                                 |
| 14  | EmbeddingCache class with LRU                                                               | Doesn't exist                                                                                | No equivalent in codebase                                                                                                 |
| 15  | BatchMemoryWriter class                                                                     | Doesn't exist                                                                                | No equivalent in codebase                                                                                                 |
| 16  | MemoryConfig structure (redis, postgres, embeddings, retrieval, summarization, maintenance) | Completely wrong structure                                                                   | Actual: `adapter?`, `inMemory?`, `redis?`, `postgres?`, `sqlite?`, `mongodb?`, `qdrant?`, `embedding?`, `contextBuilder?` |
| 17  | Embedding providers `'openai' \| 'local' \| 'cohere'`                                       | Wrong values                                                                                 | Actual: `'openai' \| 'ollama' \| 'google'`                                                                                |
| 18  | Monitoring metrics (Counter/Histogram/Gauge types)                                          | Aspirational, not exported                                                                   | Removed                                                                                                                   |

#### Missing coverage (not mentioned at all)

| #   | Issue                                                                                      | Fix                     |
| --- | ------------------------------------------------------------------------------------------ | ----------------------- |
| 19  | SQLiteAdapter — not mentioned                                                              | Added                   |
| 20  | MongoDBAdapter — not mentioned                                                             | Added                   |
| 21  | QdrantAdapter — not mentioned                                                              | Added                   |
| 22  | HybridSearch (BM25 + vector + RRF) — not mentioned                                         | Added dedicated section |
| 23  | FactAdapter interface — not mentioned                                                      | Added                   |
| 24  | EmbeddingAdapter interface — not mentioned                                                 | Added                   |
| 25  | Thread interface — not mentioned                                                           | Added                   |
| 26  | MemoryEntry interface (actual shape) — not mentioned                                       | Added                   |
| 27  | Knowledge Graph subsystem (PostgresGraphAdapter, LLMEntityExtractor, etc.) — not mentioned | Added section           |
| 28  | EmbeddingService factory (createEmbeddingService) — not mentioned                          | Added                   |

### Result

Complete rewrite. All sections now reflect actual `packages/memory/src/` source:

- Architecture diagram shows real layers (adapters → ContextBuilder)
- All 6 adapters documented with correct config
- `MemoryAdapter` interface correct (Thread CRUD + Entry CRUD + connect/disconnect)
- `MemoryEntry`, `Thread`, `Fact`, `Embedding` types documented correctly
- `ContextBuilder.build()` with correct signature and all 3 strategies (with note that `relevant` is not implemented)
- `ContextBuilderConfig` all fields correct
- Embedding services: openai/ollama/google with `createEmbeddingService()` factory
- `HybridSearch` with BM25 + vector + RRF
- `MemoryConfig` correct structure (all 7 adapter keys + embedding + contextBuilder)
- Knowledge Graph section: PostgresGraphAdapter, LLMEntityExtractor, GraphContextBuilder

---

## docs/GETTING_STARTED.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Low-Medium — 6 correctness issues, mostly model names and API surface gaps

### Issues Found (6 total)

#### Critical (1) — Wrong async/sync usage

| #   | Location                        | Issue                                                                                                  | Fix                                                      |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 1   | Configuration File / loadConfig | `const config = await loadConfig()` — `loadConfig` is synchronous, `await` is incorrect and misleading | Changed to `const config = loadConfig(); // synchronous` |

#### Medium (3) — Incorrect model format / missing provider prefix

| #   | Location                        | Issue                                                                                                                                      | Fix                                                                |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 2   | Built-in Tools / agent examples | `model: 'gpt-4.1'` with `new Cogitator()` (no config) — default provider is `'ollama'`, so bare `gpt-4.1` would be sent to Ollama and fail | Changed to `'openai/gpt-4.1'` in both Agent examples               |
| 3   | Create Your First Agent         | Comment `// or 'gpt-4o', 'claude-sonnet-4-5'` — without provider prefix these would be sent to the default `ollama` provider               | Changed to `// or 'openai/gpt-4.1', 'anthropic/claude-sonnet-4-5'` |
| 4   | Docker Services / Pull model    | `ollama pull llama3.1:8b` — docker-compose default model is `llama3.2:3b` per docker-compose.yml                                           | Changed to `llama3.2:3b`; troubleshooting example updated to match |

#### Minor (2) — Missing content / outdated examples table

| #   | Location              | Issue                                                                                                                                                                                                                                                         | Fix                                                                                                                                      |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | Memory Adapters table | Only listed 3 adapters (memory, redis, postgres) — schema supports 6: memory, redis, postgres, sqlite, mongodb, qdrant                                                                                                                                        | Added sqlite, mongodb, qdrant rows to table                                                                                              |
| 6   | Examples table        | Listed `basic-agent.ts`, `research-agent.ts`, `code-assistant.ts`, `dev-team-swarm.ts`, `workflow-code-review.ts` — none of these exist at the paths shown; actual examples are in `examples/core/`, `examples/swarms/`, `examples/workflows/` subdirectories | Rewrote table with correct paths and descriptions; fixed run command from `examples/basic-agent.ts` to `examples/core/01-basic-agent.ts` |

### Source of Truth Verified

| Claim                                                 | Verified Against                                      | Result                                         |
| ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `Cogitator`, `Agent`, `tool()` exports                | `packages/core/src/index.ts`                          | ✅ All exported                                |
| `loadConfig` from `@cogitator-ai/config`              | `packages/config/src/index.ts`                        | ✅ Exported; synchronous (no Promise return)   |
| `result.usage.totalTokens` field                      | `packages/types/src/runtime.ts` RunResult interface   | ✅ Exists                                      |
| `result.toolCalls` field                              | `packages/types/src/runtime.ts` RunResult interface   | ✅ Exists as `readonly ToolCall[]`             |
| `cog.close()` method                                  | `packages/core/src/runtime.ts` line 815               | ✅ Exists as `async close(): Promise<void>`    |
| Built-in tools count (26)                             | `packages/core/src/tools/index.ts` builtinTools array | ✅ 26 items                                    |
| All 26 tool names in import block                     | `packages/core/src/tools/index.ts` + index.ts         | ✅ All exported                                |
| `stream: true` + `onToken` in RunOptions              | `packages/types/src/runtime.ts` RunOptions interface  | ✅ Both exist                                  |
| `threadId` in RunOptions                              | `packages/types/src/runtime.ts` RunOptions interface  | ✅ Exists                                      |
| `memory.adapter: 'memory'`                            | `packages/config/src/schema.ts` MemoryProviderSchema  | ✅ 'memory' is a valid enum value              |
| `memory.adapter: 'redis'` / `'postgres'`              | `packages/config/src/schema.ts` MemoryProviderSchema  | ✅ Both valid                                  |
| `memory.adapter: 'sqlite'` / `'mongodb'` / `'qdrant'` | `packages/config/src/schema.ts` MemoryProviderSchema  | ✅ All valid (were missing from doc)           |
| `memory.postgres.connectionString`                    | `packages/config/src/schema.ts` MemoryConfigSchema    | ✅ Field exists                                |
| `memory.embedding.provider: 'ollama'`                 | `packages/config/src/schema.ts` EmbeddingConfigSchema | ✅ Valid discriminated union value             |
| `logging.level` / `logging.format: 'pretty'`          | `packages/config/src/schema.ts` LoggingConfigSchema   | ✅ Both valid                                  |
| `defaultProvider`, `defaultModel` in LLMConfig        | `packages/config/src/schema.ts` LLMConfigSchema       | ✅ Both fields exist                           |
| `cogitator init <name>` CLI command                   | `packages/cli/src/commands/init.ts`                   | ✅ Command exists                              |
| `cogitator up` CLI command                            | `packages/cli/src/index.ts`                           | ✅ upCommand registered                        |
| `claude-sonnet-4-5-20250929` model                    | `packages/models/src/providers/anthropic.ts`          | ✅ Exists with alias `claude-sonnet-4-5`       |
| `gpt-4o` model                                        | `packages/models/src/providers/openai.ts`             | ✅ Exists                                      |
| `gpt-4.1` model                                       | `packages/models/src/providers/openai.ts`             | ✅ Exists as alias for `gpt-4.1-2025-04-14`    |
| `o3` model                                            | `packages/models/src/providers/openai.ts`             | ✅ Exists as alias for `o3-2025-04-16`         |
| Default provider fallback = `'ollama'`                | `packages/core/src/runtime.ts` getBackend()           | ✅ Fallback is `'ollama'` when none configured |
| `examples/core/01-basic-agent.ts` exists              | Filesystem                                            | ✅ Correct path                                |
| `examples/swarms/01-debate-swarm.ts` exists           | Filesystem                                            | ✅ Correct path                                |
| `examples/workflows/01-basic-workflow.ts` exists      | Filesystem                                            | ✅ Correct path                                |

---

## docs/SECURITY.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Medium — 5 issues, mostly wrong config field names and overstated built-in security capabilities

### Issues Found (5 total)

#### Critical (1) — Wrong config field names in Docker example

| #   | Location              | Issue                                                                                                                                                                                                                                          | Fix                                                                                                         |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Docker Sandbox config | `resources.cpuLimit`, `resources.memoryLimit`, `resources.timeout`, `network: { enabled: false }` — none of these match `SandboxConfig`. Actual fields: `resources.cpus`, `resources.memory`, top-level `timeout`, `network: { mode: 'none' }` | Fixed all four field names; changed image from `cogitator/sandbox:latest` to `alpine:3.19` (actual default) |

#### Medium (3) — Overstated/incorrect security claims

| #   | Location                      | Issue                                                                                                                                                                                                           | Fix                                                                                          |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 2   | WASM "Memory Limits" property | Claims memory can be limited via `memoryPages` — field exists in `SandboxWasmConfig` but is never passed to Extism; feature not enforced                                                                        | Added clarification that `memoryPages` is defined but not currently enforced at Extism level |
| 3   | API Security mitigations      | Lists "API key authentication (X-API-Key)", "JWT authentication", "RBAC" as built-in features — auth middleware is a pure user-provided `AuthFunction` callback; none of these are implemented by the framework | Rewrote to accurately describe pluggable auth + built-in rate limiting and CORS              |
| 4   | Internal audit: "LRU cache"   | Says "LRU cache with configurable size" — actual implementation is FIFO (array shift/push) not LRU                                                                                                              | Changed to "FIFO cache with configurable size (cacheSize)"                                   |

#### Minor (1) — Misleading security control

| #   | Location                                 | Issue                                                                                                                                | Fix                                                                      |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 5   | Docker security table "Non-root user ✅" | Listed as a verified security control with "User namespace mapping" — only set if `config.user` is provided, not enforced by default | Changed to ⚠️ with note "Set via `config.user`; not enforced by default" |

### Source of Truth Verified

| Claim                                           | Verified Against                                                | Result                                         |
| ----------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `SandboxConfig.resources` field names           | `packages/types/src/sandbox.ts`                                 | ✅ `cpus`, `memory`, `cpuShares`, `pidsLimit`  |
| `SandboxConfig.network.mode` field              | `packages/types/src/sandbox.ts`                                 | ✅ `mode?: 'none' \| 'bridge' \| 'host'`       |
| `SandboxConfig.timeout` is top-level            | `packages/types/src/sandbox.ts`                                 | ✅ Top-level field                             |
| Default Docker image = `alpine:3.19`            | `packages/sandbox/src/executors/docker.ts` line 25              | ✅ `DEFAULT_IMAGE = 'alpine:3.19'`             |
| `CapDrop: ['ALL']` hardcoded                    | `packages/sandbox/src/pool/container-pool.ts` line 119          | ✅ Always set                                  |
| `SecurityOpt: ['no-new-privileges']`            | `packages/sandbox/src/pool/container-pool.ts` line 118          | ✅ Always set                                  |
| `NetworkMode` defaults to `'none'`              | `packages/sandbox/src/pool/container-pool.ts`                   | ✅ `options.networkMode ?? 'none'`             |
| `PidsLimit: 100` default                        | `packages/sandbox/src/pool/container-pool.ts`                   | ✅ `options.pidsLimit ?? 100`                  |
| `MAX_OUTPUT_SIZE = 50_000` (both executors)     | `packages/sandbox/src/executors/wasm.ts`, `docker.ts`           | ✅ Both set 50,000                             |
| Timeout via `Promise.race` (WASM)               | `packages/sandbox/src/executors/wasm.ts`                        | ✅ `executeWithTimeout` uses `Promise.race`    |
| FIFO plugin cache (not LRU)                     | `packages/sandbox/src/executors/wasm.ts` `cacheOrder: string[]` | ✅ Array shift/push = FIFO                     |
| `memoryPages` not passed to Extism              | `packages/sandbox/src/executors/wasm.ts` `getOrCreatePlugin()`  | ✅ Only `{ useWasi }` passed to `createPlugin` |
| Auth middleware is user-provided `AuthFunction` | `packages/express/src/middleware/auth.ts`                       | ✅ No built-in JWT/API key/RBAC                |
| Rate limiting built-in (`RateLimitConfig`)      | `packages/express/src/middleware/rate-limit.ts`                 | ✅ windowMs, max, keyGenerator                 |
| CORS built-in (`CorsConfig`)                    | `packages/express/src/middleware/cors.ts`                       | ✅ origin allowlist, credentials, methods      |
| `@extism/extism@^1.0.3` pinned                  | `packages/sandbox/package.json`                                 | ✅ Matches doc recommendation                  |
| Idle container cleanup default = 60s            | `packages/sandbox/src/pool/container-pool.ts` constructor       | ✅ `idleTimeoutMs ?? 60_000`                   |
| Container pool max size default = 5             | `packages/sandbox/src/pool/container-pool.ts`                   | ✅ `maxSize ?? 5`                              |

### Verified correct (no changes needed)

- WASM config example (`type`, `wasmModule`, `timeout`, `wasi`) — all match `SandboxConfig` ✅
- WASM security properties: memory isolation, no filesystem, no network, timeout ✅
- WASM known limitations (pre-compiled modules, QuickJS overhead) ✅
- Docker security: CapDrop ALL, no-new-privileges, NetworkMode none ✅
- Kubernetes security context YAML ✅ (no code to verify against, best-practice guidance)
- Production checklist YAML ✅ (env var guidance)
- WASM vs Docker comparison table (cold start times, overhead sizes) ✅
- Reporting/incident response sections (no code to verify) ✅

---

## docs/SOC2-COMPLIANCE.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** High — 13 issues across wrong API signatures, phantom config fields, incorrect security properties, and broken code examples

### Issues Found (13 total)

#### Critical (5) — Wrong API / phantom fields

| #   | Location                 | Issue                                                                                                                                                        | Fix                                                                                             |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | CC6.1 Auth code example  | `hashApiKey(apiKey)` then `validateApiKey(hashedKey)` — actual `validateApiKey` takes raw key and hashes internally; `logFailedAuthentication` doesn't exist | Rewrote example to show actual `getAuthenticatedUser()` from middleware                         |
| 2   | P3.1 memory config       | `memory: { enabled: false }` — `enabled` field doesn't exist in MemoryConfig                                                                                 | Changed to omit `memory` config entirely; added `useMemory: false` in RunOptions as alternative |
| 3   | P6.1 Data Subject Rights | `memoryAdapter.deleteThread(userId, threadId)` — wrong signature; takes only `(threadId: string)`                                                            | Fixed to `deleteThread(threadId)`                                                               |
| 4   | P6.1 Data Subject Rights | `memoryAdapter.getMessages(userId, threadId)` — method doesn't exist; actual: `getEntries({ threadId })`                                                     | Fixed to `getEntries({ threadId })`                                                             |
| 5   | P6.1 Data Subject Rights | `memoryAdapter.getThreads(agentId)` — method doesn't exist on MemoryAdapter interface                                                                        | Replaced with `getThread(threadId)` (single thread lookup)                                      |

#### High (4) — Wrong config structure

| #   | Location             | Issue                                                                                                                                                                                    | Fix                                                                                       |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 6   | Audit & Logging      | `new Cogitator({ observability: { provider: 'langfuse', langfuse: {...} } })` — no `observability` field in CogitatorConfig                                                              | Rewrote to use `LangfuseExporter` + `onSpan` callback in RunOptions                       |
| 7   | P2.1 privacy config  | Same — `observability.enabled/provider` in CogitatorConfig doesn't exist                                                                                                                 | Fixed to `LangfuseExporter` pattern                                                       |
| 8   | C1.2 memory config   | `memoryConfig.ttl`, `memoryConfig.maxMessages`, `memoryConfig.excludeFields` — all wrong; `ttl` is inside `redis`, `maxMessages` is `inMemory.maxEntries`, `excludeFields` doesn't exist | Rewrote with correct MemoryConfig structure                                               |
| 9   | A1.2 resource config | `sandbox.memoryLimit`/`sandbox.cpuLimit` — wrong field names; actual `SandboxConfig.resources.memory`/`.cpus` via `sandbox.defaults`                                                     | Fixed to `sandbox.defaults.resources.memory/cpus`; also corrected `cpus` type to `number` |

#### Medium (3) — Wrong security properties / incorrect endpoints

| #   | Location                  | Issue                                                                                            | Fix                                                                                          |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 10  | CC6.2 Docker sandbox YAML | `ReadonlyRootfs: true` — actual code sets `ReadonlyRootfs: false` (`container-pool.ts` line 120) | Changed to `false` with note about `/workspace` being writable                               |
| 11  | CC6.2 Docker sandbox YAML | `User: '1000:1000'` listed as always enforced — only set if `config.user` is provided            | Changed to `User: configurable` with note                                                    |
| 12  | A1.1 Health Check table   | Listed `/health/live` and `/health/ready` — Express adapter only exposes `/health` and `/ready`  | Split into two tables: server adapters (`/health`, `/ready`) and dashboard (`/api/health/*`) |

#### Medium (1) — Wrong RunOptions callback

| #   | Location   | Issue                                                                                               | Fix                                         |
| --- | ---------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 13  | PI1.2 code | `onStep` callback in RunOptions — doesn't exist; actual callbacks are `onToolCall`, `onRunComplete` | Fixed to use `onToolCall` + `onRunComplete` |

#### Minor fixes

| #   | Location           | Issue                                                                                                       | Fix                                                  |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 14  | CC6.1 Auth table   | "Required `X-API-Key` header" — also accepts `Authorization: Bearer cog_*`                                  | Added both accepted forms to table                   |
| 15  | CC6.1 Auth table   | `Agent.allowedTools` configuration — field doesn't exist; tool access is via `AgentConfig.tools?: Tool[]`   | Fixed to correct field name                          |
| 16  | PI1.2 retry config | `retryOn: [429, 500, ...]` — wrong field; actual `RetryOptions.retryIf?: (error, attempt) => boolean`       | Fixed to use `withRetry()` from `@cogitator-ai/core` |
| 17  | PI1.3 streaming    | `for await (const chunk of stream)` — `cogitator.run()` returns `Promise<RunResult>`, not an async iterable | Rewrote to show `onToken` callback pattern           |
| 18  | PI1.1 tool example | `const tool = tool({...})` — naming collision                                                               | Renamed variable to `searchTool`                     |

### Source of Truth Verified

| Claim                                          | Verified Against                                       | Result                                    |
| ---------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Auth middleware file exists                    | `packages/dashboard/src/lib/auth/middleware.ts`        | ✅ Exists                                 |
| Supabase client dir exists                     | `packages/dashboard/src/lib/supabase/`                 | ✅ Exists                                 |
| API key: Bearer + X-API-Key supported          | `extractApiKeyFromRequest()` in middleware             | ✅ Both forms accepted                    |
| Roles: admin/user/readonly                     | `User.role` type in middleware                         | ✅ Correct                                |
| `AgentConfig.tools?: Tool[]`                   | `packages/types/src/agent.ts`                          | ✅ Correct field name; no `allowedTools`  |
| `ReadonlyRootfs: false`                        | `packages/sandbox/src/pool/container-pool.ts` line 120 | ✅ Confirmed false                        |
| `SandboxConfig.user` optional                  | `packages/types/src/sandbox.ts`                        | ✅ Optional, not enforced by default      |
| `SandboxManagerConfig.defaults`                | `packages/types/src/sandbox.ts` line 114-116           | ✅ Correct structure                      |
| Express health routes: `/health`, `/ready`     | `packages/express/src/routes/health.ts`                | ✅ No `/health/live` or `/health/ready`   |
| `cogitator.run()` returns `Promise<RunResult>` | `packages/core/src/runtime.ts` line 163                | ✅ Not async iterable                     |
| `onToken`, `onToolCall`, `onRunComplete`       | `packages/types/src/runtime.ts`                        | ✅ All exist; no `onStep`                 |
| No `observability` in CogitatorConfig          | `packages/types/src/runtime.ts` CogitatorConfig        | ✅ Confirmed absent                       |
| `LangfuseExporter` + `onSpan` pattern          | `packages/core/src/observability/langfuse.ts`          | ✅ Correct API                            |
| `MemoryConfig.redis.ttl`                       | `packages/config/src/schema.ts` MemoryConfigSchema     | ✅ Exists inside `redis` sub-object       |
| `MemoryConfig.inMemory.maxEntries`             | `packages/config/src/schema.ts` MemoryConfigSchema     | ✅ `inMemory.maxEntries` exists           |
| No `enabled` field in MemoryConfig             | `packages/config/src/schema.ts` MemoryConfigSchema     | ✅ Confirmed absent                       |
| `MemoryAdapter.deleteThread(threadId)`         | `packages/memory/src/adapters/base.ts` line 31         | ✅ Single param, no userId                |
| `MemoryAdapter.getEntries({ threadId })`       | `packages/memory/src/adapters/base.ts` line 37         | ✅ Takes MemoryQueryOptions object        |
| No `getThreads(agentId)` method                | `packages/memory/src/adapters/base.ts`                 | ✅ Method doesn't exist                   |
| `withRetry` options: `retryIf`, not `retryOn`  | `packages/core/src/utils/retry.ts`                     | ✅ `retryIf: (error, attempt) => boolean` |

### Verified correct (no changes needed)

- WASM sandbox properties (memory isolation, no FS, no network, timeout, 50KB output limit) ✅
- Docker: CapDrop ALL, no-new-privileges, NetworkMode none, PidsLimit 100 ✅
- TLS/encryption table (infrastructure guidance, not code) ✅
- Secret management pattern (env vars, boolean logging) ✅
- Dependency security section (`pnpm audit`, Dependabot) ✅
- Input validation example (Zod, `AgentInputSchema`) ✅
- Log redaction patterns (email, SSN, API keys) ✅
- Data retention table ✅
- `AuditLogEntry` interface (custom schema, not a Cogitator export — used as pattern) ✅
- Incident response procedures (operational guidance, no code) ✅
- Vendor management tables ✅
- Control matrix TSC mapping ✅

---

## docs/TOOLS.md

**Status:** Complete
**Date:** 2026-02-25
**Severity:** Critical — nearly every import path was wrong, multiple fake APIs and non-existent tools throughout, ToolRegistry and MCP APIs completely incorrect

### Issues Found (28 total)

#### Critical (15) — Wrong package paths / non-existent APIs

| #   | Location                          | Issue                                                                                                                                      | Fix                                                                                         |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | Built-in Tools — File section     | `import { fileRead, fileWrite, fileDelete, fileList, fileSearch, fileMove } from '@cogitator-ai/tools/filesystem'` — package doesn't exist | Changed to `from '@cogitator-ai/core'`; removed `fileSearch`, `fileMove` (don't exist)      |
| 2   | Built-in Tools — File section     | `fileSearch` and `fileMove` shown as exports — don't exist                                                                                 | Removed; actual exports are `fileRead`, `fileWrite`, `fileList`, `fileExists`, `fileDelete` |
| 3   | Built-in Tools — Web section      | `import { webFetch, webSearch, webScreenshot } from '@cogitator-ai/tools/web'` — package doesn't exist                                     | Changed to `from '@cogitator-ai/core'`; removed `webFetch`, `webScreenshot` (don't exist)   |
| 4   | Built-in Tools — Web section      | `webFetch` and `webScreenshot` tools don't exist                                                                                           | Removed; actual tools are `webSearch` and `webScrape`                                       |
| 5   | Built-in Tools — Code section     | `import { codeInterpreter } from '@cogitator-ai/tools/code'` — neither package nor tool exist                                              | Removed entire section; no code interpreter built-in                                        |
| 6   | Built-in Tools — Database section | `import { sqlQuery, sqlExecute } from '@cogitator-ai/tools/database'` — package doesn't exist                                              | Changed to `from '@cogitator-ai/core'`; removed `sqlExecute` (doesn't exist)                |
| 7   | MCP Integration section           | `import { mcpServer } from '@cogitator-ai/tools/mcp'` — wrong package, wrong function                                                      | Changed to `import { MCPClient, connectMCPServer } from '@cogitator-ai/mcp'`                |
| 8   | MCP Integration — `mcpServer()`   | `mcpServer({ command, args, env })` helper function doesn't exist                                                                          | Replaced with `connectMCPServer()` and `MCPClient.connect()` which are the real APIs        |
| 9   | MCP Server creation               | `import { MCPServer, MCPTool } from '@cogitator-ai/tools/mcp'` — wrong package, `MCPTool` doesn't exist                                    | Changed to `from '@cogitator-ai/mcp'`; removed `MCPTool`                                    |
| 10  | MCP Server — `addTool()`          | `server.addTool({ name, description, inputSchema, handler })` — method doesn't exist                                                       | Changed to `server.registerTool(tool)` accepting a Cogitator Tool instance                  |
| 11  | MCP Server — `listen()`           | `server.listen()` — method doesn't exist                                                                                                   | Changed to `await server.start()`                                                           |
| 12  | ToolRegistry — `registerGroup()`  | `registry.registerGroup('filesystem', [...])` — method doesn't exist                                                                       | Changed to `registry.registerMany([...])`                                                   |
| 13  | ToolRegistry — `getGroup()`       | `registry.getGroup('web')` — method doesn't exist                                                                                          | Removed; ToolRegistry has no group concept                                                  |
| 14  | ToolRegistry — `search()`         | `registry.search('file')` — method doesn't exist                                                                                           | Removed                                                                                     |
| 15  | ToolRegistry — `getSchema()`      | `registry.getSchema('calculator')` — method doesn't exist (it's `getSchemas()` plural, returns all)                                        | Fixed to `registry.getSchemas()`                                                            |

#### Wrong API (8)

| #   | Location                         | Issue                                                                                                         | Fix                                                                                   |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 16  | ToolRegistry constructor         | `new ToolRegistry({ permissions: { default: {...}, tools: {...} } })` — constructor takes no arguments        | Removed permissions config block; constructor is `new ToolRegistry()`                 |
| 17  | Error types                      | `import { ToolError, ToolValidationError, ToolTimeoutError } from '@cogitator-ai/core'` — don't exist         | Removed; no error classes exported from core; tools throw plain `Error`               |
| 18  | Observability section            | `import { metrics } from '@cogitator-ai/observability'` — package doesn't exist                               | Removed metrics example; tracing is automatic via OpenTelemetry                       |
| 19  | Testing section                  | `import { mockTool, ToolTestHarness } from '@cogitator-ai/testing'` — wrong package, neither export exists    | Changed to use `MockLLMBackend` from `@cogitator-ai/test-utils`                       |
| 20  | WASM sandbox example             | `import { wasmSandbox } from '@cogitator-ai/sandbox'` — `wasmSandbox` not exported from sandbox package       | Replaced with `defineWasmTool()` from `@cogitator-ai/wasm-tools`                      |
| 21  | WASM sandbox — `instance.call()` | `wasmSandbox.instantiate(module)` / `instance.call(func, ...args)` — nonexistent API                          | Replaced with correct `defineWasmTool()` API                                          |
| 22  | Tool config — `supportsProgress` | `supportsProgress: true` and `execute: async (params, { progress }) => {...}` — not in `ToolConfig` interface | Removed; `progress` is not in `ToolContext`; context has `agentId`, `runId`, `signal` |
| 23  | Tool config — `retry`            | `retry: { maxRetries, backoff, initialDelay, retryOn }` in tool config — not in `ToolConfig` interface        | Removed retry config block                                                            |

#### Incorrect field names (4)

| #   | Location                       | Issue                                                                                  | Fix                                                                            |
| --- | ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 24  | Sandbox best practices example | `sandbox: { memory: '256MB', cpu: 0.5 }` at config root                                | Changed to `resources: { memory: '256MB', cpus: 0.5 }` nested inside `sandbox` |
| 25  | Compound tools `execute` arg   | `execute: async ({ topic }, { tools })` — second arg is `ToolContext`, not `{ tools }` | Changed to `execute: async ({ topic }, context)`                               |
| 26  | MCP server example             | `MCPServer` constructor missing required `transport` field                             | Added `transport: 'stdio'` to config                                           |
| 27  | Tool testing                   | `new Agent({ model: 'gpt-4o', tools: [...] })` — `model` not an Agent config field     | Fixed to proper `Cogitator` + `Agent` pattern                                  |

#### Missing coverage (1)

| #   | Location | Issue                                                                    | Fix                                                       |
| --- | -------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 28  | Overview | No mention of `builtinTools` array or `@cogitator-ai/wasm-tools` package | Added complete built-in tools list and wasm-tools section |

### Source of Truth Verified

| Claim                                                                                                     | Verified Against             | Result                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `tool()` from `@cogitator-ai/core`                                                                        | core/src/tool.ts             | ✅ Correct                                                                                                                 |
| `ToolRegistry` from `@cogitator-ai/core`                                                                  | core/src/registry.ts         | ✅ Correct                                                                                                                 |
| `ToolRegistry` methods: register, registerMany, get, has, getAll, getSchemas, getNames, clear             | core/src/registry.ts         | ✅ All verified                                                                                                            |
| `tool()` options: name, description, parameters, execute, sideEffects, requiresApproval, timeout, sandbox | types/src/tool.ts            | ✅ All in ToolConfig                                                                                                       |
| `SandboxConfig.resources.memory`, `.cpus`                                                                 | types/src/sandbox.ts         | ✅ Correct (field is `resources.memory`)                                                                                   |
| `MCPClient.connect()`, `connectMCPServer()`                                                               | mcp/src/client/mcp-client.ts | ✅ Correct                                                                                                                 |
| `MCPServer.registerTool()`, `.registerTools()`, `.start()`, `.stop()`                                     | mcp/src/server/mcp-server.ts | ✅ All verified                                                                                                            |
| `serveMCPTools()` helper                                                                                  | mcp/src/server/mcp-server.ts | ✅ Exists                                                                                                                  |
| 14 WASM tools in `@cogitator-ai/wasm-tools`                                                               | wasm-tools/src/index.ts      | ✅ Exactly 14: calc, hash, base64, json, slug, validation, diff, regex, csv, markdown, xml, datetime, compression, signing |
| `defineWasmTool()` API                                                                                    | wasm-tools/src/index.ts      | ✅ Correct signature                                                                                                       |
| `builtinTools` array                                                                                      | core/src/tools/index.ts      | ✅ Exists, 26 tools                                                                                                        |
