# @cogitator-ai/types

## 0.32.0

### Minor Changes

- [#112](https://github.com/cogitator-ai/Cogitator-AI/pull/112) [`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80) - A run whose tool calls use up `maxIterations` now ends with an answer. Until now the loop stopped at the last tool turn, so the output was empty and `structured` was undefined for an agent with a response format, with nothing telling the caller why. The run now gets one more turn with `toolChoice: 'none'` and an instruction to answer from what it has, and tools the model still asks for on that turn are not run. `RunResult.iterationLimitReached` is set whenever the limit is hit, and `onIterationLimit: 'stop'` on the agent keeps the old behaviour. The option survives `serialize` and `deserialize`.

## 0.31.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Agents can crawl politely. Nothing in Cogitator looked at robots.txt, so every app that read the web had to write its own check. `RobotsPolicy` in core reads and caches robots.txt per site by RFC 9309 (product token groups or `*`, longest match, `*` and `$` patterns, a 4xx file allows all, a 5xx or a network failure allows nothing until the cache expires) and implements the new `RobotsChecker` interface from types. `WebLoader` takes it as `robots` and checks every hop, redirect targets included, failing with `RobotsDisallowedError` before any request. `BrowserSession` takes it as `robots` and blocks disallowed navigations, typed, clicked, redirected or in frames, while `newTab(url)` and `browser_navigate` say why. `createWebScrapeTool({ userAgent, robots })` builds a `web_scrape` tool that checks every hop, redirects included.

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Debate turns name their speaker. The transcript that debaters and the moderator read labelled every turn by role, so with all debaters advocates it read "[advocate]: ..." throughout and nobody could tell who said what. Turns are now labelled with the speaker's name and its role when it has one. A new `synthesisPrompt` on `DebateConfig` replaces the moderator's fixed "summarise both sides" task, with `{topic}` and `{transcript}` filled in, for callers who want their own decision step. The `maxTokensPerTurn` docs now say that a reasoning model spends its reasoning from that budget, which left turns empty or cut off at a few hundred tokens.

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Dead letters can be retried for real and kept in Postgres. `DLQ.retry(id)` only bumped a counter, so retrying a failed node was left to every app. `WorkflowManager.retryDeadLetter(dlq, id)` now replays the entry's run from the failed node, keeping the checkpointed results of the nodes before it, or runs the workflow again from its input when the run failed before its first checkpoint. The attempt is recorded first and the entry is removed when the retry succeeds. `PostgresDLQ` stores the queue in Postgres (one table, created on first use, filters in SQL, `cleanupExpired()`), so failed nodes survive restarts and every process sees one queue. `retryDeadLetter` and `replay` take execute options, such as the `approvalStore` a retried run needs.

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - A human approval wait survives a restart. A request got a random id, so a run picked up again after a crash asked the same question twice and lost an answer given while the process was down. A request's id now comes from the run and the question, so a human node that runs again finds its own request: an answer given in the meantime is used at once, an open request is waited on without a second notification, and the timeout keeps counting from the original deadline. A node visited again in a loop asks about a changed state and opens a new request. `WorkflowManager.recoverRuns(options)` resumes the runs a stopped process left running or waiting from their last checkpoint. An escalation's id comes from the request it escalates and it keeps its own deadline, so a pending escalation is picked up too. `resume`, `replay` and `recoverRuns` start from the newest checkpoint saved for the run, even one the run record never heard of because the process stopped mid-flight.

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - A streamed run with only `onReasoning` now streams. The runtime streamed only when `onToken` was passed, so a caller that wanted the reasoning as it arrives, and not the answer tokens, got it all at the end in `result.reasoning`. `stream: true` with either callback streams now.

## 0.30.0

### Minor Changes

- [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2) - `RunResult.usage.cost` uses what the provider charged when it says so. OpenAI-compatible services that add the call's price to `usage` (OpenRouter does, as `usage.cost`) now pass it on as `ChatUsage.cost`, and the runtime adds those prices up instead of estimating them, so runs on models the model registry does not list (for example DeepSeek or Qwen through OpenRouter) no longer report a cost of 0. Calls without a reported price are priced from the registry as before, now with the full model string (`openrouter/deepseek/deepseek-v4-pro`) so the registry can pick that provider's listing. The cost so far is kept in run checkpoints, so a paused and resumed run adds to it. Thought trees and cost estimates use the same rules.

## 0.29.0

### Minor Changes

- 9175c69: `AutoOptimizer` A/B tests now get samples for both variants: traces carry the instructions version or A/B variant the run used (`ExecutionTrace.prompt`, from `RunResult.prompt`), runs served through `cogitator.prompts` are no longer counted again (all as control), and a test Cogitator completed finishes the optimization run. `ABTestingFramework` reads the active test from its store instead of a per-instance cache. `triggerOptimization()` fails with a clear error instead of optimizing empty instructions when the agent has no deployed version.
- 8d520c0: Gateway hooks are typed per hook name. `HookPayloads` maps every hook to its payload (`MessageReceivedEvent`, `AgentErrorEvent`, `ApprovalResolvedEvent`, ...), so `hooks.on('agent:error', (e) => e.error.message)` type-checks instead of receiving `unknown`; handlers typed with an `unknown` payload are still accepted. The `agent:error` payload now always carries an `Error`. `GatewayConfig.owner`, which the gateway never read, is deprecated in favour of `ownerIds` on `ownerCommands` and `dmPolicy`.
- 1993d56: Deliberate run failures are `CogitatorError`s with a code, so server adapters pass their messages on instead of masking them: a run timeout is `RUN_TIMEOUT` (504, new), a budget stop `BUDGET_EXCEEDED` (429, new), a guardrail-blocked input or output `LLM_CONTENT_FILTERED`, and a missing audio API key, an invalid `limits.maxConcurrentRuns` or a cost estimate without a model `CONFIGURATION_ERROR`. Messages are unchanged.
- b8c9eca: A custom backend can report its own provider name: `LLMBackend.provider` (and `BaseLLMBackend.provider`) is now `LLMBackendProvider`, a built-in `LLMProvider` or any other string, so `class MyBackend extends BaseLLMBackend { readonly provider = 'my-llm' }` compiles.
- db2e373: Sandbox fallbacks are explicit and safe. `sandbox.allowNativeFallback: false` refuses to run Docker-sandboxed tools on the host when Docker is unavailable (the fallback stays on by default, with a loud warning). WASM tools no longer fall back to Docker or native execution, which failed with "Command array is empty". Every Docker execution now gets a container no code ran in before (a fresh one is kept warm), so files and processes cannot leak between runs or users; `pool.reuseContainers: true` restores reuse.
- e2da4f9: Consensus voters get the `cast_vote`, `get_votes`, `change_vote` and `get_consensus_status` tools automatically (they were never attached, so votes could only be parsed from text). New `agentTools: { messaging, blackboard }` swarm option (and `SwarmBuilder.agentTools()`) gives every agent the built-in messaging and blackboard tools; it is rejected for distributed swarms and when the message bus or blackboard is disabled.
- ae26101: The run callbacks `onApprovalRequired`, `onTimerScheduled`, `onDeadLetter`, `onCompensationStart` and `onCompensationComplete` are now called by the executor and the manager. Nodes can declare a saga rollback with `config.compensation`: when a later node fails, the executor compensates the completed nodes (reverse order by default) before returning the error.

### Patch Changes

- e70e482: Counterfactuals now evaluate `custom` structural equations: `customFn` is an arithmetic expression over the parent node ids (numbers, `+ - * / ^`, parentheses, `abs exp log sqrt pow min max tanh sigmoid`), parsed without running code, with additive noise like `linear`. Nodes without an equation keep their observed value instead of a random noise sample.
- c117071: Tool cache fixes: `onEvict` also fires for entries evicted to make room (`maxSize`), not only for `invalidate()`. `RedisClientLike` now matches ioredis 5 and 6 (`scan(cursor, 'MATCH', pattern, 'COUNT', count)`), so an ioredis client can be passed as `redisClient`. A Redis `keyPrefix` without a trailing colon gets one, so `withCache` keys read `toolcache:entry:…` instead of `toolcacheentry:…`.
- 9175c69: `AgentOptimizer` now applies `defaultMetrics`, `customMetrics`, `captureTraces` and `traceRetention` from its learning config, and `MetricEvaluator` evaluates metrics added with `registerMetric()` even when they are not in `config.metrics`. `autoOptimize`, `optimizeAfterRuns` and `traceStore` are marked deprecated: use `AutoOptimizer` and the `traceStore` option instead.
- e2da4f9: The assessor honours `mode: 'ai' | 'hybrid'` and `assessorModel`: inside a Swarm the model (default: the Cogitator's default model) analyzes the task, 'hybrid' adds the hard requirements the keyword rules detect, and any failure falls back to the rules with a warning. Model discovery inside a Swarm only offers cloud models whose provider the Cogitator can run, instead of suggesting providers without an API key. `createAssessor(config, cogitator)` takes the Cogitator for the same behaviour standalone.
- e2da4f9: Swarm config fields that were accepted but ignored now work or say why they cannot: `observability.tracing` logs each agent run's spans, `distributed.retry` re-dispatches jobs that fail on a worker or time out, and `distributed.cleanupAfter` expires the swarm's Redis state after `close()` (default one hour). `messaging.protocol` (now optional), `blackboard.locking` and `distributed.workerConcurrency` have no effect and are marked deprecated with the reason. `swarm.messageBus` and `swarm.events` are typed with their full API (`markAsRead`, `onMessage`, `getEventsByType`, `getEventsByAgent`).
- 6b7e672: Round-robin with `sticky: true` advances its rotation again: a known `stickyKey` stays with the agent that handled it first, while every new key goes to the next agent (before, the rotation never moved, so all keys landed on the first agent). Without a `stickyKey`, runs rotate normally. The `round-robin:assigned` event reports the index of the agent that was picked.

## 0.28.0

### Minor Changes

- 57ac053: Timer claims belong to the store instance that took them. `TimerStore` gains optional `claimTtl`, `renew(id)` and `release(id)`, which `RedisTimerStore` and `PostgresTimerStore` implement (Postgres adds a `claimed_by` column, also to existing tables). `TimerManager` renews a claim right before a handler starts and every `claimTtl / 3` while it runs, so a handler slower than the lease no longer lets another worker run the same timer; it skips a timer whose claim another worker took while it waited and reports it through the new `onClaimLost` option. A timer without a handler, or beyond a poll's `batchSize`, is released so another manager can take it right away. A failed handler still keeps the claim until the lease ends, which spaces out retries.

### Patch Changes

- 0ef09fc: `NeuroSymbolic.getConfig()` returns `ResolvedNeuroSymbolicConfig`, where every section (`logic`, `constraints`, `planning`, `knowledgeGraph`) is present, as it always was at runtime; callers no longer need optional chaining to read it.
- 6b16db1: `InMemoryRunStore` hands out copies of runs, so changing a returned run's node or tag lists no longer changes the stored run, and `list()` without filters is sorted like `list({})` (newest started first), matching the Redis and Postgres stores. `WorkflowRunStats` documents that cancelled runs count toward neither the success nor the failure rate.
- b8c7c3d: `memoryPages` now limits the WASM module's own memory, not only the memory Extism uses for input and output: the module's memory section gets that maximum before it loads, so `memory.grow` past it fails inside the module, and a module that needs more to start is refused. Modules given by URL are fetched by the executor so the limit applies to them as well.
- 35701f9: Workflow typing fixes. `addLoop` conditions receive the builder's state type, like `addConditional`, instead of `unknown`. `executeParallelSubworkflows`, `parallelSubworkflows`, `fanOutFanIn` and `scatterGather` carry the child workflow state (`CS`), so a typed child workflow fits without casts. `'noop'` is a valid tracing exporter, and `WorkflowTracer.isSampled()` is `false` with a sample rate of 0.

## 0.27.0

### Minor Changes

- 0933009: Agents hand conversations over to each other. `handoffs: [billing, support]` (or `{ agent, toolName, description }`) gives an agent `transfer_to_<name>` tools; when the model calls one, the rest of the run goes on as the target agent — instructions, tools, model, reasoning — with the whole conversation. `RunResult.handoffs` and `finalAgent` tell the app which agent answered, `onHandoff` reports each handoff, and a run that pauses for approval after a handoff resumes in the agent it was handed to.
- 0933009: Personal data stays away from the model provider. `security.pii` replaces emails, phone numbers, card numbers (Luhn-checked), IBANs (mod-97), SSNs, IP addresses, API keys and your own patterns with placeholders such as `[EMAIL_1]` in every LLM request. In `mask` mode the answer, its stream and tool call arguments get the real values back, so tools still act on the real address; `redact` keeps the placeholders everywhere, and `block` rejects such input with `PII_DETECTED`. `onDetect` receives counts per kind for audit logs, never the values. `PiiMasker`, `PiiVault` and `withPiiMasking` are exported for use outside a run, and YAML config accepts custom patterns as strings.
- 0933009: Agent instructions get versions you can deploy, roll back and A/B test without redeploying code. `cog.prompts.deploy(agent, instructions)` makes every following run of that agent use the new version, `rollbackTo` brings the previous one back, and each version records its run count, success rate, score, latency and cost. `startABTest` splits threads between the current instructions and a treatment — a thread keeps its variant for the whole test — completes on a significant difference (Welch's t-test) and with `autoDeployWinner` deploys the winner. `RunResult.prompt` says which version and variant ran; `prompts.score` scores runs your way. Versions and tests live in memory by default, or in Postgres via `PostgresTraceStore.instructionVersions()` / `abTests()`.
- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

- 7bee3ef: Runs pause for a person to approve sensitive tool calls and continue later.

  - A tool with `requiresApproval` never runs without a decision. `RunOptions.onApproval` (or `guardrails.onToolApproval`) decides inline; otherwise the run pauses before executing the turn and returns `status: 'paused'`, `pendingApprovals` and a JSON `checkpoint`. `cogitator.resume(agent, threadId | checkpoint, { decisions, defaultDecision, userId })` executes the approved calls, answers declined ones with the reason, and goes on. A new message on the thread instead declines the waiting calls.
  - Paused runs are kept per thread in the memory adapter's thread metadata (`ThreadRunCheckpointStore`), in process memory without memory (`InMemoryRunCheckpointStore`), or in `runCheckpoints`. Resuming by thread checks the caller (`THREAD_ACCESS_DENIED`); a thread with nothing paused answers the new `RUN_NOT_PAUSED` (409).
  - `agentAsTool` passes the caller's `userId` to the delegated run and declines its approvals unless given `onApproval`, instead of reporting a paused sub-run as success.
  - Server adapters answer paused runs with `status` / `pendingApprovals` (never the checkpoint), stream `approval-required`, and take `POST /agents/:name/resume` (plus a WebSocket `resume` message); Next.js has `createResumeHandler` and `pendingApprovals` / `approve()` / `deny()` in its hooks; channels ask in the chat and resume on "approve" / "deny <reason>" (also "да" / "нет").

  **Behaviour change:** `requiresApproval` used to be enforced only with constitutional guardrails and an `onToolApproval` callback; without them such tools ran unasked. They now pause the run. WebSocket `complete` events no longer include a paused run's checkpoint.

- 4964fb6: Workflow checkpoints in Redis and Postgres, and resuming that resumes.

  - `RedisCheckpointStore` (an `@cogitator-ai/redis` client or ioredis) and `PostgresCheckpointStore` (a `pg` Pool; creates its table on first use) keep checkpoints where any process can resume them.
  - **Fixes:** `WorkflowExecutor.resume()` ran finished nodes again when they followed another finished node, and nodes after a finished node lost its output as their input; both are fixed (`WorkflowExecuteOptions.nodeResults` carries the outputs). Checkpoints saved in the same millisecond now get increasing timestamps, so "latest" is the latest. `WorkflowManager.replay(workflow, runId, node)` runs the node and everything after it again (it used to skip some of them) with the earlier nodes' results, and a manager with a `checkpointStore` checkpoints its runs by default, so they can be replayed.

## 0.26.0

### Minor Changes

- 9ff5a06: Agent runs retry failed LLM calls instead of failing on the first 429 or 5xx.

  - New `llm.retry` (`maxRetries` 2, `baseDelay` 1000, `maxDelay` 30000, `maxRetryAfter` 60000, `onRetry`; `false` turns it off) applies to every backend the runtime uses, `llm.backends` and plugins included. Only retryable errors are retried: rate limits, 5xx, timeouts, dropped connections.
  - A provider's wait is honoured: `retry-after`, `retry-after-ms`, an HTTP date or Gemini's `RetryInfo.retryDelay`. A wait longer than `maxRetryAfter` fails the call at once.
  - Streams are retried only before their first chunk; the run's timeout and abort signal stop the waits.
  - `withLLMRetry(backend, config)` / `RetryingBackend` give a standalone backend the same behaviour; `retryAfterFromHeaders` is exported.

  **Behaviour changes:** backends created by `createLLMBackend` no longer retry inside the OpenAI, Anthropic, Azure and Bedrock SDKs (new `maxRetries` backend option, the runtime passes 0), so attempts never multiply — wrap such a backend with `withLLMRetry` when using it on its own. `LLMError.retryAfter` now holds only a wait the provider asked for; it is `undefined` instead of an invented 60 s (429), 5 s (5xx) or 1 s otherwise. `cogitator.route()` returns the retrying wrapper unless `llm.retry` is `false`.

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

## 0.25.0

### Minor Changes

- c4a4252: Agents can run on backends of your own. `llm.backends` takes `LLMBackend` instances by name: an agent with model `name/model` or `provider: 'name'` runs on it, and a name of a built-in provider replaces it. Backend plugins registered with `registerLLMBackend()` are now used by the runtime, created on first use with their config from `llm.plugins`; before, the registry was never consulted. A provider nobody provides fails with `CONFIGURATION_ERROR`. `cogitator.route(model)` returns the backend and model name a run uses. With `fromAISDK()`, any AI SDK model now runs Cogitator agents, tools included.
- f134b01: Config keys that did nothing now either work or are gone.

  - `reflection.reflectAfterError` works: a failed tool call gets the error reflection (`ReflectionEngine.reflectOnError`), and its suggestion reaches the next model call.
  - `TimeTravelConfig.maxCheckpointsPerTrace` and `checkpointRetention` are enforced when `TimeTravel` saves checkpoints.

  **Breaking (types):** removed keys nothing read — `CogitatorConfig.knowledgeGraph` and `promptOptimization` (the knowledge-graph and prompt-optimization classes keep their own config types), `ContextManagerConfig.windowOverlap`, `TimeTravelConfig.autoCheckpoint` / `autoCheckpointInterval`, `ReplayOptions.onStep` / `pauseAt`, and `CompileOptions.teacherModel` / `verbose`. The YAML schema drops the same keys.

- 6404340: `llm.defaultModel` and `limits` now do what they say.

  - An agent may leave out `model` (`AgentConfig.model` is optional): it runs on the Cogitator's `llm.defaultModel`, and a run without either fails with a `CONFIGURATION_ERROR` naming the agent. `cogitator.resolveModel(agent)` returns the model a run uses. **Breaking for types:** `Agent.model` is `string | undefined`.
  - `limits.maxConcurrentRuns` caps concurrent `run()` calls; the rest wait in order, and their timeout and abort signal cover the wait.
  - `limits.defaultTimeout` applies to runs whose options and agent set no timeout. The 120 s default moved from the `Agent` constructor to the runtime, so `agent.config.timeout` is `undefined` unless set.
  - `limits.maxTokensPerRun` is checked before every model call and fails the run with the new `RUN_TOKEN_LIMIT_EXCEEDED` code.
  - Swarms: the assessor and the distributed coordinator resolve models through the Cogitator, so agents without a model work there too (`Assessor.analyze()` takes an optional resolver).

- c1cd7a1: Guardrails take partial configs and keep the revisions they produce.

  - `CogitatorConfig.guardrails` and `security.promptInjection` are `Partial<…>`: fields left out take the defaults, as the runtime always merged them. The YAML schema accepts partial blocks too (`thresholds` may name some categories).
  - Guardrails are on when configured, unless `enabled: false`, matching `DEFAULT_GUARDRAIL_CONFIG`. The run checks the merged config: a partial config such as `{ enabled: true }` filtered nothing before.
  - When the output filter blocked an answer and the critique-revise loop produced a safe one, `filterOutput()` returned `allowed: true` with the revision, so the run kept the original harmful text and the violation was never logged. It now returns the block with `suggestedRevision`, the run answers with the revision, and the violation reaches the log and `onViolation`.
  - `filterToolResults` is implemented: tool results pass the input filter before the model reads them (`ConstitutionalAI.filterToolResult()`).

### Patch Changes

- f36a121: Time travel works end to end.

  - `compare()` and `compareWithOriginal()` failed with `Trace not found` because nothing wrote to the trace store. Checkpoints, replays and forks now store their traces; a deterministic replay's trace is the original's up to the replayed step.
  - `mockToolResults` (forks) and `modifiedToolResults` (replays) are keyed by tool name, as documented: the tool answers with the given value and never runs. Before, live replays looked them up by call id and never matched. In deterministic replays a modified result now wins over the cached one.
  - `skipTools` removes the tools from the replayed agent; it did nothing before.
  - Checkpoints record the results of tool calls (`toolResults` was always empty) and pick the pending call by call id.
  - `AgentOptimizer.captureTrace()` stores traces under the run's trace id, so it can share a trace store with `TimeTravel`.

## 0.24.0

### Minor Changes

- Added `ToolCall.replay`, `ChatUsage` (`cachedInputTokens`, `reasoningTokens`) and `OpenAIProviderConfig.api`.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

## 0.23.0

### Minor Changes

- Declarative package (steps 7, 8 and 10 skipped). Build and lint are clean, all 33 modules are exported, and zod is correctly a dependency. Reviewed the diff since 2026-05-15; no any or @ts-ignore found. One fix: DeployTarget advertised 'railway' | 'k8s' | 'ssh', which had no deploy providers and crashed at deploy time. It is narrowed to 'docker' | 'fly', with the config schema changed to match. The edit is a minimal one-line change to deploy.ts; message.ts, self-modifying.ts and the README, which the core agent was editing at the same time, were left untouched.

  **Breaking changes**
  - DeployTarget is now 'docker' | 'fly' (removed the never-implemented 'railway' | 'k8s' | 'ssh').

## 0.22.3

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

## 0.22.2

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.

## 0.22.1

### Patch Changes

- fix(core): comprehensive audit — 30+ critical/high bugs fixed

  Critical fixes:
  - Streaming: tool call continuation chunks no longer silently dropped
  - Security: prompt injection in LLM classifier fixed, path traversal in self-tools patched, SQL injection in vector-search fixed
  - Constitutional AI: fail-open default removed, violations now always blocked
  - Causal reasoning: d-separation algorithm correctness fix
  - Learning: incompleteBeta replaced with Lentz's continued fraction, postgres trace store race condition fixed

  High-severity fixes:
  - LLM backends: OpenAI tool_calls preserved in multi-turn, Google stream buffer flushed, Anthropic stop_reason captured, Bedrock init cache reset, Ollama reader released
  - Runtime: initialization race condition fixed, ESM require.resolve compatibility
  - Redis cache: KEYS command replaced with counter + SCAN

  Also: 21 missing public API exports added (LLM errors, debug wrapper, plugin system, cost estimators), 6 new test files (68 tests), 9 regression tests, nodemailer peer dependency added.

## 0.21.3

### Patch Changes

- fix(types): audit — 13 bugs/type-safety issues fixed, dead code removed
  - Added missing `responseFormat` to `SerializedAgentConfig`
  - Fixed `DurationString` type (removed useless `| string` union)
  - Added `coherence` field to `TraceMetrics`
  - Removed duplicate config fields in `MetaReasoningConfig`
  - Renamed `turnDuration` to `maxTokensPerTurn` in `DebateConfig`
  - Narrowed `NegotiationTerm.value` to `string | number | boolean`
  - Typed `CapturedPrompt.tools` as `ToolSchema[]`
  - Made `GraphStats` Record fields Partial
  - Removed dead duplicate fields from `MetaAssessment` and `ModificationValidationResult`
  - Removed unused `ProposedActionType`

## 0.21.1

### Patch Changes

- fix(memory): audit — 42 bugs fixed, +122 tests, v0.6.14
  - Fix SQL injection via schema name in Postgres and knowledge graph adapters
  - Fix Qdrant deleteEmbedding (wrong filter), metadata collision, search reconstruction
  - Fix Postgres keywordSearch params corruption, getEntries limit subquery, ILIKE injection
  - Fix Redis zrangebyscore exclusive bounds inconsistency
  - Fix BM25 duplicate query term scoring
  - Fix context builder facts/semantic context dropped without system prompt
  - Fix knowledge graph traversal paths, bidirectional edge support, merge self-references
  - Fix embedding services: add dimensions config to Google/OpenAI API requests
  - Add missing Zod schemas (SQLite, MongoDB, Qdrant configs)
  - Add EmbeddingProvider 'google' to types, OpenAIEmbeddingConfig dimensions field
  - Add createEmbeddingAdapter factory, export missing adapter config types
  - Fix dependencies: add missing optional/peer deps, move @types to devDeps
  - Add SQLite PRAGMA foreign_keys enforcement
  - Remove dead code (indexedIds, unused schema types)
  - Add 122 new tests (BM25, RRF, schema validation)

## 0.20.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

## 0.19.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking

## 0.19.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

## 0.19.0

### Minor Changes

- Add per-node checkpoint granularity with `checkpointStrategy` option
  - `'per-iteration'` (default): checkpoint after all parallel nodes complete
  - `'per-node'`: checkpoint after each node completes, enabling resume from partial parallel execution

## 0.18.0

### Minor Changes

- Add long-context optimization with automatic compression strategies

## 0.17.0

### Minor Changes

- feat: add audio/speech support with Whisper and TTS

  Audio Transcription (Whisper API):
  - `createTranscribeAudioTool` factory for speech-to-text
  - Support for whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe models
  - Word-level timestamps with verbose_json response format
  - URL and base64 audio input support

  Text-to-Speech (TTS API):
  - `createGenerateSpeechTool` factory for TTS generation
  - Support for tts-1, tts-1-hd, gpt-4o-mini-tts models
  - 13 voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
  - Output formats: mp3, opus, aac, flac, wav, pcm
  - Speed control: 0.25x to 4.0x

  Integration:
  - `AudioInput` and `AudioFormat` types
  - `audio` option in `cog.run()` for automatic transcription
  - `fetchAudioAsBuffer` and `audioInputToBuffer` helpers

## 0.16.0

### Minor Changes

- 6b09d54: feat(core): implement Agent serialization and deserialization

  Add serialize() and Agent.deserialize() methods for agent persistence:
  - AgentSnapshot format with version field for backward compatibility
  - Tool names stored instead of full tool objects (functions are not serializable)
  - Tool resolution via ToolRegistry or direct array on deserialize
  - Config overrides support during restoration
  - Agent.validateSnapshot() for runtime type checking
  - AgentDeserializationError for clear error messages

  This enables:
  - Pause/resume agents across process restarts
  - Sharing agent configurations as JSON
  - Storing agents in databases

## 0.15.0

### Minor Changes

- feat(cost-routing): implement cost prediction before agent execution

  Add `estimateCost()` method to Cogitator that estimates the cost of running an agent BEFORE execution.

  New components:
  - `TokenEstimator`: Heuristic-based token estimation
  - `CostEstimator`: Combines task analysis, model pricing, and token estimation

  Features:
  - Complexity-based output token estimates (simple/moderate/complex)
  - Iteration and tool call estimation based on task requirements
  - Confidence scores (lower for complex tasks with many tools)
  - Local model detection (Ollama models return $0 cost)
  - Warnings for unpredictable costs, missing pricing data

## 0.14.0

### Minor Changes

- feat(security): implement prompt injection detection

  Add PromptInjectionDetector to protect agents from adversarial inputs:
  - Local classifier: fast regex + heuristics (<5ms latency)
  - LLM classifier: semantic analysis for complex attacks
  - 30+ built-in patterns for 5 threat types (direct injection, jailbreak, roleplay, context manipulation, encoding)
  - Allowlist support for false positive prevention
  - Custom pattern support with runtime add/remove
  - Integration with Cogitator via security.promptInjection config

## 0.13.0

### Minor Changes

- feat(core): implement tool caching layer with semantic matching
  - Add withCache() wrapper for caching tool execution results
  - Support exact match (SHA256 hash) and semantic (embedding similarity) caching
  - InMemoryToolCacheStorage with LRU eviction
  - RedisToolCacheStorage with TTL and sorted sets
  - Cache stats, invalidation, warmup, and callbacks

## 0.12.0

### Minor Changes

- feat(workflows): implement real-time streaming with progress reporting

  Add Server-Sent Events style streaming for workflow execution:
  - Add StreamingWorkflowEvent type with modern underscore-style events
  - Add workflow_started, node_started, node_progress, node_completed, workflow_completed events
  - Add reportProgress callback to NodeContext for nodes to report 0-100% progress
  - Add onNodeProgress callback to WorkflowExecuteOptions

## 0.11.0

### Minor Changes

- feat(memory): implement hybrid search with BM25 + vector fusion

  Add comprehensive hybrid search capability combining keyword search (BM25) with semantic vector search using Reciprocal Rank Fusion (RRF):
  - BM25Index class with inverted index for fast keyword search
  - Tokenizer with stopword filtering and text normalization
  - RRF algorithm for combining ranked results from different sources
  - HybridSearch class with three search strategies: vector, keyword, hybrid
  - PostgreSQL adapter extended with tsvector/tsquery full-text search
  - InMemoryEmbeddingAdapter for testing without database dependency
  - New types: SearchStrategy, SearchOptions, SearchResult, HybridSearchConfig

## 0.10.1

### Patch Changes

- feat(workflows): implement ParallelEdge support in WorkflowBuilder

  Added `addParallel()` method to WorkflowBuilder for creating parallel fan-out edges:

  ```typescript
  const workflow = new WorkflowBuilder<MyState>('parallel-workflow')
    .addNode('start', async () => ({ output: 'ready' }))
    .addParallel('fanout', ['a', 'b', 'c'], { after: ['start'] })
    .addNode('a', async () => ({ output: 'a' }))
    .addNode('b', async () => ({ output: 'b' }))
    .addNode('c', async () => ({ output: 'c' }))
    .addNode('merge', async (ctx) => ({ output: ctx.input }), {
      after: ['a', 'b', 'c'],
    })
    .build();
  ```

  - Parallel nodes execute concurrently (respects maxConcurrency)
  - Fan-in support: merge node receives array of outputs from parallel branches
  - Works with existing conditional and loop edges

## 0.10.0

### Minor Changes

- 58a7271: Phase 6: DX Improvements
  - Add structured LLM errors with rich context (provider, model, endpoint, statusCode, retryable, retryAfter)
  - Add debug mode wrapper with request/response logging
  - Add type-safe provider configurations with discriminated unions
  - Add plugin system for registering custom LLM backends

## 0.9.0

### Minor Changes

- Phase 5: Memory adapters and observability integrations

  Memory Adapters:
  - SQLite adapter with WAL mode for zero-config local development
  - MongoDB adapter for flexible document storage
  - Qdrant vector adapter for semantic similarity search

  Observability:
  - Langfuse exporter for LLM-native observability
  - OpenTelemetry OTLP exporter for universal tracing

  All adapters use dynamic imports - install only what you need.

## 0.8.1

### Patch Changes

- faed1e7: feat(core): add 6 new built-in tools

  New tools for web, database, and productivity:
  - `webSearch` - Search the web via Tavily, Brave, or Serper APIs
  - `webScrape` - Extract content from web pages (text/markdown/html output, CSS selectors)
  - `sqlQuery` - Execute SQL queries against PostgreSQL or SQLite
  - `vectorSearch` - Semantic search with embeddings (OpenAI/Ollama/Google + pgvector)
  - `sendEmail` - Send emails via Resend API or SMTP
  - `githubApi` - GitHub API integration (issues, PRs, files, commits, search)

  All tools support auto-detection of providers from environment variables and use dynamic imports for optional dependencies.

  Also adds new tool categories (`web`, `database`, `communication`, `development`) and `external` side effect type.

## 0.8.0

### Minor Changes

- 70679b8: feat(core): add Azure OpenAI and AWS Bedrock backends

  Enterprise LLM providers for production deployments:

  **Azure OpenAI:**
  - Full chat and streaming support via official OpenAI SDK
  - Configurable deployment, endpoint, and API version
  - Tool calling, structured outputs, vision

  **AWS Bedrock:**
  - Uses Converse API for unified chat interface
  - Dynamic SDK import (optional peer dependency)
  - Supports Claude, Llama, Mistral, Cohere, Titan models
  - Tool calling with proper type safety

  Both backends integrate seamlessly with the universal LLM interface.

- 2f599f0: feat: add parallel tool execution and tool choice support

  **Parallel Tool Execution:**
  - New `parallelToolCalls` option in `RunOptions` enables concurrent tool execution
  - When enabled, independent tool calls execute via `Promise.all` for improved performance
  - Default remains sequential execution for deterministic behavior

  **Tool Choice:**
  - New `ToolChoice` type: `'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }`
  - New `toolChoice` field in `ChatRequest` interface
  - Provider-specific implementations:
    - OpenAI: native tool_choice support
    - Anthropic: maps to `tool_choice` with `type: 'auto' | 'any' | 'tool'`
    - Google: uses `functionCallingConfig` with mode and allowedFunctionNames
    - Ollama: filters tools based on choice (workaround for no native API support)

- 10956ae: feat: add structured outputs / JSON mode support

  Implement responseFormat parameter across all LLM backends for guaranteed JSON output:
  - **json_object**: Simple JSON mode - model returns valid JSON
  - **json_schema**: Strict schema validation with name, description, and schema definition

  Works with all backends:
  - OpenAI: Native response_format support
  - Anthropic: Tool-based JSON schema forcing
  - Google: responseMimeType and responseSchema in generationConfig
  - Ollama: format parameter with 'json' or schema object

  ```typescript
  // Simple JSON mode
  const result = await backend.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'List 3 colors as JSON array' }],
    responseFormat: { type: 'json_object' },
  });

  // Strict schema validation
  const result = await backend.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Extract person info' }],
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'person',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      },
    },
  });
  ```

- 218d91f: feat: add vision / multi-modal support

  Message content now supports images in addition to text:
  - `MessageContent` = `string | ContentPart[]`
  - `ContentPart` can be `text`, `image_url`, or `image_base64`

  All LLM backends updated to handle multi-modal content:
  - **OpenAI**: `image_url` parts with detail level support
  - **Anthropic**: `image` source with URL or base64
  - **Google Gemini**: `inlineData` and `fileData` parts
  - **Ollama**: `images` array with base64 data

## 0.7.0

### Minor Changes

- a7c2b43: feat(core): add explicit provider override in AgentConfig

  Allows specifying provider directly in AgentConfig (e.g., 'openai' for OpenRouter) instead of relying only on model string parsing.

## 0.6.0

### Minor Changes

- f874e69: ### Memory improvements
  - Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
  - Add Google embedding service using `text-embedding-004` model (768 dimensions)
  - Implement hybrid context strategy (30% semantic + 70% recent messages)
  - Fix foreign key constraint violation when saving entries before thread creation

  ### Swarms improvements
  - Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
  - Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
  - Fix coordinator to properly register pipeline stages and handle missing negotiation section

## 0.5.0

### Minor Changes

- 05de0f1: feat(neuro-symbolic): add neuro-symbolic AI package

### Patch Changes

- feat(causal): add causal reasoning engine

  Implement full causal reasoning framework based on Pearl's Ladder of Causation:

  **Causal Graphs**
  - CausalGraphImpl with Map-based storage
  - CausalGraphBuilder fluent API
  - Node/edge operations (parents, children, ancestors, descendants)
  - Path finding with strength accumulation
  - Cycle detection and Markov blanket computation

  **Inference Engine**
  - D-separation algorithm (Bayes-Ball)
  - Backdoor and frontdoor adjustment criteria
  - Interventional effect computation
  - Average Treatment Effect (ATE) estimation
  - Effect identifiability checking

  **Counterfactual Reasoning**
  - Three-phase algorithm: Abduction → Action → Prediction
  - Structural equation evaluation (linear/logistic)
  - Counterfactual query handling

  **Causal Discovery**
  - LLM-based causal extraction from tool results
  - Hypothesis generation from traces
  - Counterfactual validation via forking
  - Pattern recognition and evidence accumulation

  **Types**
  - CausalNode, CausalEdge, CausalGraph interfaces
  - CausalRelationType: causes, enables, prevents, mediates, confounds, moderates
  - InterventionQuery and CounterfactualQuery types
  - StructuralEquation with linear/logistic/custom support

  **Fixes**
  - self-modifying: Fix test API compatibility issues

- fb21b64: feat(neuro-symbolic): add neuro-symbolic AI package

  Introduce @cogitator-ai/neuro-symbolic - a hybrid neural-symbolic reasoning package with four modules:

  **Logic Programming**
  - Prolog-style parser and knowledge base
  - Robinson unification algorithm
  - SLD resolution with backward chaining
  - Built-in predicates (member, append, findall, etc.)
  - Proof tree generation and visualization

  **Knowledge Graph Queries**
  - SPARQL-like query builder with fluent API
  - Natural language query interface
  - Multi-hop reasoning engine
  - Transitive, inverse, and composition inference

  **Constraint Solving**
  - Fluent DSL for building constraint problems
  - Z3 WASM solver integration (optional)
  - Pure TypeScript SAT solver fallback
  - Support for bool, int, real, bitvec variables
  - Global constraints (allDifferent, atMost, atLeast)

  **Plan Verification**
  - PDDL-like action schema builder
  - Plan validation with precondition/effect checking
  - Safety property verification (invariant, eventually, always, never)
  - LLM-assisted plan repair
  - Dependency graph analysis

- 05de0f1: feat(self-modifying): add Self-Modifying Agents package

  Initial release of @cogitator-ai/self-modifying with comprehensive capabilities:

  **Tool Self-Generation**
  - GapAnalyzer: Detects missing capabilities by comparing user intent with available tools
  - ToolGenerator: LLM-based synthesis of new tools at runtime
  - ToolValidator: Security scanning + correctness validation
  - ToolSandbox: Safe execution environment for generated tools
  - InMemoryGeneratedToolStore: Persistence and learning from tool usage

  **Meta-Reasoning**
  - MetaReasoner: Core metacognitive layer monitoring agent's reasoning
  - StrategySelector: Dynamic reasoning mode switching (analytical, creative, systematic, etc.)
  - ObservationCollector: Real-time metrics gathering for reasoning quality

  **Architecture Evolution**
  - CapabilityAnalyzer: Task profiling and complexity estimation
  - EvolutionStrategy: Selection algorithms (UCB, Thompson sampling, epsilon-greedy)
  - ParameterOptimizer: Multi-armed bandit optimization for model parameters

  **Constraints & Safety**
  - ModificationValidator: Constraint checking for all self-modifications
  - RollbackManager: Checkpoint and undo system for safe experimentation
  - Default safety constraints preventing arbitrary code execution and infinite loops

  **Event System**
  - SelfModifyingEventEmitter: Observability events for all self-modification activities

  Also adds new types to @cogitator-ai/types for self-modifying capabilities.

## 0.4.0

### Minor Changes

- feat: add Knowledge Graph Memory and Prompt Auto-Optimization

  **Knowledge Graph Memory:**
  - PostgresGraphAdapter for entity-relationship storage with pgvector
  - Multi-hop graph traversal with BFS/DFS algorithms
  - Shortest path finding between nodes
  - Semantic node search with embeddings
  - LLMEntityExtractor for extracting entities/relations from text
  - GraphInferenceEngine for rule-based relationship inference
  - GraphContextBuilder for graph-aware context building

  **Prompt Auto-Optimization:**
  - PostgresTraceStore for persistent trace and prompt storage
  - PromptLogger wrapper for capturing all LLM prompts
  - ABTestingFramework with Welch's t-test statistical analysis
  - PromptMonitor for real-time performance monitoring with degradation detection
  - RollbackManager for instruction version control
  - AutoOptimizer for automated optimization pipeline with A/B testing

## 0.3.1

### Patch Changes

- **Type safety**: Remove `| string` from `ToolCategory` to enforce strict literal types
- **Type safety**: Remove `| string` from `SwarmEventType` to enforce strict literal types
- **SwarmEventType**: Add missing event literals that were previously hidden by `| string`:
  - `swarm:paused`, `swarm:resumed`, `swarm:aborted`, `swarm:reset`
  - `consensus:turn`, `consensus:reached`, `consensus:vote:changed`
  - `auction:start`, `auction:complete`
  - `pipeline:stage:complete`, `pipeline:gate:pass`, `pipeline:gate:fail`
  - `round-robin:assigned`, `assessor:complete`
- **SwarmEventEmitter**: Allow wildcard `'*'` in `once()` and `off()` methods
- **Immutability**: Add `readonly` modifiers to `RunResult` interface for safer result handling

## 0.3.0

### Minor Changes

- **Tool categories**: Added `category` and `tags` fields to `ToolConfig` and `Tool` interfaces
- **Memory error callback**: Added `onMemoryError` callback to `RunOptions`

### New Types

- `ToolCategory` - union type for tool categorization

## 0.2.0

### Minor Changes

- feat(swarms): add AI Assessor for dynamic model casting

  Introduces the Assessor system that analyzes tasks and automatically assigns optimal models to each agent role before swarm execution.

  **New features:**
  - `SwarmBuilder.withAssessor()` - enable automatic model selection
  - `swarm.dryRun()` - preview model assignments without executing
  - `metadata.locked` - lock specific agents to prevent model changes
  - Local-first model preference (Ollama over cloud when capable)
  - Budget-aware cost optimization with `maxCostPerRun`

  **New exports from @cogitator-ai/swarms:**
  - `SwarmAssessor`, `createAssessor` - main assessor API
  - `TaskAnalyzer` - rule-based task analysis
  - `ModelDiscovery` - discover Ollama + cloud models
  - `ModelScorer` - score models against requirements
  - `RoleMatcher` - adjust requirements per agent role

  **Example usage:**

  ```typescript
  const swarm = new SwarmBuilder('research-team')
    .strategy('hierarchical')
    .supervisor(supervisorAgent)
    .workers([researcher, writer])
    .withAssessor({
      preferLocal: true,
      maxCostPerRun: 0.1,
    })
    .build(cogitator);

  // Preview assignments
  const preview = await swarm.dryRun({ input: 'Research task...' });

  // Models auto-assigned on first run
  const result = await swarm.run({ input: 'Research task...' });
  ```
