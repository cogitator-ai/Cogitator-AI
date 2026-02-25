# @cogitator-ai/models

## 17.1.6

### Patch Changes

- fix(models): audit — 7 bugs fixed, +21 tests, v17.1.6
  - Fix autoRefresh timer not starting when data loaded from cache
  - Remove redundant sample_spec check in fetcher
  - Export LiteLLM types and Zod schemas for public API completeness
  - Remove phantom @cogitator-ai/types peer dependency
  - Move @types/node to devDependencies
  - Add 21 new unit tests (51 → 72 total)
  - Update README with current model listings

## 17.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 17.1.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 17.1.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 17.1.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 17.1.0

### Minor Changes

- Update model registry to January 2026 models
  - Add Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
  - Add GPT-4.1, GPT-4.1 Mini/Nano, o3, o4-mini
  - Add Gemini 3 Pro/Flash Preview, Gemini 2.5 Pro/Flash/Flash-Lite
  - Mark deprecated models (Claude 3.x, GPT-4 Turbo, Gemini 1.5/2.0)
  - Fix model selector and cost estimator for new models
  - Export all 26 built-in tools from @cogitator-ai/core

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

## 8.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

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

- Add cache tests (memory/file storage, TTL, stale fallback, version mismatch)
- Add fetcher tests (fetch, transform, provider mapping, pricing calculation)
- Fix silent error handling: background refresh and auto-refresh now log warnings
- Add `shutdownModels()` export to properly cleanup singleton registry
- Fix deprecated field: now consistently returns `boolean` instead of `boolean | undefined`

### Breaking Changes

- Remove imprecise model lookup (substring matching). Now requires exact model ID or alias.

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
