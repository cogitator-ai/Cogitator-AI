# @cogitator-ai/hono

## 0.1.3

### Patch Changes

- fix(hono): audit — 26 bugs fixed, +93 tests, v0.1.3
  - Fix auth function to receive Hono Context instead of CogitatorContext
  - Fix threads createdAt/updatedAt to derive from entries (was hardcoded Date.now())
  - Fix missing try/catch around c.req.json() and runtime.run() in all routes
  - Fix body parsing inside SSE callback (moved before streamSSE for proper HTTP 400)
  - Fix stream writer close() to actually abort the stream
  - Fix stream writer finish() missing closed guard
  - Fix stream writer toolCallDelta missing empty-string guard
  - Fix WebSocket async import race condition (changed to sync import)
  - Fix WebSocket handler to support workflow and swarm types (was agent-only)
  - Fix WebSocket concurrent run protection and abortController cleanup
  - Add swagger spec caching (was regenerated per request)
  - Remove dead requestTimeout option, subscription system, subscribe/unsubscribe types
  - Add WebSocket handler exports to index.ts
  - Add 93 unit tests (routes, middleware, streaming, websocket)
  - Update README, docs, and types for new auth signature

## 0.1.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.1.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
