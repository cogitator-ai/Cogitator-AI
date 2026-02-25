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
  /* ... */
});
const chatAgent = new Agent({ name: 'chat', instructions: 'You are a helpful assistant.' });

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

| Option            | Type                            | Description                                    |
| ----------------- | ------------------------------- | ---------------------------------------------- |
| `cogitator`       | `Cogitator`                     | **Required.** Cogitator runtime instance       |
| `agents`          | `Record<string, Agent>`         | Named agents to expose                         |
| `workflows`       | `Record<string, Workflow>`      | Named workflows                                |
| `swarms`          | `Record<string, SwarmConfig>`   | Named swarms                                   |
| `auth`            | `(ctx: Context) => AuthContext` | Authentication function (receives Koa Context) |
| `enableSwagger`   | `boolean`                       | Enable Swagger/OpenAPI docs                    |
| `swagger`         | `SwaggerConfig`                 | Swagger configuration                          |
| `enableWebSocket` | `boolean`                       | Enable WebSocket support                       |
| `websocket`       | `WebSocketConfig`               | WebSocket configuration                        |

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

Requires the optional `ws` peer dependency. Supports agent, workflow, and swarm runs over a persistent connection.

```typescript
import { createServer } from 'http';
import { cogitatorApp, setupWebSocket } from '@cogitator-ai/koa';

const app = new Koa();
const router = cogitatorApp({ cogitator, agents, enableWebSocket: true });
app.use(router.routes());
app.use(router.allowedMethods());

const server = createServer(app.callback());
await setupWebSocket(
  server,
  { runtime: cogitator, agents, workflows: {}, swarms: {} },
  {
    path: '/ws',
    pingInterval: 30000,
  }
);

server.listen(3000);
```

**Message types:**

| Client sends | Description                       |
| ------------ | --------------------------------- |
| `run`        | Start an agent/workflow/swarm run |
| `stop`       | Cancel the current run            |
| `ping`       | Heartbeat ping                    |

| Server sends | Description                                     |
| ------------ | ----------------------------------------------- |
| `event`      | Stream event (token, tool-call, complete, etc.) |
| `error`      | Error response                                  |
| `pong`       | Heartbeat pong                                  |

## SSE Streaming

The adapter includes `KoaStreamWriter` for Server-Sent Events with structured event types (text deltas, tool calls, workflow/swarm events).

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
- **Body parser** — parses JSON for POST, PUT, PATCH requests (1 MB limit)
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
  WorkflowStatusResponse,
  AgentRunRequest,
  AgentRunResponse,
  SwarmRunResponse,
  ErrorResponse,
} from '@cogitator-ai/koa';
```

## License

MIT
