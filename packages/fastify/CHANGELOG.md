# @cogitator-ai/fastify

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
