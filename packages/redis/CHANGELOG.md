# @cogitator-ai/redis

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

- Fix subscribe callback: now properly invokes callback with (channel, message) on received messages
- Improve type safety: `any[]` → `unknown[]` for event callbacks
- Add typed overloads for common events (message, error, connect, etc.)
- Add port validation in `createConfigFromEnv()` (NaN defaults to 6379)

### Tests

- Add comprehensive tests for `parseClusterNodesEnv()`
- Add comprehensive tests for `createConfigFromEnv()`

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
