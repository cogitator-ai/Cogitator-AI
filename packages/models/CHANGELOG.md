# @cogitator-ai/models

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
