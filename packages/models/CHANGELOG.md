# @cogitator-ai/models

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
