# @cogitator-ai/workflows

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0

## 0.2.0

### Minor Changes

- **Type safety**: Fix setTimeout/setInterval type confusion in cron-trigger
  - Added separate `timeouts` Map for one-shot timers vs recurring `intervals`
  - Fixed improper cast `as unknown as ReturnType<typeof setInterval>`
- **Error handling**: Add error guards for safer callback invocation
  - `timer-manager.ts`: Guard `onError` callback with `instanceof Error` check
  - `circuit-breaker.ts`: Guard `recordFailure` with proper error normalization
  - `idempotency.ts`: Guard error storage with proper error normalization

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
