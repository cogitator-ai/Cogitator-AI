# @cogitator-ai/hono

## 0.2.1

## 0.2.0

### Minor Changes

- Fixed 22 issues in the Hono adapter. Routes returned 500 for every CogitatorError, and the error handler also turned HTTPExceptions into 500; statuses are now mapped type-safely. Failed workflows came back as success over REST, SSE and WS. A client disconnect never aborted runs; agent and workflow runs now get request/stream abort signals and swarms are aborted. HonoStreamWriter.close() aborted the stream on the error path, so the error event could be lost. There was no body size limit; a bodyLimit option (default 1 MiB, 413) and createBodyLimitMiddleware are added. A workflow POST with no body is now accepted. Bodies are now type-validated and workflow options whitelisted. Thread role is validated, metadata is kept, tokenCount is estimated and adapter errors are masked. SSE tool-call ids now match tool results, /agents no longer leaks instructions, and agentUsage Maps are serialized. The WebSocket endpoint was an unfinished 501 stub; it is now built on the runtime's upgradeWebSocket helper behind the auth middleware, with maxPayloadSize enforcement (close 1009) and binary frames. Abort signals are wired so stop and close actually cancel runs, the stop race is fixed, messages are masked, unknown types get explicit errors, and threadId is supported. Dead pingInterval config is removed.

  **Breaking changes**
  - WebSocketConfig.pingInterval is removed; it was never implemented because Hono's WSContext has no ping API.
  - GET /agents `description` is now agent.config.description, no longer the first 100 chars of instructions.
  - Memory adapter error strings are masked as 'Internal server error'.
  - HonoStreamWriter.close() no longer calls stream.abort(); it only marks the writer closed.
  - Workflow runs that end with result.error now return an error (500 / SSE error event / WS error).
  - Request bodies are type-validated and unsupported workflow options are dropped; request bodies are limited to 1 MiB by default (configurable via bodyLimit).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/types@0.23.0

## 0.1.14

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

## 0.1.13

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.1.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.1.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.1.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.1.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.1.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.1.7

## 0.1.6

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.1.5

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.1.3

### Patch Changes

- fix(hono): audit — 26 bugs fixed, +93 tests, v0.1.3
  - Fix auth function to receive Hono Context instead of CogitatorContext
  - Fix threads createdAt/updatedAt to derive from entries (was hardcoded Date.now())
  - Fix missing try/catch around c.req.json() and runtime.run() in all routes
  - Fix body parsing inside SSE callback (moved before streamSSE for proper HTTP 400)
  - Fix stream writer close() to actually abort the stream
  - Fix stream writer finish() missing closed guard
  - Fix stream writer toolCallDelta missing empty-string guard
  - Fix WebSocket async import race condition (changed to sync import)
  - Fix WebSocket handler to support workflow and swarm types (was agent-only)
  - Fix WebSocket concurrent run protection and abortController cleanup
  - Add swagger spec caching (was regenerated per request)
  - Remove dead requestTimeout option, subscription system, subscribe/unsubscribe types
  - Add WebSocket handler exports to index.ts
  - Add 93 unit tests (routes, middleware, streaming, websocket)
  - Update README, docs, and types for new auth signature

## 0.1.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.1.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
