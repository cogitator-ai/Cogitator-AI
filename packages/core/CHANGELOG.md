# @cogitator-ai/core

## 0.30.0

### Minor Changes

- [#112](https://github.com/cogitator-ai/Cogitator-AI/pull/112) [`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80) - A run whose tool calls use up `maxIterations` now ends with an answer. Until now the loop stopped at the last tool turn, so the output was empty and `structured` was undefined for an agent with a response format, with nothing telling the caller why. The run now gets one more turn with `toolChoice: 'none'` and an instruction to answer from what it has, and tools the model still asks for on that turn are not run. `RunResult.iterationLimitReached` is set whenever the limit is hit, and `onIterationLimit: 'stop'` on the agent keeps the old behaviour. The option survives `serialize` and `deserialize`.

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/memory@0.11.3
  - @cogitator-ai/sandbox@0.5.3

## 0.29.0

### Minor Changes

- [#111](https://github.com/cogitator-ai/Cogitator-AI/pull/111) [`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8) - `web_search` gets filters that work on every provider: `topic` (`general` or `news`), `recency` (`day`, `week`, `month`, `year`) or a `dateRange`, `includeDomains` and `excludeDomains`, `country`, `language` and `page`. Each maps to the provider's own parameters (Tavily's request fields, the news endpoints and query parameters of Brave and Serper), with `site:` operators where a provider has no domain parameter. A filter a provider cannot apply comes back as an error instead of being dropped. Tavily also takes `includeRawContent` and the `fast` and `ultra-fast` search depths. Results carry `publishedAt` in ISO 8601 when the provider reports a date, `source` for Serper news and `content` for raw page content. `createWebSearchTool({ provider, apiKeys })` builds the tool with a default provider and keys passed in code.

## 0.28.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Agents can crawl politely. Nothing in Cogitator looked at robots.txt, so every app that read the web had to write its own check. `RobotsPolicy` in core reads and caches robots.txt per site by RFC 9309 (product token groups or `*`, longest match, `*` and `$` patterns, a 4xx file allows all, a 5xx or a network failure allows nothing until the cache expires) and implements the new `RobotsChecker` interface from types. `WebLoader` takes it as `robots` and checks every hop, redirect targets included, failing with `RobotsDisallowedError` before any request. `BrowserSession` takes it as `robots` and blocks disallowed navigations, typed, clicked, redirected or in frames, while `newTab(url)` and `browser_navigate` say why. `createWebScrapeTool({ userAgent, robots })` builds a `web_scrape` tool that checks every hop, redirects included.

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - A streamed run with only `onReasoning` now streams. The runtime streamed only when `onToken` was passed, so a caller that wanted the reasoning as it arrives, and not the answer tokens, got it all at the end in `result.reasoning`. `stream: true` with either callback streams now.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/sandbox@0.5.2

## 0.27.0

### Minor Changes

- [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe) - New `cog.knowsProvider(name)` tells whether a `name/...` model prefix routes to that provider: a backend in `llm.backends`, a built-in provider or a registered plugin. It is the check `cog.route()` uses, so code that hands a model string to another process (such as `@cogitator-ai/worker`) can tell a provider prefix from a model name that merely contains a slash, like `meta-llama/llama-4-scout`.

- [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2) - `RunResult.usage.cost` uses what the provider charged when it says so. OpenAI-compatible services that add the call's price to `usage` (OpenRouter does, as `usage.cost`) now pass it on as `ChatUsage.cost`, and the runtime adds those prices up instead of estimating them, so runs on models the model registry does not list (for example DeepSeek or Qwen through OpenRouter) no longer report a cost of 0. Calls without a reported price are priced from the registry as before, now with the full model string (`openrouter/deepseek/deepseek-v4-pro`) so the registry can pick that provider's listing. The cost so far is kept in run checkpoints, so a paused and resumed run adds to it. Thought trees and cost estimates use the same rules.

### Patch Changes

- [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7) - Structured output with tools now works on OpenAI-compatible servers other than OpenAI. When an agent has both tools and a `responseFormat`, requests to such servers (OpenRouter, DeepSeek, Groq, Together, Mistral, vLLM or an `OpenAIBackend` with a custom `baseUrl`) carry the JSON schema as a system-prompt instruction instead of `response_format`. Many of these providers enforced `response_format` from the first turn, so the model answered in JSON without calling its tools, or ignored the schema: through OpenRouter, DeepSeek V4 Pro called the tool in 1 of 5 runs and matched the schema in none, and Qwen 3.8 Flash never matched it. With the schema in the prompt all tested models (DeepSeek, GPT-6 Luna, Qwen, MiMo, GLM) called the tool and matched the schema every time. The official OpenAI API and Azure OpenAI, and every request without tools, still use `response_format`.

- [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57) - `LangfuseExporter.flush()` and `shutdown()` now wait until Langfuse has received the queued events. They called the Langfuse client's `flush()` and `shutdown()`, which return immediately without waiting, so traces sent just before a process exited could be lost. They now await `flushAsync()` and `shutdownAsync()`. A hand-written type declaration for `langfuse` hid the difference, and it is gone together with the ones for `nodemailer` and `better-sqlite3`: the exporter, the `send_email` tool and the `sql_query` tool are now checked against the real packages' types. Generations no longer send unset `temperature` or `maxTokens` as `undefined` model parameters.

- [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9) - Memory failures are no longer dropped silently. Adapters report most failures as a failed `MemoryResult` rather than by throwing, and the runtime only caught throws, so a history entry the store refused (for example every tool call turn on Postgres) was lost without a warning and `onMemoryError` was never called. Failed `addEntry`, `getThread`, `createThread` and history `getEntries` results are now logged and passed to `onMemoryError` (`'save'` or `'load'`), and the run still goes on, as documented.

- [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7) - `OpenAIBackend` accepts any provider name, not only the built-in ones, so an OpenAI-compatible service registered as a custom backend reports its own name in errors and traces: `new OpenAIBackend({ apiKey, baseUrl: 'https://openrouter.ai/api/v1', provider: 'openrouter' })` now compiles and its errors say `openrouter` instead of `openai`.
- Updated dependencies [[`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`e150c83`](https://github.com/cogitator-ai/Cogitator-AI/commit/e150c83e8c9dc1bd9961d0a3413cf31d0d9175f1)]:
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/models@18.2.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/sandbox@0.5.1

## 0.26.2

### Patch Changes

- [`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41) - The optional `nodemailer` peer dependency of the `send_email` tool now accepts versions 6 through 10 instead of only 6. nodemailer 6 has known vulnerabilities that are fixed only in newer majors, and the old range made a fixed version a peer-dependency conflict. The tool uses only `createTransport` and `sendMail`, which are unchanged across these versions.

## 0.26.1

### Patch Changes

- 9a7b6f4: A run no longer ends on an empty turn. When the model stops with neither text nor tool calls — Gemini occasionally does this right after a tool result — the run asks again, up to twice, instead of returning an empty answer (and, for structured output, an `undefined` `structured`). The empty turn is never added to the conversation or saved to the thread, and the retries count towards `maxIterations`. Turns cut off by the token limit are not retried.

## 0.26.0

### Minor Changes

- 9175c69: `AutoOptimizer` A/B tests now get samples for both variants: traces carry the instructions version or A/B variant the run used (`ExecutionTrace.prompt`, from `RunResult.prompt`), runs served through `cogitator.prompts` are no longer counted again (all as control), and a test Cogitator completed finishes the optimization run. `ABTestingFramework` reads the active test from its store instead of a per-instance cache. `triggerOptimization()` fails with a clear error instead of optimizing empty instructions when the agent has no deployed version.
- 1993d56: Cost routing budgets (`costRouting.budget`) are enforced on every run, not only with `autoSelectModel`: the run is checked against an estimate for the agent's own model. `autoSelectModel` now picks only models of providers the runtime can call (configured in `llm.providers`, `llm.backends`, a plugin, `llm.defaultProvider` or the agent's own provider) and keeps the agent's model when none fits. New `CostAwareRouter.recommendAvailableModel()` and `checkRunBudget()`.
- 1993d56: `CogitatorConfig.logging` is applied: a runtime created with it sets the process-wide logger (`getLogger()`) to its `level` (now including `'silent'`), `format` and `destination` (`'file'` appends JSON lines to `filePath`). New `createLoggerFromConfig()` builds such a logger directly.
- 656499e: `createToolCacheStorage()` now accepts `onEvict` and passes it to the memory or Redis storage, so evictions of a storage built with it can be observed. A `keyPrefix` (or `generateCacheKey` prefix) that already ends with `:` no longer produces keys with `::`.
- b8c9eca: A custom backend can report its own provider name: `LLMBackend.provider` (and `BaseLLMBackend.provider`) is now `LLMBackendProvider`, a built-in `LLMProvider` or any other string, so `class MyBackend extends BaseLLMBackend { readonly provider = 'my-llm' }` compiles.
- d35ef2a: `PostgresTraceStore.traces()` adapts the store to a `TraceStore`, so it can back `AgentOptimizer`, `DemoSelector` or `TimeTravel` directly. Traces also persist the run's `prompt` (a `prompt` column is added to existing tables on connect).

### Patch Changes

- e70e482: Counterfactuals now evaluate `custom` structural equations: `customFn` is an arithmetic expression over the parent node ids (numbers, `+ - * / ^`, parentheses, `abs exp log sqrt pow min max tanh sigmoid`), parsed without running code, with additive noise like `linear`. Nodes without an equation keep their observed value instead of a random noise sample.
- 1993d56: `getGuardrails()`, `setConstitution()`, `getCostRouter()` and `getCostSummary()` work before the first run. The guardrails are built from `guardrails.model` or `llm.defaultModel` when one is set; a constitution set earlier is applied when the first run builds them.
- 1369ed1: `Agent.deserialize()` accepts the snapshot of an agent without a model (which runs on `llm.defaultModel`); `validateSnapshot()` used to reject it.
- 0bf2e44: `agentAsTool()` no longer reports a paused inner run as a success with empty output: an `onApproval` that answers `'pause'` declines the call (a delegated run cannot wait for a person), and a run that pauses anyway returns `success: false` with the pending tools.
- bc76f42: `builtinTools` is a `Tool[]`, so `new Agent({ tools: builtinTools })` compiles; the readonly tuple it was could not be assigned to `AgentConfig.tools`.
- 1993d56: Config-driven memory now builds every store `memory.adapter` names: `sqlite` (from `memory.sqlite.path`), `mongodb` (from `memory.mongodb.uri`) and `redis` from `host`/`port` or `cluster` as well as `url`. `memory.qdrant` becomes the embedding store that `memory.contextBuilder` searches, and `adapter: 'qdrant'` explains that Qdrant does not store threads instead of logging "Unknown memory provider". A Postgres store gets the vector size of the `memory.embedding` model instead of always `vector(768)`.
- 1993d56: Deliberate run failures are `CogitatorError`s with a code, so server adapters pass their messages on instead of masking them: a run timeout is `RUN_TIMEOUT` (504, new), a budget stop `BUDGET_EXCEEDED` (429, new), a guardrail-blocked input or output `LLM_CONTENT_FILTERED`, and a missing audio API key, an invalid `limits.maxConcurrentRuns` or a cost estimate without a model `CONFIGURATION_ERROR`. Messages are unchanged.
- 1993d56: Guardrail tool approvals fail closed. In `strictMode`, calls of tools with side effects now go through the run's approval flow (`onApproval`, `guardrails.onToolApproval`, or a paused run) instead of running silently when no `onToolApproval` is set, and `ToolGuard` denies a call that needs approval when no handler can give it.
- c117071: Tool cache fixes: `onEvict` also fires for entries evicted to make room (`maxSize`), not only for `invalidate()`. `RedisClientLike` now matches ioredis 5 and 6 (`scan(cursor, 'MATCH', pattern, 'COUNT', count)`), so an ioredis client can be passed as `redisClient`. A Redis `keyPrefix` without a trailing colon gets one, so `withCache` keys read `toolcache:entry:…` instead of `toolcacheentry:…`.
- 1993d56: Tool results that carry a base64 image (`image` or `imageBase64`, such as browser screenshots and generated images) now reach the model as an image instead of a JSON string full of base64. Anthropic, Bedrock, Google, OpenAI Responses and Ollama attach it to the tool result; OpenAI Chat Completions, which takes only text in tool messages, follows the turn's tool messages with one user message holding the images.
- bc76f42: Tool parameters with a Zod `.default()` are no longer sent to the model as required: tool schemas describe the input side, as the WASM tools already did.
- 656499e: `ThoughtTreeExecutor` ignored `ToTConfig.timeout`; only `explore(..., { timeout })` stopped the search. The configured timeout is now the default, and a timeout passed to `explore()` still takes precedence.
- bc76f42: The `vector_search` tool reads the Ollama endpoint from `OLLAMA_URL` too (after `OLLAMA_BASE_URL`, before `OLLAMA_HOST`), as the config loader does. `sql_query` reads `DATABASE_URL` safely where the environment is not readable.
- b8c9eca: The Google backend converts JSON Schema nulls (a Zod `.nullable()` field, or `null` in a `type` array) into Gemini's `nullable: true`, so structured output with nullable fields no longer fails with HTTP 400.
- 9175c69: `AgentOptimizer` now applies `defaultMetrics`, `customMetrics`, `captureTraces` and `traceRetention` from its learning config, and `MetricEvaluator` evaluates metrics added with `registerMetric()` even when they are not in `config.metrics`. `autoOptimize`, `optimizeAfterRuns` and `traceStore` are marked deprecated: use `AutoOptimizer` and the `traceStore` option instead.
- db2e373: Sandbox fallbacks are explicit and safe. `sandbox.allowNativeFallback: false` refuses to run Docker-sandboxed tools on the host when Docker is unavailable (the fallback stays on by default, with a loud warning). WASM tools no longer fall back to Docker or native execution, which failed with "Command array is empty". Every Docker execution now gets a container no code ran in before (a fresh one is kept warm), so files and processes cannot leak between runs or users; `pool.reuseContainers: true` restores reuse.
- 49503b9: Time-travel checkpoints are consistent about the tool call they are anchored on: `messages` stop before that call's result, like `toolResults` (and `createFromTrace` no longer includes the pending step's result). `checkpointAll`, `checkpointEvery` and replay step counts count tool calls only, `divergedAt` and `stepsReplayed` use the same numbering, and a live replay keeps the checkpoint's history when its messages have no system message.
- a36cde4: `ThoughtTreeExecutor` now sends its own model calls the routed model name (not the `provider/model` id) on the backend of the agent's provider, honours `explorationStrategy` (`beam` runs level by level, `best-first` follows the best-scored branch, `dfs` goes deep first) and `maxIterationsPerBranch`, keeps candidates beyond `beamWidth` so a failed branch backtracks to the next best one, and counts the tokens and cost of branch generation, evaluation and synthesis in `usage` and `stats`.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [bb17767]
- Updated dependencies [9175c69]
- Updated dependencies [e7925d5]
- Updated dependencies [4a2925f]
- Updated dependencies [db2e373]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/sandbox@0.5.0

## 0.25.0

### Minor Changes

- e211b6a: `cog.getMemory()` connects the configured memory adapter on first use, so threads can be read before any agent has run; `cog.memory` stays `undefined` until then. The `/threads` routes of every server adapter use it, so they no longer answer `503 Memory not configured` on a fresh server.
- 7482f93: `toolset(...tools)` returns tools as a typed tuple: still an array an agent accepts, but each element keeps its own parameter and result types, so `const [search] = createMyTools()` calls `search.execute` with search's parameters. `createMemoryTools`, `createSchedulerTools` and the browser's `createNavigationTools`, `createInteractionTools`, `createExtractionTools`, `createVisionTools` and `createNetworkTools` use it; before, their elements were a union whose `execute` accepted nothing.

### Patch Changes

- 452a248: A run whose final answer does not fit its `responseFormat` asks the model once more with the validation problem (for example `celsius: expected number, received string`) instead of returning `structured: undefined` straight away; the rejected answer is not saved to the thread. Streamed runs keep the first answer, since the client has already seen it. JSON wrapped in prose is now read as well.
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/sandbox@0.4.4

## 0.24.0

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

### Patch Changes

- a7cb81b: Cogitator runs on Cloudflare Workers and on Deno without extra permissions. Agents no longer draw a random id in their constructor — it is generated on first read — so they can be created at module scope, where Workers forbid random values. The runtime, logger and built-in tools read environment variables through a guard, and only when a feature needs them: a run no longer asks for `OPENAI_API_KEY` unless it has audio, and runtimes without `process` or with env access denied get `undefined` instead of an error. The model price cache in `@cogitator-ai/models` loads the file system lazily and stays in memory where there is none, so importing it no longer reads the home directory. `validateSkill` checks dependencies through `process.getBuiltinModule` and warns where packages cannot be resolved.
- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/models@18.1.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/memory@0.9.1
  - @cogitator-ai/sandbox@0.4.3

## 0.23.0

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

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/sandbox@0.4.2

## 0.22.0

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

- 22f47c9: `AgentOptimizer.compile(agent, trainset)` uses the trainset. It ignored it, scored the same stored traces before and after, and so always reported zero improvement, which also kept `AutoOptimizer` from ever deploying a change. Pass `cogitator` to `AgentOptimizer`: `compile()` runs the trainset with the original agent (scoring it and collecting demo candidates) and again with the optimized instructions, so `scoreAfter` is measured. Without a runner it says so in `errors` and estimates `scoreAfter` from the instruction optimizer. Traces are re-read every round and handed to the instruction optimizer.
- 5b12191: Structured output now works in runs. `agent.config.responseFormat` was never passed to the LLM backend by `cogitator.run()`, so `json` and `json_schema` agents were only as structured as their prompt, and `RunResult.structured` was never set. The format now reaches every backend on both the streaming and non-streaming paths (Zod schemas become JSON Schema, strict only when the schema allows it), and `result.structured` holds the parsed answer, validated by the schema. Agents with tools keep calling them: older Claude models and Gemini 2.x, which cannot combine a JSON format with tools, get the schema as an instruction instead. `Agent.serialize()` keeps `responseFormat`.
- f36a121: Time travel works end to end.

  - `compare()` and `compareWithOriginal()` failed with `Trace not found` because nothing wrote to the trace store. Checkpoints, replays and forks now store their traces; a deterministic replay's trace is the original's up to the replayed step.
  - `mockToolResults` (forks) and `modifiedToolResults` (replays) are keyed by tool name, as documented: the tool answers with the given value and never runs. Before, live replays looked them up by call id and never matched. In deterministic replays a modified result now wins over the cached one.
  - `skipTools` removes the tools from the replayed agent; it did nothing before.
  - Checkpoints record the results of tool calls (`toolResults` was always empty) and pick the pending call by call id.
  - `AgentOptimizer.captureTrace()` stores traces under the run's trace id, so it can share a trace store with `TimeTravel`.

### Patch Changes

- 480f2a3: Context management turns on when `context` is configured. The runtime created the context manager only with `enabled: true`, although `enabled` defaults to true and the documented strategy examples leave it out, so those configs silently never compressed anything. Pass `enabled: false` to keep a config switched off.
- 51d581e: OTLP exporter: send valid OpenTelemetry ids. Span ids went out as `span_…` and trace ids as `trace_…` whenever `onRunStart` had not mapped the run, so collectors refused the batch with 400, and the exporter re-queued it forever. Ids are now derived from the Cogitator ids with SHA-256 (32 hex chars per trace, 16 per span), which keeps parent links and works after a run ends; the original ids and the run id are kept as attributes. Attributes keep their types (doubles, booleans, objects as JSON), timestamps are exact, and a batch refused with a 4xx status is dropped instead of retried.
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/memory@0.8.1
  - @cogitator-ai/sandbox@0.4.1

## 0.21.1

### Patch Changes

- 4940750: Google backend: send tool results that are JSON arrays or plain values as `{ result: … }`. Gemini expects `functionResponse.response` to be an object and rejected an array with `400 Proto field is not repeating`, so any tool that returned a list broke the run.

## 0.21.0

### Minor Changes

- The official OpenAI backend uses the Responses API and defaults to `gpt-6.1-sol`; OpenAI-compatible providers stay on Chat Completions (`api: 'responses' | 'chat-completions'` forces either). Encrypted reasoning items are round-tripped between tool calls; reasoning models get no temperature/top_p.
- Anthropic and Bedrock: current Claude models no longer fail with HTTP 400 on the default temperature (sampling params are omitted on Claude 4.7+/Fable, at most one of temperature/top_p on other 4.x); native structured outputs on Claude 4.5+; forced tool choice falls back to auto on models that reject it; default Anthropic model `claude-sonnet-5-5`; more precise stop reasons.
- Retired model ids replaced with current ones (GPT-6, Claude 5.5, Gemini 3.8 / 3.5 Flash-Lite); context windows for GPT-5/6, Claude 5 and Gemini 3.
- **Breaking:** `image-generate` uses `gpt-image-2.5-flare` (DALL-E 3 is retired): results carry `imageBase64`, `url` is optional, default size/quality are `auto` (`config.model` keeps the DALL-E request shape). Transcription defaults to `gpt-transcribe` (`whisper-1` when word timestamps are requested); TTS defaults to `gpt-4o-mini-tts`.
- Errors rethrown from catch blocks keep the original error as `cause`.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/models@18.0.0
  - @cogitator-ai/sandbox@0.4.0
  - @cogitator-ai/types@0.24.0

## 0.20.0

### Minor Changes

- Re-audit of @cogitator-ai/core (+ @cogitator-ai/types). The most important fixes: (1) the first sandboxed tool call of a Cogitator instance ran natively on the host because the executor captured a stale undefined sandbox manager, a security bug; (2) Tool.timeout is now enforced for native tools; (3) trace spans were orphaned because the root span id did not match the children's parentId; (4) tool-call structure is kept intact across runtime, memory, compression and providers: duplicate-call errors are persisted, reflection hints are deferred, and loaded or compressed history is cleaned of orphaned tool results and unanswered calls; (5) RunOptions.audio was documented but silently ignored and is now implemented via Whisper; (6) reflection, guardrails, the LLM injection classifier and cost routing sent provider-prefixed or wrong model ids; (7) backends: Gemini 3 thought signatures are now round-tripped, a new ToolCall.thoughtSignature field was added in types, and the 400 it caused was confirmed with a real API call; system prompts are no longer overwritten for Anthropic, Gemini and Bedrock; parallel tool results are grouped into one turn; OpenAI uses max_completion_tokens; empty tool arguments are handled; Ollama error lines and blocked Gemini prompts are reported; stream errors are wrapped; (8) tools: Postgres read-only queries run in a READ ONLY transaction; SQLite mutations work; Google and Tavily keys are moved out of the URL and body; the deprecated embedding default is fixed; the Redis tool-cache size counter no longer drifts; the HTTP tool handles HEAD requests; self-tools updates are atomic. Docs: invalid @cogitator-ai/core/\* subpath imports were fixed across the advanced docs. Report: docs/audits/core-audit.md (previous report kept as core-audit-2026-05-15.md).

  **Breaking changes**
  - OpenAIBackend against the official endpoint (no baseUrl) now sends maxTokens as max_completion_tokens instead of max_tokens (custom baseUrl and compatible providers unchanged).
  - vector_search Google default embedding model changed from shut-down text-embedding-004 (768 dims) to gemini-embedding-001 (matches @cogitator-ai/memory); pgvector column dimension must match.
  - When security.promptInjection.classifier='llm' is configured through Cogitator without llmModel, the classifier now uses the agent's model instead of a bare 'gpt-4o-mini' on the default provider.
  - Internal (not exported from package root): executeTool/initializeSandbox now take/return SandboxManager | undefined; initializeSecurity takes the agent.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/sandbox@0.3.0
  - @cogitator-ai/types@0.23.0

## 0.19.4

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

- Updated dependencies
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/sandbox@0.2.29

## 0.19.3

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/memory@0.6.21
  - @cogitator-ai/sandbox@0.2.28

## 0.19.2

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.
- Updated dependencies
  - @cogitator-ai/models@17.1.8
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/memory@0.6.20
  - @cogitator-ai/sandbox@0.2.27

## 0.19.1

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

- Updated dependencies
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/memory@0.6.19
  - @cogitator-ai/sandbox@0.2.26

## 0.18.7

### Patch Changes

- Fix Ollama Cloud tool calling compatibility
  - Preserve tool call IDs returned by Ollama Cloud API instead of generating new ones
  - Include tool_calls on assistant messages when converting conversation history
  - Preserve toolCalls on assistant messages in runtime for multi-turn tool calling

## 0.18.6

### Patch Changes

- fix(core): audit — 37 bugs fixed, +71 regression tests, v0.18.6

  Critical fixes:
  - Streaming tool calls: accumulate/merge by ID instead of overwriting
  - SQL injection prevention in vector-search collection name validation
  - Security evaluator fail-closed on parse errors (was fail-open)
  - Tool guard strict mode logic was inverted
  - pruneTraces deleted newest instead of oldest
  - incompleteBeta overflow for large samples
  - Abort listener memory leak in retry utility
  - Multiple unbounded growth issues capped (OTLP spans, cost records, reflections)
  - Tool error messages now include actual error content for LLM
  - ContentPart[] handling in message builder, forker
  - Causal polynomial evaluation and sampleGaussian NaN guard
  - LLM backend silent error swallowing (Anthropic, Google, Bedrock)
  - Agent clone() no longer duplicates explicit ID

  71 new regression tests covering all fixed bugs.
  5 new test files: streaming, message-builder, tool-executor, opentelemetry, retry.

## 0.18.5

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

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/memory@0.6.17
  - @cogitator-ai/sandbox@0.2.25

## 0.18.4

### Patch Changes

- @cogitator-ai/memory@0.6.16

## 0.18.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/models@17.1.6

## 0.18.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.14
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/models@17.1.5
  - @cogitator-ai/sandbox@0.2.24

## 0.18.1

### Patch Changes

- fix(core): audit — 37 bugs & security fixes, +78 tests
  - Fix runtime infinite loop on empty toolCalls
  - Fix multimodal content corruption in message builder
  - Fix empty choices crash in OpenAI/Azure backends
  - Fix temperature=0 / maxTokens=0 ignored in Bedrock
  - Fix streaming JSON parse in Ollama
  - Move Google API key from URL to header
  - Fix LOG_LEVEL validation, tool executor using raw args
  - Fix web-search, github, calculator edge cases
  - Fix fallback crash on empty providers
  - Fix SQLite readonly mode, detection
  - Fix constitutional prompts content handling
  - Fix unsafe casts in rollback manager, thought tree
  - Fix metrics fieldPath drilling (nested paths broken)
  - Fix auto-optimizer using stale test reference
  - Fix causal reasoner wrong agentId extraction
  - Fix langfuse integration (generations/spans non-functional)
  - Fix Google image_url data URI mapping
  - Remove dead code (pendingToolResults, audio transcription)
  - Fix patterns.ts duplicate match indexing
  - Security: SQL injection prevention in sql-query + postgres-trace-store
  - Security: ReDoS protection in regex tools
  - Security: prompt injection fail-closed, allowlist exact-match
  - Security: second-order injection escape in LLM classifier
  - Add public getLLMBackend() and reflectionEngine to Cogitator
  - Add getTest(id) to ABTestingFramework
  - Add 78 new unit tests (rollback, ab-testing, langfuse, metrics, security)

## 0.18.0

### Minor Changes

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

### Patch Changes

- Fix ESM directory import conflicts, streaming content handling, and integration test stability
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/memory@0.6.13
  - @cogitator-ai/models@17.1.4
  - @cogitator-ai/sandbox@0.2.23

## 0.17.4

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/memory@0.6.11
  - @cogitator-ai/models@17.1.2
  - @cogitator-ai/sandbox@0.2.21

## 0.17.3

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/memory@0.6.10
  - @cogitator-ai/models@17.1.1
  - @cogitator-ai/sandbox@0.2.20

## 0.17.2

### Patch Changes

- Update model registry to January 2026 models
  - Add Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
  - Add GPT-4.1, GPT-4.1 Mini/Nano, o3, o4-mini
  - Add Gemini 3 Pro/Flash Preview, Gemini 2.5 Pro/Flash/Flash-Lite
  - Mark deprecated models (Claude 3.x, GPT-4 Turbo, Gemini 1.5/2.0)
  - Fix model selector and cost estimator for new models
  - Export all 26 built-in tools from @cogitator-ai/core

- Updated dependencies
  - @cogitator-ai/models@17.1.0

## 0.17.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/memory@0.6.9
  - @cogitator-ai/models@17.0.0
  - @cogitator-ai/sandbox@0.2.19

## 0.17.0

### Minor Changes

- Add long-context optimization with automatic compression strategies

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/memory@0.6.8
  - @cogitator-ai/models@16.0.0
  - @cogitator-ai/sandbox@0.2.18

## 0.16.0

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

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/memory@0.6.7
  - @cogitator-ai/models@15.0.0
  - @cogitator-ai/sandbox@0.2.17

## 0.15.0

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

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/memory@0.6.6
  - @cogitator-ai/models@14.0.0
  - @cogitator-ai/sandbox@0.2.16

## 0.14.0

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

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/memory@0.6.5
  - @cogitator-ai/models@13.0.0
  - @cogitator-ai/sandbox@0.2.15

## 0.13.0

### Minor Changes

- feat(security): implement prompt injection detection

  Add PromptInjectionDetector to protect agents from adversarial inputs:
  - Local classifier: fast regex + heuristics (<5ms latency)
  - LLM classifier: semantic analysis for complex attacks
  - 30+ built-in patterns for 5 threat types (direct injection, jailbreak, roleplay, context manipulation, encoding)
  - Allowlist support for false positive prevention
  - Custom pattern support with runtime add/remove
  - Integration with Cogitator via security.promptInjection config

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/memory@0.6.4
  - @cogitator-ai/models@12.0.0
  - @cogitator-ai/sandbox@0.2.14

## 0.12.0

### Minor Changes

- feat(core): implement tool caching layer with semantic matching
  - Add withCache() wrapper for caching tool execution results
  - Support exact match (SHA256 hash) and semantic (embedding similarity) caching
  - InMemoryToolCacheStorage with LRU eviction
  - RedisToolCacheStorage with TTL and sorted sets
  - Cache stats, invalidation, warmup, and callbacks

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/memory@0.6.3
  - @cogitator-ai/models@11.0.0
  - @cogitator-ai/sandbox@0.2.13

## 0.11.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.2

## 0.11.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/memory@0.6.1
  - @cogitator-ai/models@10.0.0
  - @cogitator-ai/sandbox@0.2.12

## 0.11.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/memory@0.6.0
  - @cogitator-ai/models@9.0.0
  - @cogitator-ai/sandbox@0.2.11

## 0.11.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/memory@0.5.2
  - @cogitator-ai/models@8.0.1
  - @cogitator-ai/sandbox@0.2.10

## 0.11.1

### Patch Changes

- Updated dependencies [abdafa3]
  - @cogitator-ai/sandbox@0.2.9

## 0.11.0

### Minor Changes

- DX Improvements - Phases 1-3

  Phase 1: Foundation
  - Added comprehensive JSDoc documentation to core public APIs
  - Extended config schema with memory, sandbox, reflection, guardrails, costRouting, logging

  Phase 2: Critical Fixes
  - ThreadManager: Added persistent storage with InMemoryThreadStorage, RedisThreadStorage, PostgresThreadStorage
  - SSE Streaming: EventEmitter-based real-time streaming for openai-compat
  - MCP Retry: Exponential backoff with auto-reconnect and connection recovery

  Phase 3: Polish
  - New examples: memory-persistence, openai-compat-server, mcp-integration, constitutional-guardrails

## 0.10.0

### Minor Changes

- 58a7271: Phase 6: DX Improvements
  - Add structured LLM errors with rich context (provider, model, endpoint, statusCode, retryable, retryAfter)
  - Add debug mode wrapper with request/response logging
  - Add type-safe provider configurations with discriminated unions
  - Add plugin system for registering custom LLM backends

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/memory@0.5.1
  - @cogitator-ai/models@8.0.0
  - @cogitator-ai/sandbox@0.2.8

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

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/memory@0.5.0
  - @cogitator-ai/models@7.0.0
  - @cogitator-ai/sandbox@0.2.7

## 0.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/memory@0.4.3
  - @cogitator-ai/models@6.0.1
  - @cogitator-ai/sandbox@0.2.6

## 0.7.0

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

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/memory@0.4.2
  - @cogitator-ai/models@6.0.0
  - @cogitator-ai/sandbox@0.2.5

## 0.6.1

### Patch Changes

- 29ce518: fix(core): preserve full model name when explicit provider is set

## 0.6.0

### Minor Changes

- a7c2b43: feat(core): add explicit provider override in AgentConfig

  Allows specifying provider directly in AgentConfig (e.g., 'openai' for OpenRouter) instead of relying only on model string parsing.

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/memory@0.4.1
  - @cogitator-ai/models@5.0.0
  - @cogitator-ai/sandbox@0.2.4

## 0.5.0

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

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/memory@0.4.0
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/models@4.0.0
  - @cogitator-ai/sandbox@0.2.3

## 0.4.0

### Minor Changes

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

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/memory@0.3.1
  - @cogitator-ai/models@3.0.0
  - @cogitator-ai/sandbox@0.2.2

## 0.3.0

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

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/memory@0.3.0
  - @cogitator-ai/models@2.0.0
  - @cogitator-ai/sandbox@0.2.1

## 0.2.0

### Minor Changes

- **Timeout enforcement**: Agent timeout config now properly enforced using AbortController
- **Tool input validation**: Tool arguments validated with Zod before execution
- **Memory error callback**: Added `onMemoryError` callback to `RunOptions` for handling memory failures
- **Tool categories**: Tools now support `category` and `tags` fields for organization

### Improvements

- Abort signal now passed to tool context for graceful cancellation
- Better error messages for invalid tool arguments

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/memory@0.1.1
  - @cogitator-ai/models@1.0.0
  - @cogitator-ai/sandbox@0.1.1
