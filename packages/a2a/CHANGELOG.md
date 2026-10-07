# @cogitator-ai/a2a

## 0.8.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `message/stream` responses write a `: keep-alive` comment every `sseHeartbeatMs` (a new `A2AServer` option, 5 seconds by default, `0` turns it off) while the run is silent, so a proxy or Bun's idle timeout no longer cuts a run that waits on a slow tool. The Hono adapter now streams through the same code as the other adapters.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A task whose agent run pauses for tool approvals now waits in `input-required` instead of reporting `completed` with the model's text from before the tool call. The agent's message carries the waiting calls in a `tool-approval-request` data part, and the client answers with a `tool-approval-response` data part (`client.answerApprovals(taskId, { decisions })` or `toolApprovalResponsePart()`), which resumes the run through the server Cogitator's `resume()`. `readToolApprovalRequest(task)` reads the waiting calls, and `asTool()` reports them in `pendingApprovals`. `CogitatorLike` gains an optional `resume`, and `AgentRunResult` the `status` and `pendingApprovals` fields.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `A2AServer` and `A2AClient` now speak the A2A protocol v0.3 as specified, so they work with the official A2A SDKs, Google ADK and other v0.3 agents. Every response is checked against the official v0.3.0 JSON schema in the tests, and the official JavaScript SDK client talks to `A2AServer` (and `A2AClient` to an SDK server) in them.

  Breaking changes to the wire format and the API:

  - Parts, messages, tasks and stream events use `kind`. Messages need a `messageId` (`A2AClient` fills it in), file parts nest the file (`{ kind: 'file', file: { uri | bytes } }`), artifacts have `artifactId`, and `status.message` is an agent message instead of a string (`messageText()` reads it). `errorDetails` is gone.
  - Streams send every event as a JSON-RPC response with the request id, start with the task, mark the last status update `final: true` and have no `[DONE]` marker. The reply streams as `artifact-update` chunks (`append`, `lastChunk`) instead of `token` events. A request that fails before the stream starts is answered with a plain JSON-RPC error, and `tasks/resubscribe` reconnects to a running task.
  - The Agent Card is served at `/.well-known/agent-card.json` (the old path stays as an alias) with `protocolVersion`, `preferredTransport`, an absolute `url`, skill `tags`, spec security schemes (`in`, `name`) and `supportsAuthenticatedExtendedCard`. `version` is now the agent version (`agentVersion`, default `1.0.0`) and `provider` takes `{ organization, url }`. Card signatures are JWS (HS256) objects in `signatures`.
  - Every agent of a server has its own endpoint and card under `<basePath>/<agent>`, so any A2A client reaches it. `A2AClient` reads the card and sends requests to the endpoint it names, and with `agentName` uses that agent's own card.
  - Methods follow the specification: `tasks/pushNotificationConfig/{set,get,list,delete}` (configs are `{ url, token, authentication }`, webhooks receive the task with `X-A2A-Notification-Token`) and `agent/getAuthenticatedExtendedCard`. The client methods are `setPushNotificationConfig`, `getPushNotificationConfig`, `listPushNotificationConfigs` and `deletePushNotificationConfig`.
  - New tasks start `submitted`. A task in a terminal state can no longer take a message (`-32600`), carry a conversation on with a new message in its `contextId`, whose earlier tasks the agent now gets as context. `sendMessage` returns the task or a direct reply message.
  - Error codes follow the specification: `-32007` is the extended card error, an unknown agent is `-32602`. Missing or rejected credentials are answered with HTTP 401.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A client can no longer lift or remove the run timeout with `configuration.timeout`. It must be a positive integer on `message/send` and `message/stream` alike, and the server caps it at the agent's own `timeout`, or at the new `maxRunTimeoutMs` option (default `120000`) for an agent without one. Before, `timeout: 0` or `-1` ran without a time limit and a large value outlived the operator's limit.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/server-shared@0.5.0

## 0.7.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0

## 0.7.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0

## 0.7.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2

## 0.7.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/types@0.33.1

## 0.7.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1

## 0.7.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0

## 0.7.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0

## 0.7.0

### Minor Changes

- 39bc4a9: The Express, Fastify, Hono and Koa adapters serve JSON-RPC on the server's `basePath` (still `/a2a` by default) instead of always `/a2a`, so the endpoint matches the URL the Agent Cards advertise; `A2AServer.basePath` exposes it and must start with `/`. `A2AClient` takes an `agentName` option that it sends with `message/send`, `message/stream` and `agent/extendedCard`, and `agentCard()` returns that agent's card, so every agent of a multi-agent server is reachable, not only the first.

### Patch Changes

- 39bc4a9: Errors that are neither an `A2AError` nor a `CogitatorError` (a failing task store, auth validator or agent run) no longer reach clients with their text: JSON-RPC answers them with a bare `-32603 Internal error`, failed tasks and stream `failed` events say `Internal error`, and the real error is logged on the server. A2A errors and `CogitatorError` messages are kept.
- e69e30c: `RedisClientLike.scan` now declares the call `RedisTaskStore` makes (`MATCH` / `COUNT`), so an ioredis client is accepted as is; keys SCAN returns twice are listed once.
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
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 0.6.0

### Minor Changes

- 3b35cd8: `auth.validate` may return the caller (`{ userId }`) instead of `true`. Tasks then belong to the user who created them: other users get `Task not found` from `tasks/get`, `tasks/cancel`, the push-notification methods and attempts to continue the task, `tasks/list` returns only the caller's own tasks (`TaskFilter.visibleTo`), a `contextId` holding another user's tasks is refused, and runs carry the `userId` so threads and memory are scoped too. Returning `true` keeps every caller in one shared space as before. The push-notification `get`, `list` and `delete` methods now require the task to exist, like `create`.

### Patch Changes

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

## 0.5.3

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

## 0.5.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0

## 0.5.1

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

## 0.5.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.4.0

### Minor Changes

- Resumed the unfinished 2026-07-26 audit at step 4. Critical: no framework adapter passed credentials, so any server configured with `auth` rejected every request. getAuthToken() was added and wired into all 5 adapters, and the auth scheme is now advertised on the agent card. Streaming fixes: artifact events used to be emitted after the terminal status and so never reached SSE clients. input-required streams ended with a fake failure. Listeners leaked on continuation errors. A rejected execution hung the stream. Client disconnects now abort the LLM run through an AbortSignal. Multi-turn tasks now replay the transcript, where before only the newest message was sent, and artifacts accumulate. SendMessageConfiguration is implemented: blocking:false, historyLength, acceptedOutputModes, timeout, and the new pushNotificationConfig. SSRF fixes: 127.0.0.2, CGNAT, IPv6 ULA/link-local, hex IPv4-mapped addresses, DNS rebinding (now pinned at connect time) and redirects. Client fixes: the stream timeout is now an idle timeout (it used to kill streams after 30s), CRLF SSE framing, JSON-RPC errors on non-2xx responses, and asTool. Also: the Redis cjson empty-array corruption, running tasks being evicted, and wrong JSON-RPC error codes.

  **Breaking changes**
  - tasks/pushNotification/create now returns TaskNotFound (-32001) for unknown task ids
  - Structurally invalid JSON-RPC requests now return -32600 Invalid Request instead of -32700
  - Adapters stream only for method message/stream; Accept: text/event-stream no longer turns message/send into SSE
  - JSON-RPC notifications get HTTP 204 with no body
  - Continuations pass threadId (contextId), loadHistory:false and a transcript input to CogitatorLike.run; artifacts accumulate across turns
  - Streams end on input-required; artifact events precede the final status event
  - asTool results may include taskId/state, and output is the latest answer

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.3.12

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

## 0.3.11

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.3.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.3.5

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.3.4

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.3.2

### Patch Changes

- fix(a2a): audit — 37 bugs & security fixes, +78 tests

  Security:
  - Timing-safe HMAC comparison (timingSafeEqual)
  - SSRF protection for webhook URLs (validateWebhookUrl)
  - Canonical JSON serialization for card signing
  - Content-Type validation in all adapters
  - Buffer.from for Unicode-safe Basic auth

  Bugs:
  - structuredClone in InMemoryTaskStore.update()
  - Redis SCAN-based key enumeration (was blocking KEYS)
  - Redis mget batch fetch for list operations
  - TTL validation at RedisTaskStore construction
  - SSE multi-line data parsing per spec
  - Race condition fix in streaming (listener before task)
  - Streaming message validation
  - Client agentCard() throws on empty response
  - extractOutputFromTask guards for undefined fields

  Features:
  - allowPrivateUrls config option for local dev/testing
  - InMemoryPushNotificationStore.cleanup() method

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.3.0

### Minor Changes

- Add push notifications, Agent Card signing, and production persistence
  - Push notifications with webhook delivery and HMAC verification
  - Extended Agent Card with authenticated access and capability negotiation
  - Agent Card cryptographic signing and verification
  - RedisTaskStore for production task persistence
  - Token-level streaming in SSE responses

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- 320fe4d: Add @cogitator-ai/a2a — native A2A Protocol v0.3 implementation

  First TypeScript agent runtime with native Google A2A support.
  Zero external dependencies, own implementation from spec.
  - A2AServer: expose any Cogitator Agent as A2A-compliant service
  - A2AClient: connect to remote A2A agents with discovery and streaming
  - asTool() bridge: wrap remote A2A agents as local Cogitator tools
  - Agent Card auto-generation from Agent metadata
  - Task lifecycle management with pluggable TaskStore
  - JSON-RPC 2.0 over HTTPS with SSE streaming
  - Framework adapters: Express, Hono, Fastify, Koa, Next.js
  - 119 tests, 1500 lines of production code
