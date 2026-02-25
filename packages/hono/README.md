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

const cogitator = new Cogitator({
  /* ... */
});
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
| `enableWebSocket` | `boolean`                     | Enable WebSocket support                        |
| `websocket`       | `WebSocketConfig`             | WebSocket configuration                         |

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

## Individual Route Access

```typescript
import {
  createAgentRoutes,
  createThreadRoutes,
  createToolRoutes,
  createHealthRoutes,
} from '@cogitator-ai/hono';
```

## License

MIT
