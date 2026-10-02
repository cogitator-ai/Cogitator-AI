# @cogitator-ai/browser

## 0.3.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.2.0

### Minor Changes

- Session lifecycle: fixed a race where concurrent ensureStarted() calls launched extra browsers, a browser-process leak when start() failed, a dead session after an unexpected context close, and tab indexes going stale after closes. Implemented the documented-but-ignored persistentContext and pool.maxPages options, tracking of popups and target=\_blank pages, merging partial stealth configs with their defaults, and cookie path defaults. Stealth: humanLikeMouse was never used. Click, click_by_description, hover and scroll now honour it. humanLikeClick scrolls into view, accepts a Locator, keeps button/clickCount/position and remembers the last mouse position. navigator.platform and languages now match the user agent and locale, evasions are patched on Navigator.prototype, and the UA pool is desktop-only. Network: API call timing was always 0 (now recorded on requestfinished). Calls are captured from session start in all tabs. Interceptors are context-level, use route.fallback so overlapping rules still work, merge headers and support /regex/ patterns. New browser_remove_interceptor tool. HAR capture rewritten: ordered entries, waits for in-flight requests, no leaks between captures, text-only bodies, real HAR 1.2 file. The exported network factories were unusable because they needed a non-exported argument. Vision/extraction: the aria-snapshot parser dropped paragraphs, list items and YAML-quoted names. Fixed nested tables in extract_table, extract_structured no longer clones the DOM (that had side effects), plus visibility and screenshot-option fixes. Schemas tightened. README, root README count and docs site updated.

  **Breaking changes**
  - browser_capture_har: the file written to path is now HAR 1.2 ({ log: { entries } }) instead of { entries }; responseBody is omitted for binary bodies or bodies over 1 MB.
  - Interceptors (browser_intercept_request, browser_block_resources) are registered on the browser context, so they apply to every tab, not just the tab that was active.
  - createInterceptRequestTool, createBlockResourcesTool and createGetApiCallsTool now take only (session). The old second argument had a non-exported type and could not be supplied.
  - In stealth mode with humanLikeTyping, browser_type replaces the field value (clears it first) instead of appending.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.1.6

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

## 0.1.5

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.1.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.1.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7
