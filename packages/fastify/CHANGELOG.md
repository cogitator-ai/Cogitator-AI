# @cogitator-ai/fastify

## 0.6.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0

## 0.6.1

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/server-shared@0.4.1
  - @cogitator-ai/types@0.31.0

## 0.6.0

### Minor Changes

- [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f) - The `usage` of a run answer now includes `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, like Tetsu and Next, and `AgentRunResponseSchema` lists them.

  SSE streams now write a `: keep-alive` comment every 5 seconds while a run is silent, so proxies and load balancers do not close a stream that waits on a slow tool or model. Set it with the new `sseHeartbeatMs` option (also on `FastifyStreamWriter`), `0` turns it off.

  The run request schemas now take the `input` rule from `@cogitator-ai/server-shared`, so Fastify keeps refusing exactly the bodies every other adapter refuses.

### Patch Changes

- [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9) - The `finish` event of an agent stream now carries the same `usage` as `POST /agents/:name/run`: `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` are included when the model reported them. Before, the stream sent only the input, output and total tokens, so a streaming client lost the reasoning and cache counts.
- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9), [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/server-shared@0.4.0

## 0.5.4

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2

## 0.5.3

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1

## 0.5.2

### Patch Changes

- 87951bf: A failing memory adapter no longer reaches the client through the Express and Fastify thread routes: the error is logged and answered as `500 Internal server error`, as Hono and Koa already did. Every unexpected error, whether caught by a route, a stream or the error handler, now carries the same code, `INTERNAL_ERROR` (routes and streams used `INTERNAL` before).
- 65d0cc0: Swagger UI calls the right URLs and offers a bearer token when the server checks credentials. The spec's `servers` now defaults to where the routes are mounted (Express `basePath`, the Hono/Koa mount prefix), and with `auth` configured the spec declares `bearerAuth` as an optional requirement (`swagger.auth` overrides it). The Swagger page escapes the title and the embedded spec, so agent names and descriptions can't inject markup.
- b6b1480: WebSocket `subscribe` channels no longer leak runs across users. A subscriber to `agent:<name>` now receives only the events of runs started by the same `userId` (as returned by `auth`) on other connections; before, any authenticated client could watch every user's prompts, tool calls and results. Servers without `auth` behave as before.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [65d0cc0]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/server-shared@0.3.1

## 0.5.1

### Patch Changes

- e211b6a: `cog.getMemory()` connects the configured memory adapter on first use, so threads can be read before any agent has run; `cog.memory` stays `undefined` until then. The `/threads` routes of every server adapter use it, so they no longer answer `503 Memory not configured` on a fresh server.
- 3e756f3: Errors that are not a `CogitatorError` no longer reach the client with their text, which can carry internals such as connection strings or file paths. They are logged on the server and answered as `Internal server error` everywhere: the Next.js agent, chat and resume handlers (now with `code: 'INTERNAL_ERROR'`), WebSocket run errors in Express and Fastify, `Workflow failed: …` responses, and the `node_error` / `agent_error` stream events of workflows and swarms in every adapter. A `CogitatorError` keeps its message and code.
- Updated dependencies [e211b6a]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/types@0.28.0

## 0.5.0

### Minor Changes

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

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/server-shared@0.3.0

## 0.4.0

### Minor Changes

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
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/server-shared@0.2.1

## 0.3.2

### Patch Changes

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0

## 0.3.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1

## 0.3.0

### Minor Changes

- Optional `@fastify/rate-limit` and `@fastify/swagger-ui` ranges accept 10 or 11 and 5 or 6; fastify-plugin 6.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/server-shared@0.2.0
  - @cogitator-ai/types@0.24.0

## 0.2.1

## 0.2.0

### Minor Changes

- SSE streams had the same truncation bug as express: request.raw.on('close') fires once the body is parsed. The routes now use reply.raw close guarded by writableEnded, and a disconnect aborts the run, workflow or swarm. Raw SSE writes never called reply.hijack(), and writeHead dropped headers set by hooks (CORS, rate-limit). The writer now hijacks the reply, merges reply.getHeaders(), and does nothing on close() before start(). The plugin's error handler turned schema-validation errors, malformed JSON and @fastify/rate-limit 429s into 500. They are now 400 INVALID_INPUT with details, or keep their 4xx status. Workflow failures were reported as success. CogitatorError codes always became 500. Tool-call ids did not match tool results. Exported schemas were tightened: non-blank input, workflow options limited to known keys, timeout > 0, non-empty content. Thread metadata was dropped. The agent list leaked system prompts. A rejected WebSocket upgrade leaked its socket and blocked fastify.close(), because the auth onRequest hook was added before @fastify/websocket's own hook. On WebSocket, 'stop' was a no-op and subscriptions were dead code (now an agent:<name> channel hub), and messages were not validated. The docs sample used eval() and an invalid config. The example ran new Function on model output; fixed.

  **Breaking changes**
  - Exported AgentRunRequestSchema and SwarmRunRequestSchema require a non-blank input; SwarmRunRequestSchema needs timeout > 0; WorkflowRunRequestSchema.options sets additionalProperties: false and requires integers >= 1; AddMessageRequestSchema content needs minLength 1
  - Validation errors, malformed JSON and rate-limited requests now return 400/429 (previously 500)
  - GET /agents returns agent.config.description instead of the first 100 characters of the instructions
  - Workflow runs that fail now return 500 WORKFLOW_FAILED (and the stream sends an error event) instead of success
  - CogitatorError codes now map to their own HTTP status in routes

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.1.15

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
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 0.1.14

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.1.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.1.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.1.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.1.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.1.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.1.8

## 0.1.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.1.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.1.4

### Patch Changes

- fix(fastify): audit — 8 bugs fixed, +50 tests, remove unused options
  - plugin.ts: register swagger before routes (was producing empty spec); re-throw non-MODULE_NOT_FOUND errors from optional module loading
  - auth.ts: log auth errors via request.log.warn; add reply.sent guard before 401
  - error-handler.ts: use request.log.error instead of console.error
  - agents.ts: fix SSE stream protocol — emit text-end in catch block
  - threads.ts: fix timestamps (use MemoryEntry.createdAt), fix error fallback with ??
  - swarms.ts: fix ERR_MODULE_NOT_FOUND detection via error.code
  - tools.ts: use tool.toJSON().parameters instead of unsafe ZodType cast
  - workflows.ts: destructure run options to prevent overriding server callbacks
  - fastify-stream-writer.ts: finish() now respects closed guard; setupHeaders private; toolCallDelta skips empty strings
  - websocket/handler.ts: reject concurrent runs; proper payload validation; handle unsupported run types; clear abortController in finally; cap subscriptions at 64
  - types.ts: remove requestTimeout (never applied) and unused WebSocket fields
  - Add 50 unit tests across 5 test files

## 0.1.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
