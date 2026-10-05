# @cogitator-ai/rag

## 0.5.4

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/memory@0.11.6

## 0.5.3

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/types@0.33.1

## 0.5.2

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/memory@0.11.4

## 0.5.1

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/memory@0.11.3

## 0.5.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Agents can crawl politely. Nothing in Cogitator looked at robots.txt, so every app that read the web had to write its own check. `RobotsPolicy` in core reads and caches robots.txt per site by RFC 9309 (product token groups or `*`, longest match, `*` and `$` patterns, a 4xx file allows all, a 5xx or a network failure allows nothing until the cache expires) and implements the new `RobotsChecker` interface from types. `WebLoader` takes it as `robots` and checks every hop, redirect targets included, failing with `RobotsDisallowedError` before any request. `BrowserSession` takes it as `robots` and blocks disallowed navigations, typed, clicked, redirected or in frames, while `newTab(url)` and `browser_navigate` say why. `createWebScrapeTool({ userAgent, robots })` builds a `web_scrape` tool that checks every hop, redirects included.

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0

## 0.4.0

### Minor Changes

- [`12ac6a8`](https://github.com/cogitator-ai/Cogitator-AI/commit/12ac6a851f60fdbdafcc7a05aa8aa65e91426572) - `LLMReranker` failures can be observed. When the model's answer held no ranking, for example because a reasoning model spent its token budget on reasoning and answered with empty content, the reranker only logged a console warning and returned the retrieval order, so a pipeline looked reranked while it was not. Pass `onError` to be told about every fallback, with the raw answer, or `strict: true` to make `rerank()` throw an `LLMRerankError` instead. Without either option the reranker falls back and warns as before.

### Patch Changes

- Updated dependencies [[`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/types@0.30.0

## 0.3.5

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [bb17767]
- Updated dependencies [9175c69]
- Updated dependencies [e7925d5]
- Updated dependencies [4a2925f]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/memory@0.11.0

## 0.3.4

### Patch Changes

- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0

## 0.3.3

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/memory@0.9.1

## 0.3.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/memory@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/memory@0.8.1

## 0.3.0

### Minor Changes

- PDFLoader runs on pdf-parse 2 with the same documents and metadata; per-page mode reports the real page number after skipped empty pages.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/types@0.24.0

## 0.2.0

### Minor Changes

- The published package could not be imported in plain Node ESM: all relative imports were extensionless, so dist/index.js failed outside bundlers, tsx and vitest. All imports now use .js, guarded by a test and verified with `node import()`. CSVLoader always crashed in real Node because of papaparse CJS interop. RecursiveChunker lost text and produced wrong offsets and fully-contained duplicate chunks whenever separators repeated (509 violations in 3000 randomized runs). It was rewritten on offset spans; the property test now finds 0 violations. RAGPipelineBuilder ignored retrieval.strategy: mmr, hybrid and multi-query silently fell back to similarity. They are now wired, with withHybridSearch/withQueryExpander and multiQueryCount. Hybrid retrieval's BM25 index was never populated, so it is now auto-indexed through a ChunkIndexer contract with correct RRF keys and keyword-only hits mapped back to their chunks. Undefined query options overrode the configured topK/threshold. Loader metadata (frontmatter, page numbers, CSV columns, titles) was dropped at ingest. Vector-store writes were unbounded. RetrievalResult.source is now the document path/URL. MMR now re-embeds when the store (e.g. Qdrant) returns no vectors. Multi-query falls back to the original query when expansion fails and throws when every retrieval fails. WebLoader had SSRF bypasses (bracketed and IPv4-mapped IPv6, missing ranges, DNS rebinding). It now uses http(s) with a guarded connect-time lookup on every redirect hop, adds allowPrivateNetwork, content-type handling, decompression and charset decoding. HTMLLoader now drops scripts/styles and keeps block boundaries. rag_ingest gained allowedRoots/allowUrls, because it could read any local file. VERSION is read from package.json. README, docs site and examples were updated; the docs' hybrid example passed the wrong type.

  **Breaking changes**
  - RAGPipelineBuilder now honours retrieval.strategy: 'mmr' builds an MMRRetriever, and 'hybrid'/'multi-query' throw at build() unless withHybridSearch()/withQueryExpander() (or withRetriever()) is provided. Previously all of these silently used similarity.
  - RetrievalResult.source is the document path/URL instead of the constant 'document'.
  - WebLoader only accepts HTML/XML, text/\* and JSON responses (others throw). It now uses node:http(s) instead of global fetch, so fetch mocks no longer intercept it.
  - MultiQueryRetriever falls back to the original query when expandQuery throws, and throws when every variant retrieval fails (previously it returned []).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/types@0.23.0

## 0.1.10

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
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3

## 0.1.9

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/memory@0.6.21

## 0.1.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/memory@0.6.20

## 0.1.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/memory@0.6.19

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/memory@0.6.17

## 0.1.5

### Patch Changes

- @cogitator-ai/memory@0.6.16

## 0.1.4

### Patch Changes

- fix(rag): audit — 21 bugs fixed, +13 regression tests
  - Fixed infinite loop when chunkOverlap >= chunkSize (FixedSizeChunker, RecursiveChunker)
  - Fixed PDFLoader.splitPages producing empty content
  - Fixed CohereReranker out-of-bounds index + empty results handling
  - Fixed LLMReranker greedy regex, unclamped scores, empty results
  - Fixed pipeline vectors/chunks mismatch validation, empty chunks guard
  - Fixed unsafe casts in retrievers (documentId), JSONLoader (primitives)
  - Removed dead MultiQueryRetriever.defaultQueryCount config
  - Aligned SimilarityRetriever default threshold to 0.0 (matching schema)
  - Removed unused @cogitator-ai/core peer dependency
  - Fixed README inaccuracies (CSVLoader options, JSONLoader description)

## 0.1.3

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.14
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
