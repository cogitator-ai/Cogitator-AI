# @cogitator-ai/koa

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
  - @cogitator-ai/memory@0.8.1

## 0.3.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1

## 0.3.0

### Minor Changes

- Tested on koa 3 and @koa/router 15.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/server-shared@0.2.0
  - @cogitator-ai/types@0.24.0

## 0.2.1

## 0.2.0

### Minor Changes

- Fixed 27 issues in the Koa adapter. Auth wrapped next(), so route errors without a 5xx status came back as 401. Prototype names like constructor and toString crashed REST and WS lookups. /tools returned raw Zod objects instead of JSON Schema, and /agents leaked system-prompt text. Non-Cogitator error messages and memory adapter errors reached clients, and CogitatorError statuses were ignored. Failed workflows (result.error) came back as 200, workflow_completed or WS complete. Request bodies had no type validation, and workflow options were forwarded whole (skipNodes crash, forged workflowId). Thread role is now validated, metadata is kept and tokenCount is estimated. SSE tool-call ids now match their tool-result. A client disconnect now aborts agent, workflow and swarm runs; the old req 'close' listener was unreliable. Map fields no longer serialize as {}. The body parser hung when koa-bodyparser had already run; it now drains before returning 413 and takes a bodyLimit option. WebSocket now has handshake auth and noServer path routing that leaves other upgrade listeners alone. pingTimeout is implemented, the stop/run race is fixed, unknown messages and run types get explicit errors, and threadId is supported. Dead app-level enableWebSocket/websocket config is removed.

  **Breaking changes**
  - CogitatorAppOptions.enableWebSocket and .websocket are removed; they only printed a console.log. Use setupWebSocket(server, ctx, config).
  - GET /agents `description` is now agent.config.description, no longer the first 100 chars of instructions.
  - Non-CogitatorError messages and memory adapter error strings are masked as 'Internal server error' in REST, SSE and WS responses.
  - Workflow runs that end with result.error now return an error (500 / SSE error event / WS error), not success.
  - Workflow request `options` other than maxConcurrency, maxIterations and checkpoint are dropped; invalid option types return 400.
  - Request bodies are type-validated (input string, context object, threadId string, timeout > 0, role user|assistant|system) and invalid ones return 400.
  - WebSocket: with no other upgrade listener, non-matching upgrade paths get 404 instead of 400. When other listeners exist they are left to those listeners.

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
