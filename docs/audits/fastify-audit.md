# Audit: @cogitator-ai/fastify

Started: 2026-02-25

## Status

Complete
Last updated: 2026-02-25

## Completed Steps

### Step 1: Build ✅

`pnpm --filter @cogitator-ai/fastify build` — No issues.

### Step 2: Lint ✅

`pnpm -w run lint` — No issues in packages/fastify/.

### Step 3: Remove comments ✅

`npx tsx scripts/remove-comments.ts` — 0 changes in packages/fastify/.

### Step 4: Full source review ✅

Reviewed 18 source files via 3 parallel subagents. Found and fixed:

**plugin.ts:**

- Bug: Swagger registered after routes (spec would be empty) → moved swagger registration before route registration
- Bug: catch-all error swallowing for optional modules (swallowed registration errors) → now re-throw non-MODULE_NOT_FOUND errors
- Dead option: `requestTimeout` accepted but never applied → removed from types.ts

**auth.ts:**

- Bug: auth errors logged nowhere → log with `request.log.warn`
- Bug: no `reply.sent` guard before sending 401 → added guard

**error-handler.ts:**

- Pattern: `console.error` instead of `request.log.error` → fixed

**agents.ts:**

- Dead code: redundant input validation after schema enforcement → removed
- Bug: stream protocol malformed on error (missing `text_end`) → hoisted `textId`, added `textStarted` flag, emit `textEnd` in catch

**threads.ts:**

- Bug: `result.error` possibly undefined in 3 error responses → used `?? 'Unknown error'`
- Bug: `createdAt`/`updatedAt` always `Date.now()` → now derived from first/last `MemoryEntry.createdAt`
- Dead code: redundant input validation after schema enforcement → removed

**swarms.ts:**

- Dead code: redundant input validation (both run and stream) → removed
- Bug: fragile `error.message.includes('Cannot find module')` detection → use `error.code === 'ERR_MODULE_NOT_FOUND'`

**tools.ts:**

- Type safety: `tool.parameters` cast as `Record<string, unknown>` (ZodType) → use `tool.toJSON().parameters`

**workflows.ts:**

- Bug: request options spread could override server streaming callbacks → destructure only known fields
- Bug: fragile module detection → use error.code

**fastify-stream-writer.ts:**

- Bug: `finish()` wrote `encodeDone()` bypassing `closed` guard → added guard
- Bug: `setupHeaders()` was public (could cause ERR_HTTP_HEADERS_SENT) → made private
- Minor: `toolCallDelta()` missing empty guard → added

**websocket/handler.ts:**

- Bug: concurrent `run` overwrites abortController → reject second run if one is in progress
- Bug: unsafe `as` cast on payload → proper typeof validation
- Bug: `workflow`/`swarm` run types silently ignored → return error response
- Bug: abortController not cleared after run → clear in finally
- Dead code: `Subscription.callback` never called → removed callback from interface, use Set<string>
- Edge case: subscriptions Map grows unboundedly → added 64-channel cap

### Step 5: Exports check ✅

All public API types, schemas, and utilities exported. No internal leaks.

### Step 6: Dependencies check ✅

All static and optional deps correctly declared. No unused/missing deps.

### Step 7: Unit tests exist ✅

Created 5 test files, 50 tests total covering hooks, routes, stream writer, workflows, swarms.

### Step 8: Unit tests pass ✅

50/50 pass.

### Step 9: E2E tests exist and pass ✅

`server-adapters/fastify-server.e2e.ts` 5/5 pass (Ollama cloud).

### Step 10: Test coverage gaps ✅

Added workflow/swarm routes + thread error propagation regression tests → 50/50 pass.

### Step 11: Package README ✅

Removed `requestTimeout` and unused WebSocket fields (`pingInterval`, `pingTimeout`, `maxPayloadSize`).

### Step 12: Root README ✅

`@cogitator-ai/fastify` already present in packages table.

### Step 13: Docs site ✅

`packages/dashboard/content/docs/server-adapters/fastify.mdx` — removed `requestTimeout` and unused WebSocket config fields.

### Step 14: Examples ✅

`examples/integrations/02-fastify-server.ts` — uses current API correctly, no changes needed.

### Step 15: CLAUDE.md ✅

`fastify` listed in Architecture section at correct position.

## Insights & Notes

- Swagger must be registered BEFORE routes in `fastify-plugin` scope — otherwise spec captures no routes
- Optional Fastify plugins (`@fastify/swagger`, `@fastify/rate-limit`, `@fastify/websocket`) should use `error.code === 'ERR_MODULE_NOT_FOUND'` not string matching
- `tool.parameters` is a ZodType, not a plain object — always use `tool.toJSON().parameters` for serialization
- WebSocket handlers need explicit concurrent-run rejection; `AbortController` must be cleared in `finally`
- SSE protocol: if `textStart` was emitted, `textEnd` must be emitted even on error paths
