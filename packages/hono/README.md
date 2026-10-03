# @cogitator-ai/hono

Hono server adapter for Cogitator AI runtime. Works on **Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda** — anywhere Hono runs.

## Installation

```bash
pnpm add @cogitator-ai/hono @cogitator-ai/core hono
```

## Quick Start

```typescript
import { Hono } from 'hono';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { cogitatorApp } from '@cogitator-ai/hono';

const cogitator = new Cogitator({/* ... */});
const chatAgent = new Agent({ name: 'chat', instructions: 'You are a helpful assistant.' });

const app = new Hono();

const api = cogitatorApp({
  cogitator,
  agents: { chat: chatAgent },
});

app.route('/cogitator', api);

export default app;
```

## API

### `cogitatorApp(options)`

Creates a Hono sub-application with all Cogitator endpoints.

**Options:**

| Option            | Type                          | Description                                     |
| ----------------- | ----------------------------- | ----------------------------------------------- |
| `cogitator`       | `Cogitator`                   | **Required.** Cogitator runtime instance        |
| `agents`          | `Record<string, Agent>`       | Named agents to expose                          |
| `workflows`       | `Record<string, Workflow>`    | Named workflows                                 |
| `swarms`          | `Record<string, SwarmConfig>` | Named swarms                                    |
| `auth`            | `(c: Context) => AuthContext` | Authentication function (receives Hono Context) |
| `enableSwagger`   | `boolean`                     | Enable Swagger/OpenAPI docs                     |
| `swagger`         | `SwaggerConfig`               | Swagger configuration                           |
| `enableWebSocket` | `boolean`                     | Enable the WebSocket endpoint                   |
| `websocket`       | `WebSocketConfig`             | WebSocket configuration (see below)             |
| `bodyLimit`       | `number`                      | Max request body size in bytes (default 1 MiB)  |

## Request Handling

- Request bodies are validated before anything reaches the runtime: `input` must be a non-empty string, `context` an object, `threadId` a non-empty string, swarm `timeout` a positive number. Invalid bodies return `400 INVALID_INPUT` with the offending field in the message.
- Workflow runs accept an optional body. `options` is limited to `maxConcurrency`, `maxIterations` (positive integers) and `checkpoint` (boolean); any other option is dropped, and a wrongly typed one returns `400 INVALID_INPUT`.
- Thread messages accept `role` of `user`, `assistant` or `system`; `metadata` is stored with the entry and a token estimate is recorded.
- Bodies above `bodyLimit` return `413 PAYLOAD_TOO_LARGE`.
- `CogitatorError`s are returned with their HTTP status and code (for example `429 LLM_RATE_LIMITED`). Any other error is logged and returned as `500 Internal server error` without internal details. A workflow that finishes with an error is reported as an error, never as a successful result.
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

## Authentication

```typescript
const api = cogitatorApp({
  cogitator,
  agents: { chat: chatAgent },
  auth: async (c) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error('No token');
    return { userId: 'user-123' };
  },
});
```

### Multiple users

When `auth` returns a `userId`, everything a caller does with threads is scoped to it:

- Agent runs and streams pass the `userId` to `cogitator.run()`, so a thread created by a run belongs to that user and a `threadId` owned by someone else is refused.
- WebSocket runs use the `userId` that `auth` returned for the upgrade request, for the whole connection.
- `GET /threads/:id`, `POST /threads/:id/messages` and `DELETE /threads/:id` check the thread's owner first; `POST` to an unknown id creates the thread owned by the caller.
- Another user's thread answers `403` with code `THREAD_ACCESS_DENIED`, and its messages are neither returned nor changed.
- Threads created earlier without an owner (no `userId`) stay open only to callers without a `userId`, such as servers with no `auth` configured.

## Multi-Runtime

```typescript
// Node.js
import { serve } from '@hono/node-server';
serve(app, { port: 3000 });

// Bun
export default app;

// Cloudflare Workers
export default app;

// Deno
Deno.serve(app.fetch);
```

## SSE Streaming

The adapter uses Hono's built-in `streamSSE` for Server-Sent Events — no raw response manipulation needed. Works across all runtimes.

Agent streams emit `tool-call-start`, `tool-call-delta` (the JSON arguments) and `tool-call-end` with the provider's tool call id, so `tool-result.toolCallId` always matches the call it belongs to.

## WebSocket

WebSocket upgrades are runtime-specific in Hono, so pass the `upgradeWebSocket` helper of your runtime. The endpoint goes through the same middleware as the REST routes, including `auth`.

```typescript
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.route(
  '/cogitator',
  cogitatorApp({
    cogitator,
    agents: { chat: chatAgent },
    enableWebSocket: true,
    websocket: { path: '/ws', upgradeWebSocket, maxPayloadSize: 1024 * 1024 },
  })
);

const server = serve({ fetch: app.fetch, port: 3000 });
injectWebSocket(server);
```

On Bun use `upgradeWebSocket` from `hono/bun`, on Deno from `hono/deno`, on Cloudflare Workers from `hono/cloudflare-workers`. Without `upgradeWebSocket` the endpoint answers `501 UNIMPLEMENTED`.

**Protocol:**

| Client sends | Payload                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `run`        | `{ type: 'agent' \| 'workflow' \| 'swarm', name, input, context?, threadId? }` |
| `stop`       | Cancels the current run                                                        |
| `ping`       | Answered with `pong` (echoes `id`)                                             |

| Server sends | Description                                                                               |
| ------------ | ----------------------------------------------------------------------------------------- |
| `event`      | `token`, `tool-call`, `tool-result`, `complete` (with the serialized result), `cancelled` |
| `error`      | Invalid message, unknown resource, run already in progress, or a masked run failure       |
| `pong`       | Heartbeat reply                                                                           |

Messages larger than `maxPayloadSize` are rejected and the socket is closed with code `1009`. Closing the socket aborts the active run. `handleWebSocketMessage` and `createClientState` are exported for custom WebSocket integrations.

## Individual Route Access

```typescript
import {
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createWorkflowRoutes,
  createSwarmRoutes,
  createHealthRoutes,
  createSwaggerRoutes,
  createWebSocketRoutes,
  createContextMiddleware,
  createAuthMiddleware,
  createBodyLimitMiddleware,
  errorHandler,
} from '@cogitator-ai/hono';
```

## License

MIT
