# @cogitator-ai/express

## 0.2.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.2.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.2.4

### Patch Changes

- fix(express): audit — 8 bugs fixed, +43 tests, v0.2.4
  - Fixed redundant CORS condition check (cors.ts)
  - Fixed X-Forwarded-For spoofing: added `trustProxy` option to RateLimitConfig (default false)
  - Fixed 'unknown' shared rate-limit bucket for IP-less requests
  - Fixed thread timestamps using actual MemoryEntry.createdAt instead of Date.now()
  - Fixed AbortController overwrite without aborting previous in ws-handler
  - Fixed WebSocket OPEN magic number with named constant
  - Fixed notFoundHandler using AGENT_NOT_FOUND code for generic 404 → 'NOT_FOUND'
  - Added missing ExpressMiddleware type export
  - Added 43 unit tests (middleware, streaming, routes)
  - Added vitest + supertest to devDependencies
  - Updated docs with trustProxy option

## 0.2.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- feat(express): add Express.js REST API integration package

  New package for mounting Cogitator as a REST API in any Express app:
  - CogitatorServer class for easy Express integration
  - Auto-generated endpoints for agents, threads, tools
  - SSE streaming via ExpressStreamWriter
  - WebSocket support for real-time communication
  - Swagger/OpenAPI auto-documentation
  - Middleware stack: auth, rate-limit, CORS, error handling
  - Optional workflow and swarm endpoints
