# @cogitator-ai/wasm-tools

## 0.7.6

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.7.5

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0

## 0.7.4

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.7.3

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.7.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.7.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.7.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 0.6.0

### Minor Changes

- An abort that arrived while a WASM plugin was still being created was missed, so the call hung until its timeout. The abort signal is now checked once the plugin is ready.
- The 14 pre-built WASM tools could not run at all. extism-js 1.5 output needs host functions (get_log_level) that @extism/extism 1.0.3 lacks; it now requires ^2.0.0-rc13, which is npm's latest. WASI was also disabled, and QuickJS plugins need it. defineWasmTool().execute() returned its params instead of running WASM. It now validates params, runs the module in an Extism worker thread with a working timeout and abort, caches compiled modules, and sets tool.timeout. @extism/extism moved from devDependencies to dependencies (the manager imports it at runtime). tsc no longer ships tests and plugins in dist; build-wasm now fails when a plugin fails to compile. WasmToolManager got a timeout plus plugin recycling after timeout or abort. Plugins: a base64 decoder bug broke gzip decompression and base64 Ed25519 keys. Compression: empty input, CRC/size checks, a zip-bomb cap, and LZ77 matching at levels 1-3. Ed25519 key generation always failed; it now uses a host-side node:crypto seed via the schema, and signatures match node:crypto byte for byte. Markdown had an XSS hole (javascript:/data: URLs, code-fence class injection) plus emphasis, table and escaping bugs. Others: strict base64, a JSONPath subset, rewritten XML query evaluation and stricter parsing, CSV quoting and validation, real unified diff output, datetime month clamping and validation, a better ReDoS heuristic, slug punctuation, email/URL/IP validation with IPv6 canonicalization, calc edge cases. One shared UTF-8/base64/hex module. A plugin test harness (esbuild + node:vm) lets CI cover plugin logic without extism-js. README, docs site and example updated.

  **Breaking changes**
  - Tool execute() now actually runs the WASM module (it used to return its input).
  - compression: decompress now defaults to inputEncoding 'base64' and outputEncoding 'utf8'.
  - diff: 'unified' output is now a standard unified diff (---/+++ headers, @@ hunks, '+'/'-'/' ' prefixes).
  - xml: absolute queries start at the root element; a query with no match returns type 'empty'.
  - json: output gains 'found'; wildcard, slice and recursive paths always return arrays; null values report type 'null'.
  - validation: IPv4 with leading zeros is rejected; IPv6 'normalized' is the RFC 5952 canonical form; only the email domain is lower-cased.
  - @extism/extism must be >= 2.0.0-rc13 (needed by the pre-built extism-js plugins).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

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
