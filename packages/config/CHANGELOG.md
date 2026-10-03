# @cogitator-ai/config

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
