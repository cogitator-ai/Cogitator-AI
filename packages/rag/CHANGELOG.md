# @cogitator-ai/rag

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
