# @cogitator-ai/koa

Koa server adapter for Cogitator AI runtime. Exposes agents, workflows, swarms, and threads as a REST API with SSE streaming and WebSocket support.

## Installation

```bash
pnpm add @cogitator-ai/koa @cogitator-ai/core koa @koa/router
```

## Quick Start

```typescript
import Koa from 'koa';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/koa';

const cogitator = new Cogitator({
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const chatAgent = new Agent({
  name: 'chat',
  model: 'openai/gpt-5.5',
  instructions: 'You are a helpful assistant.',
});

const app = new Koa();

const router = cogitatorApp({
  cogitator,
  agents: { chat: chatAgent },
});

app.use(router.routes());
app.use(router.allowedMethods());

app.listen(3000);
```

## API

### `cogitatorApp(options)`

Creates a Koa Router with all Cogitator endpoints.

**Options:**

| Option               | Type                          | Description                                                                                                           |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `cogitator`          | `Cogitator`                   | **Required.** Cogitator runtime instance                                                                              |
| `agents`             | `Record<string, Agent>`       | Named agents to expose                                                                                                |
| `workflows`          | `Record<string, Workflow>`    | Named workflows                                                                                                       |
| `swarms`             | `Record<string, SwarmConfig>` | Named swarms                                                                                                          |
| `auth`               | `AuthFunction`                | `(ctx) => AuthContext \| undefined` (sync or async), receives the Koa Context; throw to answer `401 UNAUTHORIZED`     |
| `enableSwagger`      | `boolean`                     | Serve `/openapi.json` and Swagger UI at `/docs`                                                                       |
| `swagger`            | `SwaggerConfig`               | Swagger configuration                                                                                                 |
| `bodyLimit`          | `number`                      | Max JSON body size in bytes (default 1 MiB)                                                                           |
| `sseHeartbeatMs`     | `number`                      | How often SSE streams write a `: keep-alive` comment while a run is silent (default `5000`, `0` turns it off)         |
| `acceptContext`      | `boolean \| string[]`         | Keys of a run `context` clients may send: none by default, a list, or `true` for any (it goes into the system prompt) |
| `threadMessageRoles` | `ThreadMessageRole[]`         | Roles `POST /threads/:id/messages` accepts (default `user` and `assistant`)                                           |

WebSocket support is attached to the HTTP server with [`setupWebSocket`](#websocket), not through router options.

## Request Handling

- Request bodies are validated before anything reaches the runtime: `input` must contain more than whitespace (`""` and `"   "` are refused before the model is called), `context` an object, `threadId` a non-empty string, swarm `timeout` a positive number. Invalid bodies return `400 INVALID_INPUT` with the offending field in the message. The validator comes from `@cogitator-ai/server-shared`, so Express, Fastify, Hono and Koa refuse exactly the same bodies.
- The `usage` of a run answer carries `inputTokens`, `outputTokens` and `totalTokens`, plus `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, the same shape as every other adapter. The `finish` event of an agent stream carries the same `usage` (never the run's cost or duration).
- While an SSE stream is open it writes a `: keep-alive` comment every `sseHeartbeatMs` (5 s by default, `0` turns it off), which SSE clients skip, so a proxy or load balancer does not close a stream that waits on a slow tool or model (nginx closes a connection silent for 60 s).
- Workflow runs accept an optional body. `options` is limited to `maxConcurrency` and `maxIterations` (positive integers). Any other option is dropped and a wrongly typed one returns `400 INVALID_INPUT`. `checkpoint: true` is refused, since the server runs each workflow on a fresh executor and keeps no checkpoint store to resume from.
- Thread messages accept `role` of `user` or `assistant` (more with `threadMessageRoles`), `metadata` is stored with the entry and a token estimate is recorded.
- A run puts `context` into the system prompt, and the model reads a `system` thread message as operator instructions, so clients may set neither unless the server allows it: `acceptContext` lists the `context` keys clients may send (`true` accepts any key, for clients trusted like your own code), and `threadMessageRoles` the roles of `POST /threads/:id/messages` (`user` and `assistant` by default). Anything else is refused with `400 INVALID_INPUT`, over HTTP and WebSocket alike.
- A `POST` body that is not JSON (`text/plain`, a form) is refused with `415 UNSUPPORTED_MEDIA_TYPE` before it is parsed: browsers send those across origins without a CORS preflight.
- `POST /agents/:name/run` and `/resume` answer `toAgentRunResponse()` of `@cogitator-ai/server-shared`: `output`, `threadId`, `usage`, `toolCalls` (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply. The WebSocket `complete` event carries the same object, never the system prompt, the history, trace spans or a paused run's checkpoint.
- The `start` event of an agent stream names the run's thread (the request's `threadId`, or a new one), and `finish` repeats it with the run's outcome, so a client that sent no thread continues the conversation with this one.
- Swarm routes close each swarm they build once its run ends, so a distributed swarm leaves no Redis connections behind and its state expires. `GET /swarms` lists every agent, the router and pipeline stages included.
- Thread routes use `cogitator.getMemory()`, which connects the configured memory adapter on first use, so threads can be read on a fresh server before any agent has run. Only a `Cogitator` without `memory` configured answers `503 UNAVAILABLE`.
- `CogitatorError`s are returned with their HTTP status and code (for example `429 LLM_RATE_LIMITED`). Any other error is logged and returned as `500 Internal server error` (code `INTERNAL_ERROR`) without internal details; the same masking applies to SSE `error` events, `node_error`/`agent_error` stream events and WebSocket errors. A workflow that finishes with an error is answered like a thrown error (its `CogitatorError` status, otherwise `500`), never as a successful result. Missing optional packages (`@cogitator-ai/workflows`, `@cogitator-ai/swarms`) answer `501 UNIMPLEMENTED`.
- When the client disconnects, the running agent, workflow or swarm is aborted, for both JSON and SSE endpoints.
- `GET /agents` returns each agent's `description` and never exposes its `instructions`.
- `GET /tools` returns tool parameters as JSON Schema.

## Endpoints

### Agents

| Method | Path                   | Description               |
| ------ | ---------------------- | ------------------------- |
| `GET`  | `/agents`              | List all agents           |
| `POST` | `/agents/:name/run`    | Run agent (JSON response) |
| `POST` | `/agents/:name/stream` | Run agent (SSE stream)    |
| `POST` | `/agents/:name/resume` | Resume a paused run       |

### Threads (Memory)

| Method   | Path                    | Description           |
| -------- | ----------------------- | --------------------- |
| `GET`    | `/threads/:id`          | Get thread messages   |
| `POST`   | `/threads/:id/messages` | Add message to thread |
| `DELETE` | `/threads/:id`          | Delete thread         |

### Workflows

| Method | Path                      | Description            |
| ------ | ------------------------- | ---------------------- |
| `GET`  | `/workflows`              | List workflows         |
| `POST` | `/workflows/:name/run`    | Execute workflow       |
| `POST` | `/workflows/:name/stream` | Stream workflow events |

### Swarms

| Method | Path                       | Description           |
| ------ | -------------------------- | --------------------- |
| `GET`  | `/swarms`                  | List swarms           |
| `POST` | `/swarms/:name/run`        | Run swarm             |
| `POST` | `/swarms/:name/stream`     | Stream swarm progress |
| `GET`  | `/swarms/:name/blackboard` | Get shared state      |

### Tools & Health

| Method | Path      | Description     |
| ------ | --------- | --------------- |
| `GET`  | `/tools`  | List all tools  |
| `GET`  | `/health` | Health check    |
| `GET`  | `/ready`  | Readiness check |

### Docs (`enableSwagger: true`)

| Method | Path            | Description  |
| ------ | --------------- | ------------ |
| `GET`  | `/openapi.json` | OpenAPI spec |
| `GET`  | `/docs`         | Swagger UI   |

## Authentication

```typescript
const router = cogitatorApp({
  cogitator,
  agents: { chat: chatAgent },
  auth: async (ctx) => {
    const token = ctx.get('authorization')?.replace('Bearer ', '');
    if (!token) throw new Error('No token');
    return { userId: 'user-123', roles: ['admin'] };
  },
});
```

An error thrown with a `status` of 500 or more is treated as a server failure (`500 Internal server error`) instead of a rejected caller.

### Multiple users

When `auth` returns a `userId`, everything a caller does with threads is scoped to it:

- Agent runs and streams pass the `userId` to `cogitator.run()`, so a thread created by a run belongs to that user and a `threadId` owned by someone else is refused.
- WebSocket runs use the `userId` returned by the `auth` passed to `setupWebSocket` for the upgrade request, for the whole connection.
- `GET /threads/:id`, `POST /threads/:id/messages` and `DELETE /threads/:id` check the thread's owner first; `POST` to an unknown id creates the thread owned by the caller.
- Another user's thread answers `403` with code `THREAD_ACCESS_DENIED`, and its messages are neither returned nor changed.
- Threads created earlier without an owner (no `userId`) stay open only to callers without a `userId`, such as servers with no `auth` configured.

### Approvals

A tool with `requiresApproval` (`true`, or a function of the arguments) pauses the run before that turn executes:

1. `POST /agents/:name/run` answers with `status: 'paused'` and `pendingApprovals` (`{ toolCallId, toolName, arguments, description, sideEffects? }`); finished runs carry `status: 'completed'`. The run's checkpoint stays on the server and is never sent to the client.
2. `POST /agents/:name/stream` emits `{ type: 'approval-required', threadId, approvals }` right before `finish`.
3. The client shows the pending calls and sends the answers to `POST /agents/:name/resume`:

```typescript
await fetch('/agents/support/resume', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    threadId,
    decisions: { [toolCallId]: { approved: true } },
    defaultDecision: { approved: false, reason: 'Not approved' },
  }),
});
```

The body is `{ threadId, decisions?, defaultDecision? }`, where a decision is `{ approved: boolean, reason?: string }`; malformed bodies get `400 INVALID_INPUT`. The response has the same shape as `/run` and may pause again for calls left without a decision. The run resumes as the authenticated `userId`: a thread with no paused run answers `409 RUN_NOT_PAUSED`, and another user's paused run `403 THREAD_ACCESS_DENIED`. Over WebSocket, send `resume` with `{ name, threadId, decisions?, defaultDecision? }`; a paused run's `complete` event carries `status` and `pendingApprovals`.

## Route Prefix

```typescript
import Koa from 'koa';
import Router from '@koa/router';
import { cogitatorApp } from '@cogitator-ai/koa';

const app = new Koa();
const main = new Router();
const api = cogitatorApp({ cogitator, agents });

main.use('/api/v1', api.routes(), api.allowedMethods());
app.use(main.routes());
```

## WebSocket

Requires the optional `ws` dependency. Supports agent, workflow, and swarm runs over a persistent connection.

```typescript
import { createServer } from 'http';
import { cogitatorApp, setupWebSocket } from '@cogitator-ai/koa';

const app = new Koa();
const router = cogitatorApp({ cogitator, agents });
app.use(router.routes());
app.use(router.allowedMethods());

const server = createServer(app.callback());
await setupWebSocket(
  server,
  { runtime: cogitator, agents, workflows: {}, swarms: {} },
  {
    path: '/ws',
    pingInterval: 30000,
    pingTimeout: 10000,
    maxPayloadSize: 1024 * 1024,
    auth: (req) => {
      if (req.headers.authorization !== `Bearer ${process.env.API_TOKEN}`) {
        throw new Error('Unauthorized');
      }
      return { userId: 'api' };
    },
  }
);

server.listen(3000);
```

The router's `auth` option does not cover WebSocket connections, so pass `auth` to `setupWebSocket` to protect them: it receives the upgrade `IncomingMessage`, and throwing rejects the handshake with `401` (or `500` when the error carries a `status >= 500`). Upgrades on other paths are left to other `upgrade` listeners (or rejected with `404` when there are none), so the socket can share the HTTP server with other WebSocket servers. A client that does not answer a ping within `pingTimeout` (defaults to `pingInterval`) is terminated, and closing a connection aborts its active run.

**Message types:**

| Client sends | Payload                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `run`        | `{ type: 'agent' \| 'workflow' \| 'swarm', name, input, context?, threadId? }` |
| `resume`     | `{ name, threadId, decisions?, defaultDecision? }` (resume a paused agent run) |
| `stop`       | Cancels the current run                                                        |
| `ping`       | Answered with `pong` (echoes `id`)                                             |

| Server sends | Description                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `event`      | `token`, `reasoning`, `tool-call`, `tool-result`, `complete` (with the serialized result), `cancelled` |
| `error`      | Invalid message, unknown resource, run already in progress, or a masked run failure                    |
| `pong`       | Heartbeat reply                                                                                        |

## SSE Streaming

The adapter includes `KoaStreamWriter` for Server-Sent Events with structured event types (text deltas, tool calls, approvals, workflow/swarm events). Workflow streams send `{ type: 'workflow', event, data }` (`node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed`); swarm streams send `{ type: 'swarm', event, data }` (`agent_start`, `agent_complete`, `agent_error`, `message`, the swarm's own events, `swarm_completed`). Every stream ends with `finish` and `data: [DONE]`, or with an `error` event. Agent streams emit `tool-call-start`, `tool-call-delta` (the JSON arguments) and `tool-call-end` with the provider's tool call id, so `tool-result.toolCallId` always matches the call it belongs to.

When the agent sets `reasoning: { summary: true }` and the provider returns a reasoning summary, agent streams also emit it as its own `reasoning-start`/`reasoning-delta`/`reasoning-end` part, closed before text or a tool call starts, so reasoning and text parts never interleave.

For custom routes, call `setupSSEHeaders(ctx)` (it sets `ctx.respond = false`) and write through a `KoaStreamWriter`:

```typescript
import Router from '@koa/router';
import { KoaStreamWriter, setupSSEHeaders, generateId } from '@cogitator-ai/koa';

const custom = new Router();

custom.post('/custom/stream', (ctx) => {
  setupSSEHeaders(ctx);
  const writer = new KoaStreamWriter(ctx);
  const messageId = generateId('msg');
  const textId = generateId('txt');
  writer.start(messageId);
  writer.textStart(textId);
  writer.textDelta(textId, 'Hello!');
  writer.textEnd(textId);
  writer.finish(messageId);
  writer.close();
});
```

## Event Factories

Re-exported from `@cogitator-ai/server-shared` for custom stream handling:

```typescript
import {
  createStartEvent,
  createTextDeltaEvent,
  createToolCallStartEvent,
  createFinishEvent,
  createWorkflowEvent,
  createSwarmEvent,
} from '@cogitator-ai/koa';
```

## Individual Route Builders

Each route group is available as a standalone factory for custom composition:

```typescript
import {
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
  createHealthRoutes,
  createSwaggerRoutes,
} from '@cogitator-ai/koa';
```

## Middleware

Built-in middleware stack (applied automatically by `cogitatorApp`):

- **Error handler** — catches errors and returns structured `ErrorResponse`
- **Body parser** — parses JSON for POST, PUT, PATCH requests (`bodyLimit`, 1 MiB by default, returns `413` above it). A body already parsed by upstream middleware such as `koa-bodyparser` is reused
- **Context** — injects `RouteContext` with `runtime`, `agents`, `workflows`, `swarms` into Koa state
- **Auth** — optional authentication via the `auth` callback

## Key Types

```typescript
import type {
  RouteContext, // { runtime, agents, workflows, swarms }
  CogitatorAppOptions,
  AuthContext,
  AuthFunction,
  WebSocketConfig,
  WebSocketAuthFunction,
  WebSocketRunPayload,
  BodyParserOptions,
  WorkflowStatusResponse,
  AgentRunRequest,
  AgentRunResponse,
  SwarmRunResponse,
  ErrorResponse,
} from '@cogitator-ai/koa';
```

## Documentation

Full guide: [cogitator.app/docs/server-adapters/koa](https://cogitator.app/docs/server-adapters/koa). Tool approvals: [cogitator.app/docs/tools/approvals](https://cogitator.app/docs/tools/approvals).

## License

MIT
