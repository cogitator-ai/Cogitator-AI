# @cogitator-ai/wasm-tools

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
