# @cogitator-ai/a2a

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
