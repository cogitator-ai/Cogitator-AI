# @cogitator-ai/config

## 0.12.2

### Patch Changes

- [#144](https://github.com/cogitator-ai/Cogitator-AI/pull/144) [`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198) - Prompt caching for Claude shares the system prompt between runs and reaches Claude through OpenRouter.

  Anthropic requests now mark the end of the agent's instructions at the start of the system prompt, so runs with different input, such as single-turn runs that share only their instructions, read those from the cache instead of writing them again. The top-level mark on the end of the conversation is set only when another turn is likely (the request offers tools or continues earlier turns), since a single turn with unique input only paid the cache write premium on it. `llm.promptCache.conversation` overrides that choice, and `ChatRequest.cachePrefix` names the stable start of a request's system prompt.

  An `OpenAIBackend` for OpenRouter (`provider: 'openrouter'` or an `openrouter.ai` base URL) marks `anthropic/*` models the same way, where before it sent no marks and Claude never cached. Its usage reports OpenRouter's `cache_write_tokens` as `cacheWriteTokens`. Other OpenAI-compatible servers and models are left unmarked.

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.12.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.12.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Bedrock works with temporary AWS credentials again. `loadConfig` no longer copies `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` into `llm.providers.bedrock`, where they replaced the SDK credential chain without the session token and STS, SSO or CI role credentials failed with `UnrecognizedClientException`. The AWS SDK now resolves them itself, together with `AWS_SESSION_TOKEN` and `AWS_PROFILE`. Static credentials come only from `COGITATOR_BEDROCK_*` or `llm.providers.bedrock`, which gains `sessionToken` and `profile` (also `COGITATOR_BEDROCK_SESSION_TOKEN` and `COGITATOR_BEDROCK_PROFILE`), and `BedrockBackend` sends them to the SDK.

  `PROVIDER_ENV` in `@cogitator-ai/config` lists the environment of every built-in provider, and `resolveModelRoute()` in `@cogitator-ai/types` is the one rule for which provider a model string runs on, used by the runtime and by `cogitator deploy`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `cogitator deploy` tells servers from workers. `deploy.kind` is `server` (answers HTTP, gets a health check, may scale to zero on Fly) or `worker` (a channel gateway or queue worker: no health check, a port only when one is set, never stopped by the Fly proxy), detected from the project's dependencies. A project that is neither, such as a script that exits after one call, fails preflight instead of being restarted forever. Tetsu and Next.js join the detected servers, with `/health` as the Tetsu health path, and a server whose health path is unknown gets no failing health check.

  Preflight now starts with project checks every target shares: a missing `package.json` (a `cogitator wizard` assistant runs with `cogitator up`), an unknown project kind, a `start` script that loads `.env` with `--env-file` (the file stays out of the image, use `--env-file-if-exists`), and a project whose `.env` holds variables while no secrets were detected. On Docker, a deploy only succeeds when the app container keeps running for a few seconds after it starts, otherwise it fails with the container's last log lines.

  A SQLite memory keeps its database directory on a Docker named volume or a Fly volume (`deploy.volumes`, created on the first Fly deploy), and the directory stays out of the image. A local Ollama on the docker target is reached on the host through `host.docker.internal` (`deploy.hostGateway`). On Fly, Redis and Postgres are no longer silently dropped: `REDIS_URL` and `DATABASE_URL` become required secrets.

  Secrets follow the runtime: the provider is resolved the way the runtime routes the model (`meta-llama/...` on Together needs `TOGETHER_API_KEY`), Azure needs its endpoint, Bedrock a region, an alias such as `GEMINI_API_KEY` is passed when it is the one set, and values written in `llm.providers` count as provided. Names passed to `requireEnv('NAME')` in `src/` and set variables of `.env.example` are detected too.

  The Dockerfile copies `pnpm-workspace.yaml`, `.npmrc`, `patches/` and the other files the install step reads before it runs, so pnpm's `allowBuilds`, overrides, patches and private registries apply in the image. Yarn Berry installs with `--immutable` (and `workspaces focus` for production on Yarn 4), and Bun projects build on `oven/bun:1-alpine` and start with `bun run start`.

  `DeployOptions` gains `configPath` (the file `cogitator deploy -c` passes, read for the model, memory and deploy section alike) and `env`, `status` and `destroy` take `{ configPath }`, and `PackageManager` gains `yarn-berry` and `bun`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `OLLAMA_HOST`, `OLLAMA_URL` and the new `OLLAMA_BASE_URL` are read the way Ollama reads `OLLAMA_HOST`. `OLLAMA_HOST=0.0.0.0`, set so `ollama serve` listens on every interface, used to send every call to port 80 and fail with `ECONNREFUSED`. Now a value without a scheme gets port 11434 and a wildcard address is reached as `localhost`, in `loadConfig` and in the CLI alike (`resolveOllamaHost()`). These variables also no longer replace an explicit `llm.providers.ollama.baseUrl` from cogitator.yml, they apply only when the file sets none (`loadEnvDefaults()`), while `COGITATOR_OLLAMA_BASE_URL` still overrides it. `loadEnvConfig()` therefore no longer returns them.

  `loadConfig` looks for `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml` and `.cogitator.yaml` in that order, the same order `cogitator run` and `cogitator deploy` use (`findConfigFile()`).

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` checks the vector size of an existing `embeddings` table on `connect()`. An adapter without a configured size adopts it, and one configured for another size (after switching the embedding model) reports the mismatch through `vectorStatus()` and a clear failure from `addEmbedding` and `search` instead of a Postgres error on each search. The size can now be set with `dimensions` in `PostgresAdapterConfig` and `memory.postgres.dimensions`, as well as `setVectorDimensions()`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` connects to Postgres without pgvector. Before, the `CREATE TABLE ... vector(N)` that followed a failed `CREATE EXTENSION` failed `connect()`, so memory was off entirely even for users who only need threads. Threads, entries and facts now work on any Postgres, embedding operations return a failed result naming the reason, and the new `vectorStatus()` tells whether vectors are usable. The runtime does not use such a store for semantic context and logs why.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Reasoning models get the parameters they accept on Chat Completions too. `azure/gpt-5` with `maxTokens` sent `{ temperature: 0.7, max_tokens: 500 }` and Azure rejected every call, and `openai/gpt-5` with stop sequences or `api: 'chat-completions'` sent the agent's default temperature. Reasoning models (o-series, GPT-5 and later) now get no `temperature` / `top_p` and their limit as `max_completion_tokens`. Azure tells them by the deployment name or by the new `providers.azure.model` when the name is your own, and its default `apiVersion` is now `2025-04-01-preview`, the first that serves these models.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0

## 0.11.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 0.11.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 0.11.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 0.11.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/types@0.33.1

## 0.11.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 0.11.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 0.11.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.11.0

### Minor Changes

- 8bcf914: The config schema silently dropped runtime options it did not know. YAML and `defineConfig` now keep `sandbox.allowNativeFallback`, `sandbox.pool.reuseContainers`, sandbox `defaults` mounts/env/WASM fields, embedding `dimensions` (and the Google `baseUrl`), every `contextBuilder.graphContextOptions` field, prompt injection `patterns` and `failMode`, `guardrails.constitution`, `llm.plugins` and `prompts.autoDeployWinner`.

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0

## 0.10.1

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.10.0

### Minor Changes

- 0933009: Personal data stays away from the model provider. `security.pii` replaces emails, phone numbers, card numbers (Luhn-checked), IBANs (mod-97), SSNs, IP addresses, API keys and your own patterns with placeholders such as `[EMAIL_1]` in every LLM request. In `mask` mode the answer, its stream and tool call arguments get the real values back, so tools still act on the real address; `redact` keeps the placeholders everywhere, and `block` rejects such input with `PII_DETECTED`. `onDetect` receives counts per kind for audit logs, never the values. `PiiMasker`, `PiiVault` and `withPiiMasking` are exported for use outside a run, and YAML config accepts custom patterns as strings.
- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.9.0

### Minor Changes

- 9ff5a06: Agent runs retry failed LLM calls instead of failing on the first 429 or 5xx.

  - New `llm.retry` (`maxRetries` 2, `baseDelay` 1000, `maxDelay` 30000, `maxRetryAfter` 60000, `onRetry`; `false` turns it off) applies to every backend the runtime uses, `llm.backends` and plugins included. Only retryable errors are retried: rate limits, 5xx, timeouts, dropped connections.
  - A provider's wait is honoured: `retry-after`, `retry-after-ms`, an HTTP date or Gemini's `RetryInfo.retryDelay`. A wait longer than `maxRetryAfter` fails the call at once.
  - Streams are retried only before their first chunk; the run's timeout and abort signal stop the waits.
  - `withLLMRetry(backend, config)` / `RetryingBackend` give a standalone backend the same behaviour; `retryAfterFromHeaders` is exported.

  **Behaviour changes:** backends created by `createLLMBackend` no longer retry inside the OpenAI, Anthropic, Azure and Bedrock SDKs (new `maxRetries` backend option, the runtime passes 0), so attempts never multiply — wrap such a backend with `withLLMRetry` when using it on its own. `LLMError.retryAfter` now holds only a wait the provider asked for; it is `undefined` instead of an invented 60 s (429), 5 s (5xx) or 1 s otherwise. `cogitator.route()` returns the retrying wrapper unless `llm.retry` is `false`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.8.0

### Minor Changes

- f134b01: Config keys that did nothing now either work or are gone.

  - `reflection.reflectAfterError` works: a failed tool call gets the error reflection (`ReflectionEngine.reflectOnError`), and its suggestion reaches the next model call.
  - `TimeTravelConfig.maxCheckpointsPerTrace` and `checkpointRetention` are enforced when `TimeTravel` saves checkpoints.

  **Breaking (types):** removed keys nothing read — `CogitatorConfig.knowledgeGraph` and `promptOptimization` (the knowledge-graph and prompt-optimization classes keep their own config types), `ContextManagerConfig.windowOverlap`, `TimeTravelConfig.autoCheckpoint` / `autoCheckpointInterval`, `ReplayOptions.onStep` / `pauseAt`, and `CompileOptions.teacherModel` / `verbose`. The YAML schema drops the same keys.

- c1cd7a1: Guardrails take partial configs and keep the revisions they produce.

  - `CogitatorConfig.guardrails` and `security.promptInjection` are `Partial<…>`: fields left out take the defaults, as the runtime always merged them. The YAML schema accepts partial blocks too (`thresholds` may name some categories).
  - Guardrails are on when configured, unless `enabled: false`, matching `DEFAULT_GUARDRAIL_CONFIG`. The run checks the merged config: a partial config such as `{ enabled: true }` filtered nothing before.
  - When the output filter blocked an answer and the critique-revise loop produced a safe one, `filterOutput()` returned `allowed: true` with the revision, so the run kept the original harmful text and the violation was never logged. It now returns the block with `suggestedRevision`, the run answers with the revision, and the violation reaches the log and `onViolation`.
  - `filterToolResults` is implemented: tool results pass the input filter before the model reads them (`ConstitutionalAI.filterToolResult()`).

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.7.0

### Minor Changes

- `providers.openai.api` (`responses` | `chat-completions`) is accepted in YAML config.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 0.6.0

### Minor Changes

- The documented `${VAR}` references in cogitator.yml were never interpolated: a literal '${OPENAI_API_KEY}' was sent as the API key. ${VAR}, ${VAR:-default}, ${VAR-default} and $$ are now implemented and exported. OLLAMA_API_KEY in the environment overrode a YAML Ollama baseUrl with https://ollama.com; the schema now applies the Ollama default after merging. OLLAMA_URL is now supported, OLLAMA_HOST without a scheme is normalised, and GEMINI_API_KEY is accepted as a Google alias. YAML whose top level is not a mapping was merged as garbage; it now fails with the file path. Prototype keys are skipped during merge. Validation errors are formatted with z.prettifyError. Port and integer fields are validated. The DeployTarget enum is narrowed to docker|fly. Added a shared parseDotenv/loadDotenvFile, now used by the CLI and deploy; a round-trip test caught an escaped-quote bug in it, now fixed. Removed the bogus typescript peerDependency. Fixed an env-dependent flaky test.

  **Breaking changes**
  - The env layer no longer sets the Ollama baseUrl when only OLLAMA_API_KEY is set. The default is applied after merging, so a YAML baseUrl now wins (previously env forced https://ollama.com).
  - ProvidersConfigSchema.ollama input `baseUrl` is now optional; output still always has baseUrl.
  - DeployTargetSchema is narrowed to 'docker' | 'fly'.
  - deploy.port must be an integer in 1-65535. instances, maxConcurrentRuns and maxTokensPerRun must be integers.
  - YAML strings containing `${...}` or `$$` are now interpolated.
  - loadYamlConfig throws for non-mapping files and includes the path in parse errors.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 0.5.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.5.5

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.5.4

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.
- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.5.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.5.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.4.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.3.13

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.3.12

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.3.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.3.8

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.3.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 0.3.4

### Patch Changes

- docs: sync package READMEs with main documentation

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 0.3.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 0.3.0

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

## 0.2.8

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 0.2.5

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 0.2.0

### Minor Changes

- Add YAML loader tests (file not found, parsing, default paths)
- Add config merge tests (priority order, deep merge, validation)
- Fix unsafe type cast for LLM provider validation
- Fix parseInt edge case (stricter number parsing with regex)

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
