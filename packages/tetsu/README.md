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

A run that waits on a slow tool or model can stay silent for longer than the `idleTimeout` of `Bun.serve` (10 seconds by default), after which Bun closes the connection. The controller keeps both kinds of answer open without any setting: the JSON routes (`run`, `resume`, workflow and swarm `run`) lift the idle timeout for their own request once its body is validated (`ctx.server.timeout(ctx.req, 0)`), and SSE streams write a heartbeat comment every `sseHeartbeatMs` (5 seconds by default). If you change `idleTimeout`, keep it above `sseHeartbeatMs` and at 5 seconds or more, since Bun cuts connections at once below that whatever is written.

## `cogitatorController(deps)`

A Tetsu controller named `Cogitator`: `operationId`s in the OpenAPI document are `cogitatorRunAgent`, `cogitatorGetThread` and so on.

| Option               | Type                                        | Description                                                                                                           |
| -------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `cogitator`          | `Cogitator`                                 | **Required.** The runtime                                                                                             |
| `agents`             | `Record<string, Agent>`                     | Agents by name                                                                                                        |
| `workflows`          | `Record<string, Workflow>`                  | Workflows by name                                                                                                     |
| `swarms`             | `Record<string, SwarmConfig>`               | Swarms by name                                                                                                        |
| `auth`               | `(ctx) => AuthContext \| undefined` or hook | Establishes the caller, see [Authentication](#authentication)                                                         |
| `authorizeThread`    | `(auth, threadId) => boolean`               | Decides who may use a memory thread, see [Users and threads](#users-and-threads)                                      |
| `websocket`          | `boolean \| { path?: string }`              | Serve the WebSocket endpoint (default path `/ws`)                                                                     |
| `until`              | `AbortSignal \| (() => AbortSignal)`        | Ends open streams and sockets, such as `draining` from `@tetsujs/lifecycle`                                           |
| `sseHeartbeatMs`     | `number`                                    | Heartbeat comment interval of SSE streams (default `5000`, `0` turns it off)                                          |
| `acceptContext`      | `boolean \| string[]`                       | Keys of a run `context` clients may send: none by default, a list, or `true` for any (it goes into the system prompt) |
| `threadMessageRoles` | `ThreadMessageRole[]`                       | Roles `POST /threads/:id/messages` accepts (default `user` and `assistant`)                                           |

## Endpoints

| Method   | Path                          | Description                             |
| -------- | ----------------------------- | --------------------------------------- |
| `GET`    | `/health`, `/ready`           | Liveness and readiness, without `auth`  |
| `GET`    | `/agents`                     | Agents with their description and tools |
| `POST`   | `/agents/:name/run`           | Run an agent and wait for the answer    |
| `POST`   | `/agents/:name/stream`        | Run an agent over SSE                   |
| `POST`   | `/agents/:name/resume`        | Resume a run paused for approvals       |
| `POST`   | `/agents/:name/resume/stream` | Resume a paused run over SSE            |
| `GET`    | `/tools`                      | Tools of every agent, as JSON Schema    |
| `GET`    | `/threads/:id`                | Messages of a memory thread             |
| `POST`   | `/threads/:id/messages`       | Append a message                        |
| `DELETE` | `/threads/:id`                | Delete a thread                         |
| `GET`    | `/workflows`                  | Workflows with their nodes              |
| `POST`   | `/workflows/:name/run`        | Run a workflow                          |
| `POST`   | `/workflows/:name/stream`     | Run a workflow over SSE                 |
| `GET`    | `/swarms`                     | Swarms with their agents                |
| `POST`   | `/swarms/:name/run`           | Run a swarm                             |
| `POST`   | `/swarms/:name/stream`        | Run a swarm over SSE                    |
| `GET`    | `/swarms/:name/blackboard`    | Configured blackboard sections          |
| `GET`    | `/ws`                         | WebSocket, when `websocket` is set      |

Request bodies:

```typescript
// POST /agents/:name/run, /agents/:name/stream
{ input: string; context?: Record<string, unknown>; threadId?: string } // input and threadId must contain more than whitespace

// POST /agents/:name/resume, /agents/:name/resume/stream
{
  threadId: string;
  decisions?: Record<string, { approved: boolean; reason?: string }>; // by tool call id
  defaultDecision?: { approved: boolean; reason?: string };
}

// POST /swarms/:name/run, /swarms/:name/stream
{ input: string; context?: Record<string, unknown>; threadId?: string; timeout?: number } // timeout at most 2147483647 ms

// POST /workflows/:name/run, /workflows/:name/stream
{ input?: Record<string, unknown>; options?: { maxConcurrency?: number; maxIterations?: number; checkpoint?: false } }

// POST /threads/:id/messages
{ role: 'user' | 'assistant' | 'system'; content: string; metadata?: Record<string, unknown> } // system only with threadMessageRoles
```

The schemas are refined with the validators every Cogitator adapter shares (`@cogitator-ai/server-shared`), so Tetsu refuses the same bodies as Express, Fastify, Hono, Koa and Next, under its own `VALIDATION_FAILED` envelope. A run puts `context` into the system prompt and the model reads a `system` thread message as operator instructions, so both are refused unless the controller accepts them: `acceptContext` lists the `context` keys clients may send (or `true` for any), and `threadMessageRoles` the roles they may add (`user` and `assistant` by default). A body that is not JSON (`text/plain`, a form) is refused with `415 UNSUPPORTED_MEDIA_TYPE` before it is read, since browsers send those across origins without a CORS preflight. `options.checkpoint: true` is refused: the controller runs each workflow on a fresh executor and keeps no checkpoint store to resume from.

`POST /agents/:name/run` and `/resume` answer `{ output, threadId, usage, toolCalls, status, traceId }` plus, when they apply, `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached`: the same object as every other adapter, built by `toAgentRunResponse()` of `@cogitator-ai/server-shared`. It never carries the system prompt, the history, trace spans or the checkpoint of a paused run. Swarm routes close the swarm they build once the run ends, so a distributed swarm leaves no Redis connections behind, and `GET /swarms` lists every agent, a router and pipeline stages included.

## Errors

Every error is answered in Tetsu's envelope:

```json
{ "status": 404, "message": "Agent 'ghost' not found", "error": "AGENT_NOT_FOUND" }
```

| Status  | `error`                                                    | When                                                                                                                                          |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 400     | `MALFORMED_JSON`                                           | The body is not valid JSON                                                                                                                    |
| 401     | `UNAUTHORIZED`                                             | `auth` returned `undefined`, or threw something other than an `HttpError` (an expired token)                                                  |
| 403     | `THREAD_ACCESS_DENIED`                                     | The thread belongs to another user                                                                                                            |
| 403     | `THREAD_FORBIDDEN`                                         | `authorizeThread` refused the thread                                                                                                          |
| 404     | `AGENT_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `SWARM_NOT_FOUND` | No such name                                                                                                                                  |
| 409     | `BLACKBOARD_DISABLED`                                      | The swarm has no blackboard                                                                                                                   |
| 409     | `RUN_NOT_PAUSED`                                           | A resume named a thread without a paused run                                                                                                  |
| 413     | `BODY_TOO_LARGE`                                           | The body is over the application's body limit                                                                                                 |
| 415     | `UNSUPPORTED_MEDIA_TYPE`                                   | The body is not JSON (`text/plain`, a form)                                                                                                   |
| 499     | `CLIENT_CLOSED_REQUEST`                                    | The client left before a `/run` or `/resume` answer was ready                                                                                 |
| 422     | `VALIDATION_FAILED`                                        | The body or the path failed its schema, a `context` key or a thread message role the controller does not accept, `issues` lists every problem |
| 501     | `PACKAGE_NOT_INSTALLED`                                    | `@cogitator-ai/workflows` or `@cogitator-ai/swarms` is missing                                                                                |
| 503     | `MEMORY_NOT_CONFIGURED`                                    | A thread endpoint was called on a runtime with no `memory` config                                                                             |
| 4xx/5xx | the `CogitatorError` code                                  | The run failed, e.g. `429 LLM_RATE_LIMITED` with `Retry-After`                                                                                |
| 500     | `INTERNAL_SERVER_ERROR`                                    | Anything else, the detail goes to `reportError`, never to the client                                                                          |

Only a `CogitatorError` keeps its message and code. Any other error reaches the client only as a generic internal error: `500 INTERNAL_SERVER_ERROR` in JSON, and `Internal server error` in stream `error` events, WebSocket errors and the `error` field of workflow `node_error` and swarm `agent_error` events. Its text, which can carry connection strings or file paths, never leaves the server.

Every route mounts an `onError` hook made by `cogitatorErrors()`. Mount another on the application to answer `CogitatorError`s from your own routes the same way:

```typescript
import { cogitatorErrors } from '@cogitator-ai/tetsu';

createApp({ hooks: { onError: [cogitatorErrors()] }, routes });
```

## Authentication

`auth` runs as a `beforeParse` hook, so a refused request costs no body parsing. It receives the Tetsu context and returns the caller, or `undefined` to answer `401`. Any other error it throws or rejects with, such as a token that fails to verify, answers `401` too, never a `500`. Throw an `HttpError` to answer with another status. `/health` and `/ready` stay open for probes.

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

The caller's `userId` is passed to every run, so tools (`context.userId`) know who is asking, and runs and thread endpoints are scoped to the caller; see [Users and threads](#users-and-threads).

To have the OpenAPI document describe the scheme and the `401`, build the hook with `callerHook()` and wrap it in `secured()`. The same hook can guard your own routes, where the caller is `ctx.cogitatorAuth`:

```typescript
import { callerHook, cogitatorController } from '@cogitator-ai/tetsu';
import { controller, createApp, group, route } from '@tetsujs/core';
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

### Multiple users

A thread belongs to the user whose run or message created it, recorded as its `userId`. Runs and the thread endpoints only let that user in: another user's `threadId` answers `403 THREAD_ACCESS_DENIED` and leaves the thread untouched. Callers without a `userId` share the threads that have no owner, and cannot open an owned one.

- The thread endpoints use `cogitator.getMemory()`, which connects the configured memory adapter on first use, so they work on a fresh server before any agent has run.
- `GET` and `DELETE /threads/:id` check the owner first; a thread that does not exist yet reads as empty.
- `POST /threads/:id/messages` creates a missing thread owned by the caller.
- A run or stream on another user's thread is refused before the model is called; a stream ends with an `error` event carrying `THREAD_ACCESS_DENIED`.

So whenever several people share a server, have `auth` return a `userId`.

### `authorizeThread`

On top of ownership, `authorizeThread` is checked on the thread endpoints and on every run, stream and WebSocket run that names a `threadId`, before the model is called:

```typescript
cogitatorController({
  cogitator,
  agents: { chat },
  auth,
  authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}:`),
});
```

Use it for rules ownership does not express, such as thread ids your server hands out.

## Approvals

A tool with `requiresApproval` pauses the run before it executes. `POST /agents/:name/run` then answers with `status: 'paused'` and the calls waiting for a decision; the run's checkpoint stays on the server, stored by the runtime per thread:

```json
{
  "output": "Let me refund that.",
  "threadId": "thread_…",
  "status": "paused",
  "pendingApprovals": [
    {
      "toolCallId": "call_1",
      "toolName": "refund",
      "arguments": { "order": "A-1", "amount": 500 },
      "description": "Refund an order",
      "sideEffects": ["payment"]
    }
  ],
  "usage": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 },
  "toolCalls": []
}
```

A stream that pauses sends `{"type":"approval-required","threadId":"…","approvals":[…]}` right before `finish`. Continue with the decisions:

```bash
curl -X POST localhost:3000/cogitator/agents/support/resume \
  -H 'content-type: application/json' \
  -d '{ "threadId": "thread_…", "decisions": { "call_1": { "approved": true } } }'
```

Approved calls run, declined ones answer the model with the `reason`, and calls without a decision (and no `defaultDecision`) pause the run again. `/agents/:name/resume/stream` streams the rest of the run like `/stream`. Only the user the run belongs to can resume it (`403 THREAD_ACCESS_DENIED` otherwise; `authorizeThread` is checked too), and a thread without a paused run answers `409 RUN_NOT_PAUSED`. Over the WebSocket, send `{ type: 'resume', id?, payload: { name, threadId, decisions?, defaultDecision? } }`.

## Streaming

`/stream` endpoints answer with `text/event-stream` through `@tetsujs/sse`: keep-alive comments every `sseHeartbeatMs` (5 seconds by default, under the 10 second `idleTimeout` of `Bun.serve`), backpressure, and the run is aborted when the client goes away. Events follow the Cogitator stream protocol shared with the other adapters, one JSON object per `data:` line, ending with `data: [DONE]`:

```
data: {"type":"start","messageId":"msg_…","threadId":"thread_…"}
data: {"type":"text-start","id":"txt_1"}
data: {"type":"text-delta","id":"txt_1","delta":"Let me check."}
data: {"type":"text-end","id":"txt_1"}
data: {"type":"tool-call-start","id":"call_1","toolName":"get_weather"}
data: {"type":"tool-call-delta","id":"call_1","argsTextDelta":"{\"city\":\"Paris\"}"}
data: {"type":"tool-call-end","id":"call_1"}
data: {"type":"tool-result","id":"res_…","toolCallId":"call_1","result":"Sunny"}
data: {"type":"text-start","id":"txt_2"}
data: {"type":"text-delta","id":"txt_2","delta":"Sunny in Paris."}
data: {"type":"text-end","id":"txt_2"}
data: {"type":"finish","messageId":"msg_…","usage":{"inputTokens":12,"outputTokens":30,"totalTokens":42},"threadId":"thread_…","status":"completed"}
data: [DONE]
```

`start` names the run's thread: the `threadId` of the request, or the thread the controller opened for it, so a client that sent none continues the conversation with this one even if the stream breaks. `finish` repeats it with `status` and the other outcome fields of the JSON answer.

An agent with `reasoning: { summary: true }` also streams its reasoning summary as `reasoning-start`, `reasoning-delta` and `reasoning-end` events. A text or reasoning part opens with its first delta and is closed before a part of the other kind, a tool call or `finish`, so parts never overlap and text after a tool call starts a new part. An answer the model gave in one piece arrives as one text part before `finish`, and a resumed run that pauses again sends `approval-required` before `finish`. `POST /agents/:name/run` returns the summary as `reasoning`, and `usage` gains `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the provider reports them. The `finish` event of an agent stream carries the same `usage` as the JSON answer, these counts included.

A run that fails ends with `{"type":"error","message":"…","code":"…"}` instead of `finish`. A `CogitatorError` keeps its message and code, anything else is sent as `"message":"Internal server error","code":"INTERNAL_SERVER_ERROR"` and reported to the application's `reportError` with `source: "stream"`. Workflow streams send `workflow` events (`node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed`), swarm streams send `swarm` events (`agent_start`, `agent_complete`, `agent_error`, `message`, every event the swarm itself emits under its own name, such as `swarm:start` or `agent:message`, and `swarm_completed`).

Validation (`415`, `422`), `401`, `404` and the `403 THREAD_FORBIDDEN` of `authorizeThread` are answered as JSON before the stream opens. Whether the thread belongs to the caller is checked by the run itself, so another user's thread ends an open stream with an `error` event, `"code":"THREAD_ACCESS_DENIED"`, instead of `finish`.

## WebSocket

```typescript
cogitatorController({ cogitator, agents, auth, websocket: true });
```

The handshake runs `auth` like any route. Each socket runs one agent, workflow or swarm at a time; a `run` or `resume` sent while one is in progress gets an error with `code: 'RUN_IN_PROGRESS'`.

| Client sends                                                                                                  | Server answers                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: 'run', id?, payload: { type: 'agent' \| 'workflow' \| 'swarm', name, input, context?, threadId? } }` | `event` frames: `token`, `reasoning`, `tool-call`, `tool-result`, then `complete` with the result (for an agent, the JSON answer of `/run`), or `cancelled` |
| `{ type: 'resume', id?, payload: { name, threadId, decisions?, defaultDecision? } }`                          | the same frames for an agent run paused for [approvals](#approvals)                                                                                         |
| `{ type: 'stop' }`                                                                                            | cancels the current run                                                                                                                                     |
| `{ type: 'ping', id? }`                                                                                       | `{ type: 'pong', id }`                                                                                                                                      |

Errors arrive as `{ type: 'error', id, error, code }` and leave the socket open; an invalid frame gets `code: 'INVALID_MESSAGE'`, and an error that is not a `CogitatorError` is sent as `Internal server error` with `code: 'INTERNAL_SERVER_ERROR'`. Closing the socket cancels its run. Bun's server-level options such as `maxPayloadLength` are set where the app is served:

```typescript
Bun.serve({ ...app, websocket: { ...app.websocket, maxPayloadLength: 1024 * 1024 } });
```

## Shutdown

Streams and sockets can stay open for minutes. Pass the `draining` signal of `@tetsujs/lifecycle` so a stopping server ends them and clients reconnect to one that stays:

```typescript
import { onShutdownSignals } from '@tetsujs/lifecycle';

let shutdown: ReturnType<typeof onShutdownSignals> | undefined;

const app = createApp({
  routes: cogitatorController({ cogitator, agents, until: () => shutdown?.draining }),
});
const server = Bun.serve({ ...app });
shutdown = onShutdownSignals(server);
```

## OpenAPI

Request and response schemas are Zod, so `docs()` and `openapi()` from `@tetsujs/openapi` describe every route, the run failures a `CogitatorError` can produce, and the schemes of a `secured()` caller hook. SSE and WebSocket endpoints are documented by their description only, since OpenAPI cannot describe what follows the headers.

The request and response schemas (`RunBody`, `ResumeBody`, `AgentRunResponse`, `SocketMessage`, …) and their TypeScript types (`AgentRunRequest`, `AgentRunResponseBody`, `WebSocketClientMessage`, …) are exported for clients and your own routes, along with the error helpers `cogitatorErrorResponse()`, `cogitatorErrorStatus()` and `describeError()`.

## Testing

The package is tested with `bun test`: handlers called with `testCtx()`, and the full pipeline through `serve()` from `@tetsujs/core/testing`, including SSE, WebSocket and `assertDescribed()` checks against the OpenAPI document.

```bash
pnpm --filter @cogitator-ai/tetsu test
```

## Example

[`examples/integrations/08-tetsu-server.ts`](https://github.com/cogitator-ai/Cogitator-AI/blob/main/examples/integrations/08-tetsu-server.ts) — an app with its own users, its own MCP server for its domain tools, and an agent that acts for the signed-in user:

```bash
bun examples/integrations/08-tetsu-server.ts
```

## Documentation

Full guide: [cogitator.app/docs/server-adapters/tetsu](https://cogitator.app/docs/server-adapters/tetsu)

## License

MIT
