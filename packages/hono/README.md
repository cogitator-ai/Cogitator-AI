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
  llm: { providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } },
});
const chatAgent = new Agent({
  name: 'chat',
  model: 'openai/gpt-5.5',
  instructions: 'You are a helpful assistant.',
});

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

| Option               | Type                          | Description                                                                                                           |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `cogitator`          | `Cogitator`                   | **Required.** Cogitator runtime instance                                                                              |
| `agents`             | `Record<string, Agent>`       | Named agents to expose                                                                                                |
| `workflows`          | `Record<string, Workflow>`    | Named workflows                                                                                                       |
| `swarms`             | `Record<string, SwarmConfig>` | Named swarms                                                                                                          |
| `auth`               | `AuthFunction`                | `(c) => AuthContext \| undefined` (sync or async), receives the Hono Context; throw to answer `401 UNAUTHORIZED`      |
| `enableSwagger`      | `boolean`                     | Serve `/openapi.json` and Swagger UI at `/docs`                                                                       |
| `swagger`            | `SwaggerConfig`               | Swagger configuration                                                                                                 |
| `enableWebSocket`    | `boolean`                     | Enable the WebSocket endpoint                                                                                         |
| `websocket`          | `WebSocketConfig`             | `{ path?, maxPayloadSize?, upgradeWebSocket? }` (see below)                                                           |
| `bodyLimit`          | `number`                      | Max request body size in bytes (default 1 MiB)                                                                        |
| `sseHeartbeatMs`     | `number`                      | How often SSE streams write a `: keep-alive` comment while a run is silent (default `5000`, `0` turns it off)         |
| `acceptContext`      | `boolean \| string[]`         | Keys of a run `context` clients may send: none by default, a list, or `true` for any (it goes into the system prompt) |
| `threadMessageRoles` | `ThreadMessageRole[]`         | Roles `POST /threads/:id/messages` accepts (default `user` and `assistant`)                                           |

## Request Handling

- Request bodies are validated before anything reaches the runtime: `input` must contain more than whitespace (`""` and `"   "` are refused before the model is called), `context` an object, `threadId` a non-empty string, swarm `timeout` a positive number. Invalid bodies return `400 INVALID_INPUT` with the offending field in the message. The validator comes from `@cogitator-ai/server-shared`, so Express, Fastify, Hono and Koa refuse exactly the same bodies.
- The `usage` of a run answer carries `inputTokens`, `outputTokens` and `totalTokens`, plus `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, the same shape as every other adapter. The `finish` event of an agent stream carries the same `usage` (never the run's cost or duration).
- Workflow runs accept an optional body. `options` is limited to `maxConcurrency` and `maxIterations` (positive integers). Any other option is dropped and a wrongly typed one returns `400 INVALID_INPUT`. `checkpoint: true` is refused, since the server runs each workflow on a fresh executor and keeps no checkpoint store to resume from.
- Thread messages accept `role` of `user` or `assistant` (more with `threadMessageRoles`), `metadata` is stored with the entry and a token estimate is recorded.
- A run puts `context` into the system prompt, and the model reads a `system` thread message as operator instructions, so clients may set neither unless the server allows it: `acceptContext` lists the `context` keys clients may send (`true` accepts any key, for clients trusted like your own code), and `threadMessageRoles` the roles of `POST /threads/:id/messages` (`user` and `assistant` by default). Anything else is refused with `400 INVALID_INPUT`, over HTTP and WebSocket alike.
- A `POST` body that is not JSON (`text/plain`, a form) is refused with `415 UNSUPPORTED_MEDIA_TYPE` before it is parsed: browsers send those across origins without a CORS preflight.
- `POST /agents/:name/run` and `/resume` answer `toAgentRunResponse()` of `@cogitator-ai/server-shared`: `output`, `threadId`, `usage`, `toolCalls` (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply. The WebSocket `complete` event carries the same object, never the system prompt, the history, trace spans or a paused run's checkpoint.
- The `start` event of an agent stream names the run's thread (the request's `threadId`, or a new one), and `finish` repeats it with the run's outcome, so a client that sent no thread continues the conversation with this one.
- Swarm routes close each swarm they build once its run ends, so a distributed swarm leaves no Redis connections behind and its state expires. `GET /swarms` lists every agent, the router and pipeline stages included.
- Thread routes use `cogitator.getMemory()`, which connects the configured memory adapter on first use, so threads can be read on a fresh server before any agent has run. Only a `Cogitator` without `memory` configured answers `503 UNAVAILABLE`.
- Bodies above `bodyLimit` return `413 PAYLOAD_TOO_LARGE`.
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

## Multi-Runtime

```typescript
// Node.js
import { serve } from '@hono/node-server';
serve(app, { port: 3000 });

// Bun
Bun.serve({ fetch: app.fetch, port: 3000 });

// Cloudflare Workers
export default app;

// Deno
Deno.serve(app.fetch);
```

On Bun, `Bun.serve` closes a connection that stays silent for `idleTimeout` seconds (10 by default), and a run that waits on a slow tool or model is silent for longer. The adapter handles both kinds of answer: SSE streams write a heartbeat comment every `sseHeartbeatMs` (5 s by default, keep it under `idleTimeout`), and the JSON routes (`run`, `resume`, workflow and swarm `run`) lift the idle timeout for their own request once its body is read, through the server Bun hands to `fetch`. Serve the app with `fetch: app.fetch` (or `export default app`) so Hono receives that server. Keep `idleTimeout` at its default or above, since Bun cuts connections at once below 5 s whatever is written.

On Cloudflare Workers use a `compatibility_date` of 2026-08-04 or later (or the `nodejs_compat` flag); with database memory create the `Cogitator` per request, since Workers do not share connections between requests. Deno needs only `--allow-net` and `--allow-env`. Complete projects: [`09-deno-server.ts`](https://github.com/cogitator-ai/Cogitator-AI/blob/main/examples/integrations/09-deno-server.ts), [`10-cloudflare-worker`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/examples/integrations/10-cloudflare-worker). See also [cogitator.app/docs/deployment/edge](https://cogitator.app/docs/deployment/edge).

## SSE Streaming

The adapter uses Hono's built-in `streamSSE` for Server-Sent Events — no raw response manipulation needed. Works across all runtimes.

Agent streams emit `tool-call-start`, `tool-call-delta` (the JSON arguments) and `tool-call-end` with the provider's tool call id, so `tool-result.toolCallId` always matches the call it belongs to.

When the agent sets `reasoning: { summary: true }` and the provider returns a reasoning summary, agent streams also emit it as its own `reasoning-start`/`reasoning-delta`/`reasoning-end` part, closed before text or a tool call starts, so reasoning and text parts never interleave.

Workflow streams send `{ type: 'workflow', event, data }` (`node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed`); swarm streams send `{ type: 'swarm', event, data }` (`agent_start`, `agent_complete`, `agent_error`, `message`, the swarm's own events, `swarm_completed`). Every stream ends with `finish` and `data: [DONE]`, or with an `error` event.

While a stream is open, every `sseHeartbeatMs` (5 s by default) it also writes an SSE comment, `: keep-alive`, which SSE clients skip. It keeps a stream that waits on a slow tool or model from being closed by Bun's `idleTimeout` or by a proxy (nginx closes a connection silent for 60 s).

For custom routes, `HonoStreamWriter` wraps the stream of Hono's `streamSSE` and sends the same heartbeats (`new HonoStreamWriter(stream, { heartbeatMs })`, stopped by `close()`); its methods (`start`, `textDelta`, `toolCallStart`, `approvalRequired`, `workflowEvent`, `finish`, …) return promises:

```typescript
import { streamSSE } from 'hono/streaming';
import { HonoStreamWriter, generateId } from '@cogitator-ai/hono';

app.post('/custom/stream', (c) =>
  streamSSE(c, async (stream) => {
    const writer = new HonoStreamWriter(stream);
    const messageId = generateId('msg');
    const textId = generateId('txt');
    await writer.start(messageId);
    await writer.textStart(textId);
    await writer.textDelta(textId, 'Hello!');
    await writer.textEnd(textId);
    await writer.finish(messageId);
    writer.close();
  })
);
```

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
| `resume`     | `{ name, threadId, decisions?, defaultDecision? }` (resume a paused agent run) |
| `stop`       | Cancels the current run                                                        |
| `ping`       | Answered with `pong` (echoes `id`)                                             |

| Server sends | Description                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `event`      | `token`, `reasoning`, `tool-call`, `tool-result`, `complete` (with the serialized result), `cancelled` |
| `error`      | Invalid message, unknown resource, run already in progress, or a masked run failure                    |
| `pong`       | Heartbeat reply                                                                                        |

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

## Documentation

Full guide: [cogitator.app/docs/server-adapters/hono](https://cogitator.app/docs/server-adapters/hono). Tool approvals: [cogitator.app/docs/tools/approvals](https://cogitator.app/docs/tools/approvals).

## License

MIT
