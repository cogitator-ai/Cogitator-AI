# Audit: @cogitator-ai/koa

Started: 2026-02-25

## Status

Complete

## Completed Steps

### 1. Build ✅

No issues. Clean build.

### 2. Lint ✅

No lint errors in koa package.

### 3. Remove comments ✅

No comments to remove. Clean.

### 4. Full source review ✅

26 issues found across all source files. All fixed:

**Bugs fixed (9):**

- body-parser.ts: No JSON parse error handling — added try/catch returning 400
- body-parser.ts: Only parsed POST — now handles POST/PUT/PATCH
- body-parser.ts: No body size limit (DoS) — added 1MB limit with PayloadTooLargeError
- koa-stream-writer.ts: `finish()` bypassed closed guard for `encodeDone()` — added guard
- agents.ts: Missing `textEnd` on stream error — added textStarted tracking
- threads.ts: Fake timestamps (always Date.now()) — now derives from entry data
- websocket/handler.ts: Only handled agent runs, ignored workflow/swarm — added all 3
- websocket/handler.ts: No concurrent run guard — added rejection
- websocket/handler.ts: AbortController not cleaned up — added finally block

**Pattern fixes (7):**

- Renamed `RouteContext.cogitator` → `runtime` (eliminates `cogitator.cogitator` stutter)
- context.ts: `||` → `??` for nullish defaults
- Added `WorkflowStatusResponse` type (missing vs hono/express)
- Added event factory exports to index.ts
- swagger: Added OpenAPI spec caching
- websocket: Replaced magic number `1` with `WS_OPEN` constant
- error-handler.ts: Added `ctx.headerSent` check + 413 handling

**Dead code removed (4):**

- Removed `Subscription` interface and subscribe/unsubscribe handling (never used)
- Removed module-level `clients` Map (write-only, never read)
- Removed wildcard `export * from '@cogitator-ai/server-shared'` in streaming barrel
- Removed unused `KoaMiddleware` type

**Type safety fixes (2):**

- threads.ts: Removed narrow `{ message: Message }` type annotation that blocked timestamp access
- Cleaned up WebSocket message types to match hono (removed subscribe/unsubscribe)

**Auth fix (1):**

- auth.ts: Non-auth errors (status >= 500) now re-thrown instead of masked as 401

### 5. Exports check ✅

All public API items properly exported. Added event factory exports and WorkflowStatusResponse type. Matches hono adapter export surface.

### 6. Dependencies check ✅

All imports match declared dependencies. No missing or unused deps.

### 7. Unit tests exist ✅

Created 4 test files with 106 tests:

- middleware.test.ts (25 tests): body parser, error handler, auth, context
- routes.test.ts (46 tests): health, agents, threads, tools, workflows, swarms, swagger
- stream-writer.test.ts (17 tests): all SSE events, closed guard, idempotent close
- websocket.test.ts (18 tests): ping/pong, agent/workflow/swarm runs, concurrent run guard, abort cleanup

### 8. Unit tests pass ✅

All 106 tests pass in ~2s.

### 9. E2E tests ✅

No e2e tests needed — consistent with other server adapters (express, hono, fastify all lack e2e). Server adapters are thin wrappers; LLM integration is tested via core e2e.

### 10. Test coverage gaps ✅

Added swagger route tests. Full module coverage achieved.

### 11. Package README ✅

Updated to reflect current API: runtime field naming, event factories, WebSocket protocol, body parser improvements.

### 12. Root README ✅

Koa properly listed in packages table, examples table, and server adapters section.

### 13. Docs site ✅

Koa docs page exists at packages/dashboard/content/docs/server-adapters/koa.mdx. Content verified accurate against current API.

### 14. Examples ✅

Example at examples/integrations/04-koa-server.ts updated with WebSocket support using correct `runtime` field naming.

### 15. CLAUDE.md ✅

Koa listed in Architecture section.

## Insights & Notes

- Koa adapter now closely matches hono (canonical) patterns
- The `as unknown as { body: T }` cast pattern remains across all POST routes — inherent to Koa's typing model
- WebSocket still bypasses Koa middleware (including auth) because it attaches at server level — limitation of ws library + Koa architecture, consistent with Express adapter
- 23 bugs fixed, 106 tests written, 0 issues deferred
