# @cogitator-ai/express

## 0.4.0

### Minor Changes

- `CogitatorRequest` takes a route params type (defaults to the previous one) so routes compile against @types/express 5; tested on express 5.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/server-shared@0.2.0
  - @cogitator-ai/types@0.24.0

## 0.3.1

## 0.3.0

### Minor Changes

- Every SSE stream (agents, workflows, swarms) was cut off right after it started. The routes closed the writer on req.on('close'), which since Node 16 fires about 2ms after the body is parsed, not on disconnect (confirmed with a probe). They now use res.on('close') guarded by writableEnded, and a disconnect aborts the run, workflow or swarm. Other fixes: finish() wrote after end(). Tool-call ids did not match tool-result ids, and tool arguments were never sent. Text is now split into blocks around tool calls. Workflow failures (returned as result.error) were reported as 200 or workflow_completed. CogitatorError codes always became 500. Malformed JSON and oversized bodies returned 500. Validation: input type, context, threadId, timeout, whitelisted workflow options, thread roles. Thread metadata was dropped. The agent list leaked system prompts. CORS origin '\*' granted credentials to every origin by default. The rate limiter could be bypassed by spoofing X-Forwarded-For or sending requests with no address. On WebSocket: auth was bypassed, 'stop' was a no-op, subscriptions were dead code (now an agent:<name> channel hub), and messages were not validated. enableWebSocket was half-wired; added CogitatorServer.attachWebSocket(). README and docs had a non-existent Cogitator config, an undefined routeContext and a fake requestTimeout option; fixed. The example ran new Function on model output; it now uses the shared examples/\_shared/arithmetic.ts.

  **Breaking changes**
  - CORS: credentials now default to false when origin is '_' (plain 'Access-Control-Allow-Origin: _'); pass credentials: true explicitly to keep reflecting the origin. Disallowed origins no longer get Allow-Credentials or preflight grants
  - GET /agents returns agent.config.description instead of the first 100 characters of the instructions
  - Workflow runs that fail now return 500 WORKFLOW_FAILED (and the stream sends an error event) instead of 200 or workflow_completed
  - WebSocket upgrades now go through the configured auth function (401 when it throws)
  - Stricter validation: input must be a non-empty string, context an object, threadId a string, swarm timeout positive; workflow options are type-checked and limited to maxConcurrency, maxIterations and checkpoint; thread messages need a user/assistant/system role and a non-empty string content
  - Rate limiter: with trustProxy it keys by the nearest X-Forwarded-For hop; requests without an address share one bucket; an invalid windowMs or max throws at construction
  - CogitatorError codes now map to their own HTTP status in routes (e.g. LLM_RATE_LIMITED gives 429 instead of 500)

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

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
