# E2E Phase 3 — Server Adapters + OpenAI Compat

## Goal

E2E coverage for server adapter packages (express, fastify, hono, koa, next), server-shared utilities, and openai-compat layer. Real HTTP requests against real servers with real Cogitator agents.

## Architecture

All 4 server adapters expose identical HTTP API:

- `GET /health` — status check
- `GET /agents` — list registered agents
- `POST /agents/:name/run` — synchronous agent execution
- `POST /agents/:name/stream` — SSE streaming

**Strategy:** shared test generator function that takes a server factory. Each adapter file provides its factory (~30 lines), the generator runs ~5 tests per adapter.

## Package Dependencies

Add to `packages/e2e/package.json`:

```json
"@cogitator-ai/express": "workspace:*",
"@cogitator-ai/fastify": "workspace:*",
"@cogitator-ai/hono": "workspace:*",
"@cogitator-ai/koa": "workspace:*",
"@cogitator-ai/next": "workspace:*",
"@cogitator-ai/server-shared": "workspace:*",
"@cogitator-ai/openai-compat": "workspace:*",
"fastify": "^5.0.0",
"hono": "^4.0.0",
"@hono/node-server": "^1.0.0",
"koa": "^2.15.0",
"@koa/router": "^12.0.0"
```

Dev deps:

```json
"@types/koa": "^2.15.0",
"@types/koa__router": "^12.0.0"
```

## New Test Files

### 1. `src/helpers/server-test-utils.ts` — Shared test generator

```typescript
interface ServerFactory {
  start(cogitator: Cogitator, agents: Record<string, Agent>): Promise<{ port: number }>;
  stop(): Promise<void>;
}

function describeServerAdapter(name: string, factory: ServerFactory): void;
```

Generates 5 tests:
| Test | Hard Assertions | Needs Ollama |
|------|----------------|--------------|
| health endpoint returns status | status 200, body.status === 'ok' | No |
| lists registered agents | status 200, agents array includes test agent | No |
| runs agent and returns output | status 200, output is string, usage.totalTokens > 0 | Yes |
| streams agent response via SSE | status 200, content-type text/event-stream, receives text-delta events | Yes |
| returns error for unknown agent | status 404 or error response | No |

### 2. `src/__tests__/server-shared/protocol.e2e.ts` (~4 tests)

No Ollama needed. Pure utility tests.

| Test                                          | Hard Assertions                                    |
| --------------------------------------------- | -------------------------------------------------- |
| event factories create correctly typed events | each event has correct type field and data         |
| encodeSSE produces valid SSE format           | starts with "data: ", ends with "\n\n", valid JSON |
| generateId produces unique prefixed IDs       | starts with prefix, 1000 IDs all unique            |
| OpenAPI spec generation includes agents       | spec has paths for /agents, /health                |

### 3. `src/__tests__/server-adapters/express-server.e2e.ts`

Uses `describeServerAdapter('Express', factory)`.
Factory: creates express app, registers CogitatorServer, calls `.listen(0)`.

### 4. `src/__tests__/server-adapters/fastify-server.e2e.ts`

Uses `describeServerAdapter('Fastify', factory)`.
Factory: creates Fastify instance, registers cogitatorPlugin, calls `.listen({port: 0})`.

### 5. `src/__tests__/server-adapters/hono-server.e2e.ts`

Uses `describeServerAdapter('Hono', factory)`.
Factory: creates Hono app via cogitatorApp, serves with @hono/node-server.

### 6. `src/__tests__/server-adapters/koa-server.e2e.ts`

Uses `describeServerAdapter('Koa', factory)`.
Factory: creates Koa app, uses cogitatorApp router, calls `.listen(0)`.

### 7. `src/__tests__/server-adapters/next-handlers.e2e.ts` (~3 tests)

Next.js handlers use standard Web API Request/Response. No Next.js runtime needed.

| Test                                    | Hard Assertions                                  | Needs Ollama |
| --------------------------------------- | ------------------------------------------------ | ------------ |
| createAgentHandler returns agent output | Response status 200, JSON body has output        | Yes          |
| createChatHandler streams SSE response  | Response is readable stream, contains text-delta | Yes          |
| handler returns error for invalid input | Response status 400 or error JSON                | No           |

### 8. `src/__tests__/openai-compat/openai-server.e2e.ts` (~6 tests)

Full HTTP flow against OpenAIServer (Fastify-based).

| Test                                | Hard Assertions                                              | Needs Ollama |
| ----------------------------------- | ------------------------------------------------------------ | ------------ |
| health endpoint                     | status 200                                                   | No           |
| GET /v1/models lists models         | status 200, data array has "cogitator" model                 | No           |
| create assistant + thread + message | 200 for each, IDs returned                                   | No           |
| create run and poll to completion   | run status transitions to completed, messages contain output | Yes          |
| list messages after run             | messages include assistant response                          | Yes          |
| unknown assistant returns error     | 404 or error response                                        | No           |

## Task Breakdown

### Task 1: Update infrastructure

- Add deps to package.json
- Run pnpm install
- Typecheck

### Task 2: Create server-test-utils.ts helper

- Shared `describeServerAdapter` function
- SSE parsing helper for streaming tests

### Task 3: server-shared protocol tests

- 4 tests for utilities

### Task 4: Express adapter tests

- Factory + describeServerAdapter call

### Task 5: Fastify adapter tests

### Task 6: Hono adapter tests

### Task 7: Koa adapter tests

### Task 8: Next.js handler tests

### Task 9: OpenAI compat tests

### Task 10: Finalize

- Update design doc Phase 3
- Update README
- Pre-commit script
- Commit

## Totals

- 8 new test files + 1 helper
- ~37 new tests (20 server adapter + 4 protocol + 3 next + 6 openai + ~4 edge cases)
- Grand total: ~107 tests across 28 files
