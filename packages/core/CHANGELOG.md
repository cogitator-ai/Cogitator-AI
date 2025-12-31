# @cogitator-ai/core

## 0.2.0

### Minor Changes

- **Timeout enforcement**: Agent timeout config now properly enforced using AbortController
- **Tool input validation**: Tool arguments validated with Zod before execution
- **Memory error callback**: Added `onMemoryError` callback to `RunOptions` for handling memory failures
- **Tool categories**: Tools now support `category` and `tags` fields for organization

### Improvements

- Abort signal now passed to tool context for graceful cancellation
- Better error messages for invalid tool arguments

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/memory@0.1.1
  - @cogitator-ai/models@1.0.0
  - @cogitator-ai/sandbox@0.1.1
