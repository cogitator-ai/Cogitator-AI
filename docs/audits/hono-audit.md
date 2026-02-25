# Audit: @cogitator-ai/hono

Started: 2026-02-25

## Status

**Complete**
Last updated: 2026-02-25

## Completed Steps

### 1. Build — ✅ No issues

Build passes cleanly.

### 2. Lint — ✅ No issues

Zero lint errors in hono package.

### 3. Remove comments — ✅ No issues

No comments to remove, source was already clean.

### 4. Full source review — 22 issues found, all fixed

**Bugs fixed (10):**

- `auth.ts:8` — AuthFunction received CogitatorContext instead of Hono Context, making header-based auth impossible. Changed signature to accept `Context<HonoEnv>`.
- `threads.ts:29-30` — `createdAt`/`updatedAt` hardcoded to `Date.now()`. Now derives from `entries[0].createdAt.getTime()` / `entries[last].createdAt.getTime()` like express/fastify.
- `threads.ts:25` — Lossy type annotation `(entry: { message: unknown })` erased MemoryEntry types, requiring unsafe cast. Removed manual type annotation.
- `agents.ts:32` — Missing try/catch around `c.req.json()`. JSON parse errors now return 400 instead of 500. Applied to all routes (agents, swarms, workflows, threads).
- `agents.ts:40` — Missing try/catch around `ctx.runtime.run()` in /run endpoint. Now catches and returns 500 properly.
- `agents.ts:70` — Body parsed inside SSE callback (after headers sent). Moved parsing before `streamSSE()` so HTTP 400 can be returned for bad input.
- Same fix applied to swarms/stream and workflows/stream endpoints.
- `hono-stream-writer.ts:84-87` — `close()` set `this.closed = true` but never called `stream.abort()`. Connection stayed alive. Now calls `this.stream.abort()`.
- `hono-stream-writer.ts:79-82` — `finish()` bypassed closed guard on `[DONE]` write. Added `if (this.closed) return` guard.
- `app.ts:37-39` — WebSocket routes registered via fire-and-forget async import (race condition). Changed to sync import.
- `websocket/handler.ts:116-159` — `handleRun` only handled `agent` type, silently ignored `workflow` and `swarm`. Added full workflow and swarm support.

**Type safety fixes (2):**

- `types.ts:41-43` — `AuthFunction` type now receives `Context<HonoEnv>` instead of `CogitatorContext`.
- `hono-stream-writer.ts:55-57` — `toolCallDelta()` missing empty-string guard (unlike `textDelta` and fastify implementation). Added `if (!argsTextDelta) return`.

**Dead code removed (4):**

- `types.ts:65` — `requestTimeout` option declared but never used anywhere. Removed.
- `websocket/handler.ts:6-9,67-74` — Subscription interface and subscription Map (dead pub/sub plumbing). Removed.
- `types.ts:219-224` — `subscribe`/`unsubscribe` WebSocket message types (no handler). Removed from WebSocketMessage and WebSocketResponse.

**Edge cases fixed (3):**

- threads.ts — Added try/catch around memory operations (getEntries, addEntry, clearThread).
- `agents.ts:114-116` — No `textEnd` on error mid-stream. Added `textStarted` tracking and `textEnd` call in catch block.
- `websocket/handler.ts:113` — No concurrent run protection (silently overwrote previous abortController). Added check that rejects if run already in progress, and `finally` block to clear controller.

**Performance fix (1):**

- `swagger/index.ts:13-21` — Spec regenerated on every request. Added caching (generated once, reused).

**Pattern consistency (2):**

- Moved all body parsing before SSE stream setup across all stream endpoints (agents, swarms, workflows).
- WebSocket handler now properly clears `abortController` in `finally` block.

### 5. Exports check — ✅ Fixed

Added missing exports for WebSocket handler functions (`createWebSocketRoutes`, `handleWebSocketMessage`, `createClientState`). All public API items now exported from index.ts.

### 6. Dependencies check — ✅ No issues

All imports match package.json deps. hono is a peer dep, workflows/swarms are optional (dynamic import).

### 7. Unit tests exist — ✅ Created

Created 3 test files with 74 tests total:

- `routes.test.ts` — 40 tests (health, agents, threads, tools, workflows, swarms)
- `middleware.test.ts` — 15 tests (auth, context, error handler)
- `stream-writer.test.ts` — 19 tests (all stream writer methods, lifecycle)

### 8. Unit tests pass — ✅ All 74 pass

All 3 test files, 74 tests, running in 1.01s.

### 9. E2E tests exist — ✅ Pass

E2E tests at `packages/e2e/src/__tests__/server-adapters/hono-server.e2e.ts` — 5 tests pass (agent run + streaming).

### 10. Test coverage gaps — ✅ Filled

Added `websocket.test.ts` with 19 tests covering WebSocket handler, concurrent run protection, abort, workflow/swarm dispatch. Total: 93 unit tests + 5 e2e tests = 98 tests.

### 11. Package README — ✅ Fixed

Updated auth example to use new `Context<HonoEnv>` parameter (was `CogitatorContext`). Added missing swagger options to the table.

### 12. Root README — ✅ No issues

Package is listed in the packages table and badge links.

### 13. Docs site — ✅ Fixed

Updated `packages/dashboard/content/docs/server-adapters/hono.mdx`:

- Removed `requestTimeout` from options interface (was dead code, now removed from types)
- Fixed auth section: was saying `CogitatorContext`, now says `Context<HonoEnv>` with correct example
- Added WebSocket exports to the utilities section

### 14. Examples — ✅ No issues

Example exists at `examples/integrations/03-hono-server.ts`, uses current API correctly.

### 15. CLAUDE.md — ✅ No issues

Package listed in Architecture section.

## Summary

- **Total issues found:** 26
- **All fixed:** 26/26
- **Tests added:** 93 unit tests (from 0)
- **Files modified:** 12 source files, 2 docs files, 1 README

## Pending Steps

(none)

## Insights & Notes

- Hono adapter was significantly behind express/fastify in robustness. Most bugs were patterns that express/fastify already handled correctly.
- Auth function signature mismatch was the most impactful bug — made authentication completely non-functional.
- Stream writer lacked proper lifecycle management (close not closing, finish not guarded).
