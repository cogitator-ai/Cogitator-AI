# @cogitator-ai/openai-compat

## 4.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/types@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0

## 1.1.0

### Minor Changes

- Add `listFiles()` method to ThreadManager
- Fix `/v1/files` endpoint returning empty array (now returns actual files)
- Add console.warn for run execution failures (was silent fire-and-forget)
- Improve type safety: `unknown[]` → `AssistantTool[]` in StoredAssistant

### Tests

- Add tests for `listFiles()` method

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
