# @cogitator-ai/mcp

## 17.0.11

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
  - @cogitator-ai/types@0.22.3

## 17.0.10

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 17.0.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 17.0.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 17.0.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 17.0.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 17.0.5

### Patch Changes

- fix(mcp): audit — 6 bugs fixed, +28 tests, v17.0.5
  - Fix missing exports: toolSchemaToMCP, mcpContentToResult, resultToMCPContent, serveMCPTools, StdioTransportConfig, HttpTransportConfig
  - Fix createHttpTransport ignoring headers config
  - Fix timeout timer leak on successful connection
  - Fix unregister methods silently failing after server start (now throws)
  - Move @types/node to devDependencies
  - Add 28 new tests (88 total)

## 17.0.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 17.0.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 17.0.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 17.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 16.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 14.1.0

### Minor Changes

- feat(mcp): add server-side resources and prompts support

  Add full MCP specification compliance for MCPServer with:
  - registerResource() for static and dynamic (templated) resources
  - registerPrompt() for reusable prompt templates with arguments
  - Support for URI templates like 'memory://thread/{id}'
  - Batch registration methods: registerResources(), registerPrompts()
  - Getter methods: getRegisteredResources(), getRegisteredPrompts()
  - Unregister methods: unregisterResource(), unregisterPrompt()

## 14.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 13.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 10.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 9.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 8.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 8.1.0

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

## 8.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 7.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 6.0.1

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 6.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 5.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 4.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 1.1.0

### Minor Changes

- Add MCPClient tests (connect, capabilities, tools, resources, prompts)
- Add MCPServer tests (register, start/stop, logging)
- Add HTTP server shutdown support in stop() method
- Remove redundant type casts in MCPServer

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
