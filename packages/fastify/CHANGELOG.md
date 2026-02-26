# @cogitator-ai/fastify

## 0.1.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.1.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.1.8

## 0.1.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.1.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.1.4

### Patch Changes

- fix(fastify): audit — 8 bugs fixed, +50 tests, remove unused options
  - plugin.ts: register swagger before routes (was producing empty spec); re-throw non-MODULE_NOT_FOUND errors from optional module loading
  - auth.ts: log auth errors via request.log.warn; add reply.sent guard before 401
  - error-handler.ts: use request.log.error instead of console.error
  - agents.ts: fix SSE stream protocol — emit text-end in catch block
  - threads.ts: fix timestamps (use MemoryEntry.createdAt), fix error fallback with ??
  - swarms.ts: fix ERR_MODULE_NOT_FOUND detection via error.code
  - tools.ts: use tool.toJSON().parameters instead of unsafe ZodType cast
  - workflows.ts: destructure run options to prevent overriding server callbacks
  - fastify-stream-writer.ts: finish() now respects closed guard; setupHeaders private; toolCallDelta skips empty strings
  - websocket/handler.ts: reject concurrent runs; proper payload validation; handle unsupported run types; clear abortController in finally; cap subscriptions at 64
  - types.ts: remove requestTimeout (never applied) and unused WebSocket fields
  - Add 50 unit tests across 5 test files

## 0.1.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
