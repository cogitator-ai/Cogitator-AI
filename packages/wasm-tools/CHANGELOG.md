# @cogitator-ai/wasm-tools

## 0.5.11

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

## 0.5.10

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.5.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.5.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.5.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.5.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.5.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.5.3

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.5.2

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.5.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.5.0

### Minor Changes

- Add 10 new WASM-based tools expanding the library from 4 to 14 built-in tools:
  - **slug**: URL-safe slug generation with Unicode transliteration
  - **validation**: Email, URL, UUID, IPv4, IPv6 validation
  - **diff**: Myers diff algorithm with unified/inline output
  - **regex**: Pattern matching with ReDoS protection (100k step limit)
  - **csv**: RFC 4180 compliant CSV parsing and generation
  - **markdown**: GFM subset Markdown to HTML converter
  - **xml**: SAX-style XML parser with XPath-like queries
  - **datetime**: Date operations with UTC + offset timezone support
  - **compression**: Pure JS gzip/deflate/zlib implementation
  - **signing**: Ed25519 digital signatures (pure JS, no dependencies)

## 0.4.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.4.0

### Minor Changes

- Add WasmToolManager for WASM tool hot-reload support
  - WasmToolManager class with watch() and load() methods
  - FileWatcher with debouncing for file system events
  - WasmLoader for Extism plugin lifecycle management
  - Automatic tool updates when WASM files change
  - Full test coverage (28 tests)

## 0.3.7

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.3.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

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

- Add hash and base64 WASM plugins
  - New `createHashTool()` for SHA-256, SHA-1, MD5 hashing
  - New `createBase64Tool()` for encode/decode with URL-safe support
  - Both tools run in isolated Extism sandbox

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

- **Documentation**: Update README to reflect actual API exports
  - Old docs showed non-existent `wasmCalculator()` and `wasmJsonProcessor()` functions
  - Now correctly documents `calcToolConfig`, `jsonToolConfig`, and `getWasmPath()`
- **Type safety**: Add type guard in JSON processor for safer property access
  - Added `isRecord()` type guard to properly validate object types before indexing

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
