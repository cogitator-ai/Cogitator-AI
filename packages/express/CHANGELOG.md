# @cogitator-ai/express

## 0.2.15

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

## 0.2.14

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.2.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.2.8

## 0.2.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.2.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.2.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.2.4

### Patch Changes

- fix(express): audit — 8 bugs fixed, +43 tests, v0.2.4
  - Fixed redundant CORS condition check (cors.ts)
  - Fixed X-Forwarded-For spoofing: added `trustProxy` option to RateLimitConfig (default false)
  - Fixed 'unknown' shared rate-limit bucket for IP-less requests
  - Fixed thread timestamps using actual MemoryEntry.createdAt instead of Date.now()
  - Fixed AbortController overwrite without aborting previous in ws-handler
  - Fixed WebSocket OPEN magic number with named constant
  - Fixed notFoundHandler using AGENT_NOT_FOUND code for generic 404 → 'NOT_FOUND'
  - Added missing ExpressMiddleware type export
  - Added 43 unit tests (middleware, streaming, routes)
  - Added vitest + supertest to devDependencies
  - Updated docs with trustProxy option

## 0.2.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- feat(express): add Express.js REST API integration package

  New package for mounting Cogitator as a REST API in any Express app:
  - CogitatorServer class for easy Express integration
  - Auto-generated endpoints for agents, threads, tools
  - SSE streaming via ExpressStreamWriter
  - WebSocket support for real-time communication
  - Swagger/OpenAPI auto-documentation
  - Middleware stack: auth, rate-limit, CORS, error handling
  - Optional workflow and swarm endpoints
