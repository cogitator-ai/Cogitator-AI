# @cogitator-ai/tetsu

[Tetsu](https://tetsujs.com) adapter for the Cogitator AI runtime. The whole Cogitator HTTP API — agents, memory threads, workflows, swarms, SSE streams and a WebSocket — as one Tetsu controller, with Zod schemas that validate requests and responses and describe them in the OpenAPI document.

Tetsu runs on **Bun 1.4 or later**.

## Installation

```bash
bun add @cogitator-ai/tetsu @cogitator-ai/core @tetsujs/core @tetsujs/sse
```

`@cogitator-ai/workflows` and `@cogitator-ai/swarms` are optional: add them to serve the workflow and swarm endpoints. `@tetsujs/openapi` is optional too, for the generated document.

## Quick Start

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { cogitatorController } from '@cogitator-ai/tetsu';
import { createApp, group } from '@tetsujs/core';
import { docs } from '@tetsujs/openapi';

const cogitator = new Cogitator({
  llm: { defaultModel: 'google/gemini-3.5-flash-lite' },
  memory: { adapter: 'memory' },
});

const chat = new Agent({
  name: 'chat',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant.',
});

const app = createApp({
  routes: [
    group('/cogitator', { children: [cogitatorController({ cogitator, agents: { chat } })] }),
    docs({ info: { title: 'Agents', version: '1.0.0' } }),
  ],
});

Bun.serve({ ...app, port: 3000 });
```

```bash
curl -X POST http://localhost:3000/cogitator/agents/chat/run \
  -H 'Content-Type: application/json' -d '{"input": "Hello"}'
```

## `cogitatorController(deps)`

A Tetsu controller named `Cogitator`: `operationId`s in the OpenAPI document are `cogitatorRunAgent`, `cogitatorGetThread` and so on.

| Option            | Type                                        | Description                                                                      |
| ----------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `cogitator`       | `Cogitator`                                 | **Required.** The runtime                                                        |
| `agents`          | `Record<string, Agent>`                     | Agents by name                                                                   |
| `workflows`       | `Record<string, Workflow>`                  | Workflows by name                                                                |
| `swarms`          | `Record<string, SwarmConfig>`               | Swarms by name                                                                   |
| `auth`            | `(ctx) => AuthContext \| undefined` or hook | Establishes the caller; see [Authentication](#authentication)                    |
| `authorizeThread` | `(auth, threadId) => boolean`               | Decides who may use a memory thread; see [Users and threads](#users-and-threads) |
| `websocket`       | `boolean \| { path?: string }`              | Serve the WebSocket endpoint (default path `/ws`)                                |
| `until`           | `AbortSignal \| (() => AbortSignal)`        | Ends open streams and sockets, such as `draining` from `@tetsujs/lifecycle`      |

## Endpoints

| Method   | Path                       | Description                             |
| -------- | -------------------------- | --------------------------------------- |
| `GET`    | `/health`, `/ready`        | Liveness and readiness, without `auth`  |
| `GET`    | `/agents`                  | Agents with their description and tools |
| `POST`   | `/agents/:name/run`        | Run an agent and wait for the answer    |
| `POST`   | `/agents/:name/stream`     | Run an agent over SSE                   |
| `GET`    | `/tools`                   | Tools of every agent, as JSON Schema    |
| `GET`    | `/threads/:id`             | Messages of a memory thread             |
| `POST`   | `/threads/:id/messages`    | Append a message                        |
| `DELETE` | `/threads/:id`             | Delete a thread                         |
| `GET`    | `/workflows`               | Workflows with their nodes              |
| `POST`   | `/workflows/:name/run`     | Run a workflow                          |
| `POST`   | `/workflows/:name/stream`  | Run a workflow over SSE                 |
| `GET`    | `/swarms`                  | Swarms with their agents                |
| `POST`   | `/swarms/:name/run`        | Run a swarm                             |
| `POST`   | `/swarms/:name/stream`     | Run a swarm over SSE                    |
| `GET`    | `/swarms/:name/blackboard` | Configured blackboard sections          |
| `GET`    | `/ws`                      | WebSocket, when `websocket` is set      |

Request bodies:

```typescript
// POST /agents/:name/run, /agents/:name/stream
{ input: string; context?: Record<string, unknown>; threadId?: string }

// POST /swarms/:name/run, /swarms/:name/stream
{ input: string; context?: Record<string, unknown>; threadId?: string; timeout?: number }

// POST /workflows/:name/run, /workflows/:name/stream
{ input?: Record<string, unknown>; options?: { maxConcurrency?: number; maxIterations?: number; checkpoint?: boolean } }

// POST /threads/:id/messages
{ role: 'user' | 'assistant' | 'system'; content: string; metadata?: Record<string, unknown> }
```

## Errors

Every error is answered in Tetsu's envelope:

```json
{ "status": 404, "message": "Agent 'ghost' not found", "error": "AGENT_NOT_FOUND" }
```

| Status  | `error`                                                    | When                                                                 |
| ------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 401     | `UNAUTHORIZED`                                             | `auth` returned `undefined`                                          |
| 403     | `THREAD_FORBIDDEN`                                         | `authorizeThread` refused the thread                                 |
| 404     | `AGENT_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `SWARM_NOT_FOUND` | No such name                                                         |
| 409     | `BLACKBOARD_DISABLED`                                      | The swarm has no blackboard                                          |
| 422     | `VALIDATION_FAILED`                                        | The body or the path failed its schema; `issues` lists every problem |
| 501     | `PACKAGE_NOT_INSTALLED`                                    | `@cogitator-ai/workflows` or `@cogitator-ai/swarms` is missing       |
| 503     | `MEMORY_NOT_CONFIGURED`                                    | A thread endpoint was called on a runtime without memory             |
| 4xx/5xx | the `CogitatorError` code                                  | The run failed, e.g. `429 LLM_RATE_LIMITED` with `Retry-After`       |
| 500     | `INTERNAL_SERVER_ERROR`                                    | Anything else; the detail goes to `reportError`, never to the client |

Every route mounts an `onError` hook made by `cogitatorErrors()`. Mount another on the application to answer `CogitatorError`s from your own routes the same way:

```typescript
import { cogitatorErrors } from '@cogitator-ai/tetsu';

createApp({ hooks: { onError: [cogitatorErrors()] }, routes });
```

## Authentication

`auth` runs as a `beforeParse` hook, so a refused request costs no body parsing. It receives the Tetsu context and returns the caller, or `undefined` to answer `401`. Throw an `HttpError` to answer with another status. `/health` and `/ready` stay open for probes.

```typescript
cogitatorController({
  cogitator,
  agents: { chat },
  auth: (ctx) => {
    const token = ctx.req.headers.get('authorization')?.replace(/^Bearer /, '');
    const user = token ? sessions.find(token) : undefined;
    return user && { userId: user.id, roles: user.roles };
  },
});
```

The caller's `userId` is passed to every run, so memory, cost tracking and tools (`context.userId`) know who is asking.

To have the OpenAPI document describe the scheme and the `401`, build the hook with `callerHook()` and wrap it in `secured()`. The same hook can guard your own routes, where the caller is `ctx.cogitatorAuth`:

```typescript
import { callerHook, cogitatorController } from '@cogitator-ai/tetsu';
import { secured } from '@tetsujs/openapi';

const signedIn = secured(callerHook(authenticate), {
  name: 'bearerAuth',
  scheme: { type: 'http', scheme: 'bearer' },
  error: 'UNAUTHORIZED',
});

const me = controller('Me', () => ({
  profile: route({
    method: 'GET',
    path: '/me',
    hooks: { beforeParse: [signedIn] },
    handler: (ctx) => profiles.get(ctx.cogitatorAuth?.userId ?? ''),
  }),
}));

createApp({
  routes: [
    me(),
    group('/agent', { children: [cogitatorController({ cogitator, agents, auth: signedIn })] }),
  ],
});
```

## Users and threads

`authorizeThread` is checked on the thread endpoints and on every run, stream and WebSocket run that names a `threadId`, before the model is called:

```typescript
cogitatorController({
  cogitator,
  agents: { chat },
  auth,
  authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}:`),
});
```

Without it, any caller that passes `auth` may read and write any thread.

## Streaming

`/stream` endpoints answer with `text/event-stream` through `@tetsujs/sse`: keep-alive comments every 15 seconds, backpressure, and the run is aborted when the client goes away. Events follow the Cogitator stream protocol shared with the other adapters, one JSON object per `data:` line, ending with `data: [DONE]`:

```
data: {"type":"start","messageId":"msg_…"}
data: {"type":"text-start","id":"txt_…"}
data: {"type":"text-delta","id":"txt_…","delta":"Hel"}
data: {"type":"tool-call-start","id":"call_1","toolName":"get_weather"}
data: {"type":"tool-call-delta","id":"call_1","argsTextDelta":"{\"city\":\"Paris\"}"}
data: {"type":"tool-call-end","id":"call_1"}
data: {"type":"tool-result","id":"res_…","toolCallId":"call_1","result":"Sunny"}
data: {"type":"text-end","id":"txt_…"}
data: {"type":"finish","messageId":"msg_…","usage":{"inputTokens":12,"outputTokens":30,"totalTokens":42}}
data: [DONE]
```

A run that fails ends with `{"type":"error","message":"…","code":"…"}` instead of `finish`. An unexpected failure is also reported to the application's `reportError` with `source: "stream"`. Workflow streams send `workflow` events (`node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed`), swarm streams send `swarm` events (`agent_start`, `agent_complete`, `agent_error`, `message`, `swarm_completed`).

Validation, `401`, `403` and `404` are answered as JSON before the stream opens.

## WebSocket

```typescript
cogitatorController({ cogitator, agents, auth, websocket: true });
```

The handshake runs `auth` like any route. Each socket runs one agent, workflow or swarm at a time.

| Client sends                                                                                                  | Server answers                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `{ type: 'run', id?, payload: { type: 'agent' \| 'workflow' \| 'swarm', name, input, context?, threadId? } }` | `event` frames: `token`, `tool-call`, `tool-result`, then `complete` with the result, or `cancelled` |
| `{ type: 'stop' }`                                                                                            | cancels the current run                                                                              |
| `{ type: 'ping', id? }`                                                                                       | `{ type: 'pong', id }`                                                                               |

Errors arrive as `{ type: 'error', id, error, code }` and leave the socket open; an invalid frame gets `code: 'INVALID_MESSAGE'`. Closing the socket cancels its run. Bun's server-level options such as `maxPayloadLength` are set where the app is served:

```typescript
Bun.serve({ ...app, websocket: { ...app.websocket, maxPayloadLength: 1024 * 1024 } });
```

## Shutdown

Streams and sockets can stay open for minutes. Pass the `draining` signal of `@tetsujs/lifecycle` so a stopping server ends them and clients reconnect to one that stays:

```typescript
let shutdown: ReturnType<typeof onShutdownSignals> | undefined;

const app = createApp({
  routes: cogitatorController({ cogitator, agents, until: () => shutdown?.draining }),
});
const server = Bun.serve({ ...app });
shutdown = onShutdownSignals(server);
```

## OpenAPI

Request and response schemas are Zod, so `docs()` and `openapi()` from `@tetsujs/openapi` describe every route, the run failures a `CogitatorError` can produce, and the schemes of a `secured()` caller hook. SSE and WebSocket endpoints are documented by their description only, since OpenAPI cannot describe what follows the headers.

## Testing

The package is tested with `bun test`: handlers called with `testCtx()`, and the full pipeline through `serve()` from `@tetsujs/core/testing`, including SSE, WebSocket and `assertDescribed()` checks against the OpenAPI document.

```bash
pnpm --filter @cogitator-ai/tetsu test
```

## Example

[`examples/integrations/08-tetsu-server.ts`](../../examples/integrations/08-tetsu-server.ts) — an app with its own users, its own MCP server for its domain tools, and an agent that acts for the signed-in user:

```bash
bun examples/integrations/08-tetsu-server.ts
```

## License

MIT
