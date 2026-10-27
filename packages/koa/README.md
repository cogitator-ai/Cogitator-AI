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

app.listen(3000);
```

## API

### `cogitatorApp(options)`

Creates a Koa Router with all Cogitator endpoints.

**Options:**

| Option                | Type                                              | Description                                                                                                                                                      |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cogitator`           | `Cogitator`                                       | **Required.** Cogitator runtime instance                                                                                                                         |
| `agents`              | `Record<string, Agent>`                           | Named agents to expose                                                                                                                                           |
| `workflows`           | `Record<string, Workflow>`                        | Named workflows                                                                                                                                                  |
| `swarms`              | `Record<string, SwarmConfig>`                     | Named swarms                                                                                                                                                     |
| `auth`                | `AuthFunction`                                    | `(ctx) => AuthContext \| undefined` (sync or async), receives the Koa Context, throw to answer `401 UNAUTHORIZED`                                                |
| `enableSwagger`       | `boolean`                                         | Serve `/openapi.json` and Swagger UI at `/docs`                                                                                                                  |
| `swagger`             | `SwaggerConfig`                                   | Swagger configuration                                                                                                                                            |
| `bodyLimit`           | `number`                                          | Max JSON body size in bytes (default 1 MiB)                                                                                                                      |
| `sseHeartbeatMs`      | `number`                                          | How often SSE streams write a `: keep-alive` comment while a run is silent (default `5000`, `0` turns it off)                                                    |
| `resumableStreams`    | `boolean \| ResumableStreamOptions`               | Keep the streams of agent runs so a client that loses one reconnects with `Last-Event-ID`, see [Resumable streams](#resumable-streams). Off by default           |
| `acceptContext`       | `boolean \| string[]`                             | Keys of a run `context` clients may send: none by default, a list, or `true` for any (the model reads it as data from the application)                           |
| `threadMessageRoles`  | `ThreadMessageRole[]`                             | Roles `POST /threads/:id/messages` accepts (default `user` and `assistant`)                                                                                      |
| `limits`              | `RunLimits`                                       | `{ swarmTimeout?, workflowMaxIterations?, workflowMaxConcurrency? }`: caps on what a request may ask a swarm or workflow run for (see [Run limits](#run-limits)) |
| `anonymous`           | `'allow' \| 'deny'`                               | Whether callers without a `userId` may use the API (default `'allow'`), `'deny'` answers `401 UNAUTHORIZED`                                                      |
| `authorizeThread`     | `(auth, threadId) => boolean \| Promise<boolean>` | Decides whether a caller may touch a thread, on top of the owner check, `false` answers `403 THREAD_FORBIDDEN`                                                   |
| `deps`                | `(ctx) => unknown \| Promise<unknown>`            | Builds the `deps` agent runs pass to their tools, from the Koa Context (see [Run deps](#run-deps))                                                               |
| `workflowCheckpoints` | `CheckpointStore`                                 | Where workflow runs keep their checkpoints, for `options.checkpoint` and `/resume` (see [Checkpoints and resume](#checkpoints-and-resume))                       |

WebSocket support is attached to the HTTP server with [`setupWebSocket`](#websocket), not through router options.

The router answers `OPTIONS` for its own paths with `204` and the methods they serve in `Allow`, so it needs no `router.allowedMethods()`. A CORS middleware (such as `@koa/cors`) goes before the router, so it answers preflight requests itself.

## Request Handling

- Request bodies are validated before anything reaches the runtime: `input` must contain more than whitespace (`""` and `"   "` are refused before the model is called), `context` an object, `threadId` a non-empty string, `multitaskStrategy` one of `enqueue`, `reject`, `interrupt` and `rollback`, swarm `timeout` a positive number. Invalid bodies return `400 INVALID_INPUT` with the offending field in the message. The validator comes from `@cogitator-ai/server-shared`, so Express, Fastify, Hono and Koa refuse exactly the same bodies.
- The `usage` of a run answer carries `inputTokens`, `outputTokens` and `totalTokens`, plus `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, the same shape as every other adapter. The `finish` event of an agent stream carries the same `usage` (never the run's cost or duration).
- While an SSE stream is open it writes a `: keep-alive` comment every `sseHeartbeatMs` (5 s by default, `0` turns it off), which SSE clients skip, so a proxy or load balancer does not close a stream that waits on a slow tool or model (nginx closes a connection silent for 60 s).
- Workflow runs accept an optional body. `options` is limited to `maxConcurrency`, `maxIterations` (positive integers) and `checkpoint`. Any other option is dropped and a wrongly typed one returns `400 INVALID_INPUT`. `checkpoint: true` is refused unless the app has `workflowCheckpoints` (see [Checkpoints and resume](#checkpoints-and-resume)).
- Thread messages accept `role` of `user` or `assistant` (more with `threadMessageRoles`), `metadata` is stored with the entry and a token estimate is recorded.
- A run sends `context` to the model as data the application supplied, and the model reads a `system` thread message as operator instructions, so clients may set neither unless the server allows it: `acceptContext` lists the `context` keys clients may send (`true` accepts any key, for clients trusted like your own code), and `threadMessageRoles` the roles of `POST /threads/:id/messages` (`user` and `assistant` by default). Anything else is refused with `400 INVALID_INPUT`, over HTTP and WebSocket alike.
- A `POST` body that is not JSON (`text/plain`, a form) is refused with `415 UNSUPPORTED_MEDIA_TYPE` before it is parsed: browsers send those across origins without a CORS preflight.
- `POST /agents/:name/run` and `/resume` answer `toAgentRunResponse()` of `@cogitator-ai/server-shared`: `output`, `threadId`, `usage`, `toolCalls` (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply. The WebSocket `complete` event carries the same object, never the system prompt, the history, trace spans or a paused run's checkpoint.
- The `start` event of an agent stream names the run's thread (the request's `threadId`, or a new one), and `finish` repeats it with the run's outcome, so a client that sent no thread continues the conversation with this one.
- Swarm routes close each swarm they build once its run ends, so a distributed swarm leaves no Redis connections behind and its state expires. `GET /swarms` lists every agent, the router and pipeline stages included.
- Thread routes use `cogitator.getMemory()`, which connects the configured memory adapter on first use, so threads can be read on a fresh server before any agent has run. Only a `Cogitator` without `memory` configured answers `503 UNAVAILABLE`.
- `GET /threads/:id` answers the whole thread, or one page of it with `?limit=50`: the newest 50 messages (oldest first within the page) and a `nextCursor`. Pass it back as `?limit=50&cursor=<nextCursor>` for the 50 before them, until an answer has no `nextCursor`. Messages written in the same millisecond are neither skipped nor repeated across pages. A `limit` outside 1 to 1000 or a cursor the server did not give answers `400 INVALID_INPUT`.
- Every error answer has the same envelope, `{ error: { message, code } }`, the one Express, Fastify, Hono and Next use. A `CogitatorError` is answered with its HTTP status and code (for example `429 LLM_RATE_LIMITED`), plus a `Retry-After` header in whole seconds when the provider said when to retry. A swarm that ran out of time answers `504 RUN_TIMEOUT`. Any other error is logged and answered as `500 Internal server error` (code `INTERNAL_ERROR`) without internal details, and the same masking applies to SSE `error` events, `node_error` and `agent_error` stream events and WebSocket errors. A workflow that finishes with an error is answered like a thrown error (its `CogitatorError` status, otherwise `500`), never as a successful result. Missing optional packages (`@cogitator-ai/workflows`, `@cogitator-ai/swarms`) answer `501 UNIMPLEMENTED`.
- When the client disconnects, the running agent, workflow or swarm is aborted, for both JSON and SSE endpoints.
- `GET /agents` returns each agent's `description` and never exposes its `instructions`.
- `GET /tools` returns tool parameters as JSON Schema.

## Endpoints

### Agents

| Method | Path                          | Description                      |
| ------ | ----------------------------- | -------------------------------- |
| `GET`  | `/agents`                     | List all agents                  |
| `POST` | `/agents/:name/run`           | Run agent (JSON response)        |
| `POST` | `/agents/:name/stream`        | Run agent (SSE stream)           |
| `POST` | `/agents/:name/resume`        | Resume a paused run              |
| `POST` | `/agents/:name/resume/stream` | Resume a paused run (SSE stream) |

### Threads (Memory)

| Method   | Path                    | Description                                      |
| -------- | ----------------------- | ------------------------------------------------ |
| `GET`    | `/threads/:id`          | Get thread messages, a page with `?limit&cursor` |
| `POST`   | `/threads/:id/messages` | Add message to thread                            |
| `DELETE` | `/threads/:id`          | Delete thread                                    |

### Workflows

| Method | Path                             | Description                       |
| ------ | -------------------------------- | --------------------------------- |
| `GET`  | `/workflows`                     | List workflows                    |
| `POST` | `/workflows/:name/run`           | Execute workflow                  |
| `POST` | `/workflows/:name/stream`        | Stream workflow events            |
| `POST` | `/workflows/:name/resume`        | Resume from a checkpoint          |
| `POST` | `/workflows/:name/resume/stream` | Resume and stream workflow events |

#### Checkpoints and resume

`workflowCheckpoints` takes any `CheckpointStore` of `@cogitator-ai/workflows`, such as `PostgresCheckpointStore` or `RedisCheckpointStore`. With it, a run with `options.checkpoint: true` saves its checkpoints there as the caller's, the `userId` that `auth` returned (none for an anonymous caller), and its answer and `workflow_completed` event carry the last one as `checkpointId`. Without it such a run is refused with `400 INVALID_INPUT`.

`POST /workflows/:name/resume` takes `{ checkpointId: string; options?: { maxConcurrency?: number; maxIterations?: number } }`, passes over the nodes the checkpoint completed and runs the rest. It answers like `/run`, and `/resume/stream` streams like `/stream`. The `limits` hold as on `/run`, and the resumed run keeps saving checkpoints, so it can be resumed again. A checkpoint that is missing, belongs to another user or to another workflow answers `404 CHECKPOINT_NOT_FOUND` before anything runs, on `/resume/stream` before the stream opens. Without `workflowCheckpoints` every resume answers `404 CHECKPOINT_NOT_FOUND`. A run that fails answers its error with the last checkpoint it saved as `checkpointId`, next to `code` and `message` (`{ error: { message, code, checkpointId } }`), and a failed stream sends a `workflow_failed` event with `{ checkpointId }` right before its `error` event, so the client resumes the failed run from there. A resume that fails again names the checkpoint to resume from, its own last one or, when it saved none, the one it started from.

```typescript
import { PostgresCheckpointStore } from '@cogitator-ai/workflows';

const api = cogitatorApp({
  cogitator,
  workflows: { shipping },
  auth,
  workflowCheckpoints: new PostgresCheckpointStore({ client: pool }),
});
```

### Swarms

| Method | Path                       | Description           |
| ------ | -------------------------- | --------------------- |
| `GET`  | `/swarms`                  | List swarms           |
| `POST` | `/swarms/:name/run`        | Run swarm             |
| `POST` | `/swarms/:name/stream`     | Stream swarm progress |
| `GET`  | `/swarms/:name/blackboard` | Get shared state      |

### Tools & Health

| Method | Path      | Description                          |
| ------ | --------- | ------------------------------------ |
| `GET`  | `/tools`  | List all tools                       |
| `GET`  | `/health` | Health check                         |
| `GET`  | `/ready`  | Readiness probe ({ status, checks }) |

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

### Anonymous callers

By default a caller without a `userId` (no `auth`, or `auth` returned none) may use the API as an anonymous user. With `anonymous: 'deny'` such a caller gets `401 UNAUTHORIZED` on every API route. `/health`, `/ready`, `/openapi.json` and `/docs` stay open, so probes and API docs keep working. A path under the router that nothing answers gets `401` under `'deny'` too, so an anonymous caller cannot tell which paths exist, and `404 NOT_FOUND` in the error envelope under `'allow'`. WebSocket connections take the `anonymous` option of `setupWebSocket`, or the `anonymous` of its route context when the option is not set.

### Thread authorization

Core lets a caller touch only threads they own. `authorizeThread` adds your own rule on top, for example a tenant check:

```typescript
const router = cogitatorApp({
  cogitator,
  agents,
  auth,
  authorizeThread: (auth, threadId) => tenants.ownsThread(auth?.metadata?.tenant, threadId),
});
```

It is called with what `auth` returned and the thread a request names: the body `threadId` of agent runs, streams and resumes and of swarm runs and streams, and the `:id` of `GET`, `DELETE` and `POST /threads/:id/messages`. It runs after the body is validated and before the owner check, and `false` answers `403 THREAD_FORBIDDEN` without starting a run. WebSocket runs and resumes are checked by the `authorizeThread` of the route context given to `setupWebSocket`, and a refusal is an `error` message.

### Run deps

`deps` builds what an agent's tools get as `context.deps` for one request: a database handle, the tenant, a client with the caller's credentials. The model never sees them, and they never come from the request body.

```typescript
const router = cogitatorApp({
  cogitator,
  agents,
  deps: async (ctx) => ({ db: await pool.connect(), tenant: ctx.get('x-tenant') }),
});
```

Agent runs, streams and resumes call it once per run. WebSocket runs take the `deps` option of `setupWebSocket`, called with the upgrade request.

### Run limits

`limits` caps what a request may ask a run for: `swarmTimeout` (ms) for swarm runs, `workflowMaxIterations` and `workflowMaxConcurrency` for workflow runs. A request that asks for more is held to the cap, and one that asks for nothing gets the cap. Each limit must be a positive integer, or `cogitatorApp` throws. The OpenAPI spec shows each limit as the default of its field. WebSocket runs take the `limits` of the route context given to `setupWebSocket`.

```typescript
const router = cogitatorApp({
  cogitator,
  swarms: { research: researchSwarm },
  limits: { swarmTimeout: 120_000, workflowMaxIterations: 50, workflowMaxConcurrency: 4 },
});
```

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

The body is `{ threadId, decisions?, defaultDecision? }`, where a decision is `{ approved: boolean, reason?: string, updatedArguments?: object, remember?: boolean | { rule?: string, layer?: string } }` (see [Permissions](https://cogitator.app/docs/tools/permissions#always-allow)); malformed bodies get `400 INVALID_INPUT`. The response has the same shape as `/run` and may pause again for calls left without a decision. The run resumes as the authenticated `userId`: a thread with no paused run answers `409 RUN_NOT_PAUSED`, and another user's paused run `403 THREAD_ACCESS_DENIED`. Over WebSocket, send `resume` with `{ name, threadId, decisions?, defaultDecision? }`; a paused run's `complete` event carries `status` and `pendingApprovals`.

A tool can also ask the user a question with `context.interrupt()`, which pauses the run the same way. The answer then carries `interrupts` (`{ id, kind, reason, message, responseSchema?, expiresAt?, toolCallId?, toolName?, details? }`, `kind` one of `input`, `plan` and `budget`), the stream sends `{ type: 'interrupt-required', threadId, interrupts }` instead of `approval-required`, and the client resumes with the answers by interrupt id: `{ threadId, responses: { [id]: answer } }`, over HTTP and WebSocket alike (`resume` with `{ name, threadId, responses }`). An answer that does not match its `responseSchema` is refused with `400 INTERRUPT_ANSWER_INVALID`, and one sent after `expiresAt` with `410 INTERRUPT_EXPIRED` (`/resume/stream` sends both as an `error` event with that `code`).

A run or stream body may also name a `multitaskStrategy` for a thread that already has a run going on in this Cogitator: `enqueue` waits for that run, `reject` refuses the new run with `THREAD_BUSY`, `interrupt` stops the running one (it fails with `RUN_INTERRUPTED`) and `rollback` stops it and branches from where it started. `POST /agents/:name/run` answers both codes with `409`. A stream has already answered `200` and sent `start` when its run meets the other runs of the thread, so it gets them as an `error` event instead (`{ type: 'error', message, code: 'THREAD_BUSY' }`), and a WebSocket `run` as an `error` frame. Without one the Cogitator's `multitaskStrategy` applies, and any other value is refused with `400 INVALID_INPUT`. A WebSocket `run` takes it too. Swarm routes have no thread queue and ignore `multitaskStrategy`.

`POST /agents/:name/resume/stream` takes the same body and streams the rest of the run like `/stream`. `start` and `finish` name the resumed thread, and a body, agent or thread refused before the stream opens is answered as JSON, just like `/resume`. A thread with no paused run ends the open stream with an `error` event, `code: 'RUN_NOT_PAUSED'`, and disconnecting aborts the resume.

## Triggers and inbox (experimental)

Give the router the runtime's trigger manager as `triggers` and it serves the routes of API triggers, webhooks and the inbox of their results. Start the manager yourself.

```typescript
const cog = new Cogitator({ experimental_triggers: { agents, routines } });
const triggers = cog.experimental_triggers;
await triggers?.start();

const router = cogitatorApp({ cogitator: cog, agents, triggers, auth });
app.use(router.routes());
```

| Route                        | Auth                                                                      | Body                                                             |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /triggers/:id/fire`    | the trigger's own bearer token                                            | `{ "text": "..." }`, read raw                                    |
| `POST /triggers/:id/webhook` | the sender's signature (HMAC, GitHub, Mailgun, Postmark, SendGrid, Slack) | any content type, read raw                                       |
| `GET /inbox`                 | the adapter's `auth` and `anonymous`                                      | `?status=unread&kind=failure&routineId=...&limit=20&before=<ms>` |
| `PATCH /inbox/:id`           | the adapter's `auth` and `anonymous`                                      | `{ "status": "read" \| "unread" \| "archived" }`                 |

The two trigger routes authenticate themselves, so they run before the router's `auth`, JSON body parser and body limit: a trigger checks the token or the signature over the body exactly as it came, which is read raw for any content type (JSON, forms, multipart) up to 10 MiB and never parsed or re-serialized. A larger body answers `413 PAYLOAD_TOO_LARGE`. They answer with the status, JSON body and headers of the trigger manager, `{ error: { code, message } }` on a refusal. The inbox routes go through `auth` and `anonymous` like every other route: a caller sees and changes only the items of its `userId`, a caller without one gets `401 UNAUTHORIZED` unless `anonymous` is set to `'allow'` explicitly (then the items without a user), and another user's item answers `404 NOT_FOUND`. `/openapi.json` documents them. Without `triggers` none of these routes exist.

## Route Prefix

```typescript
import Koa from 'koa';
import Router from '@koa/router';
import { cogitatorApp } from '@cogitator-ai/koa';

const app = new Koa();
const main = new Router();
const api = cogitatorApp({ cogitator, agents });

main.use('/api/v1', api.routes());
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

const server = createServer(app.callback());
await setupWebSocket(
  server,
  { runtime: cogitator, agents, workflows: {}, swarms: {}, limits: { swarmTimeout: 120_000 } },
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
    anonymous: 'deny',
    deps: (req) => ({ tenant: req.headers['x-tenant'] }),
  }
);

server.listen(3000);
```

The router's `auth` option does not cover WebSocket connections, so pass `auth` to `setupWebSocket` to protect them: it receives the upgrade `IncomingMessage`, and throwing rejects the handshake with `401` (or `500` when the error carries a `status >= 500`). With `anonymous: 'deny'` a connection without a `userId` is refused with `401` too. `deps` builds the deps of each agent run on the connection from its upgrade request, called for each run. The route context can carry `limits` and `authorizeThread`, which WebSocket runs and resumes follow like the HTTP routes, and `anonymous`, which the handshake follows when the `anonymous` option is not set (the option wins). Its `deps` builds the deps of HTTP runs from a Koa `Context`, which an upgrade request does not have, so `setupWebSocket` ignores it and takes the `deps` option instead. Upgrades on other paths are left to other `upgrade` listeners (or rejected with `404` when there are none), so the socket can share the HTTP server with other WebSocket servers. A client that does not answer a ping within `pingTimeout` (defaults to `pingInterval`) is terminated, and closing a connection aborts its active run.

**Message types:**

| Client sends | Payload                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `run`        | `{ type: 'agent' \| 'workflow' \| 'swarm', name, input, context?, threadId? }` |
| `resume`     | `{ name, threadId, decisions?, defaultDecision? }` (resume a paused agent run) |
| `stop`       | Cancels the current run                                                        |
| `ping`       | Answered with `pong` (echoes `id`)                                             |

| Server sends | Description                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `event`      | `token`, `reasoning`, `tool-call`, `tool-result`, `complete` (with the serialized result), `cancelled`                  |
| `error`      | Invalid message, unknown resource, a thread `authorizeThread` refused, run already in progress, or a masked run failure |
| `pong`       | Heartbeat reply                                                                                                         |

## SSE Streaming

The adapter includes `KoaStreamWriter` for Server-Sent Events with structured event types (text deltas, tool calls, approvals, workflow/swarm events). Workflow streams send `{ type: 'workflow', event, data }` (`node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed`, and `workflow_failed` with `{ checkpointId? }` right before the `error` event of a failed run); swarm streams send `{ type: 'swarm', event, data }` (`agent_start`, `agent_complete`, `agent_error`, `message`, the swarm's own events, `swarm_completed`). Every stream ends with `finish` and `data: [DONE]`, or with an `error` event. Agent streams emit `tool-call-start`, `tool-call-delta` (the JSON arguments) and `tool-call-end` with the provider's tool call id, so `tool-result.toolCallId` always matches the call it belongs to.

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

## Resumable streams

With `resumableStreams` on, a client that loses the stream of `/agents/:name/stream` or `/agents/:name/resume/stream` (a flaky network, a tab that went to sleep) gets back what it missed, and the run goes on while it is away:

```typescript
const router = cogitatorApp({
  cogitator,
  agents: { chat: chatAgent },
  resumableStreams: true,
});
```

- Every event carries an SSE `id`, `<streamId>:<seq>` with `seq` from 1 up. Heartbeat comments carry none.
- A client that disconnects no longer stops the run. Its events keep going into the store.
- The same route with `Last-Event-ID: <id>` reconnects instead of starting a run, and the body is not read: the answer replays the events after that id with their ids, then follows the run to `finish` (and `data: [DONE]`) or `error`. Several clients may follow one stream. `?lastEventId=<id>` works too, for clients that cannot set headers, but it puts the id into URLs and access logs, so prefer the header.
- `DELETE /agents/:name/stream/:streamId` cancels the run (`204`): its stream ends with an `error` event `STREAM_CANCELLED`. The stream id is the part of an event id before the last `:`.
- A stream is bound to the caller who started it: every field of what `auth` returned (user id, roles, permissions, metadata such as a tenant), so callers without a user id are told apart too. Give `owner: (auth) => key` to bind it to fewer fields, such as the user id alone when the identity carries a token expiry. Anyone else, an unknown or expired stream and an event id the stream never sent get `404 STREAM_NOT_FOUND` before any SSE header, an id that is not `<streamId>:<seq>` gets `400 INVALID_INPUT`. `authorizeThread` is asked about the stream's thread on every reconnect and cancel (`403 THREAD_FORBIDDEN`).
- A reconnect after events that are no longer kept (more than `maxEvents` since) gets one `error` event with `STREAM_RESUME_GAP`: fetch the thread (`GET /threads/:id`) to catch up. A client that reads slowly holds at most `maxEvents` events and catches up from the store.
- A run nobody follows for `detachedTimeoutMs` (5 minutes by default) is stopped, so a client that never comes back does not run up cost, and so is every run when `until` aborts (pass the signal your server stops on, and abort it before `server.close()`, which waits for the streams still open). Such a stream ends with an `error` event `STREAM_ABORTED`.
- A stream whose run goes on is never evicted: when `maxStreams` streams all go on, a new one is refused with `503 STREAM_LIMIT_REACHED`.

`true` keeps the events in the memory of the process: 1000 events of each stream, a finished stream for 5 minutes, 1000 streams at once (`maxEvents`, `retentionMs`, `maxStreams`). Behind a load balancer with several processes, pass a `store` they share (`StreamReplayStore` from `@cogitator-ai/server-shared`, backed by Redis or similar with pub/sub), so a reconnect or a cancel that lands on another process reaches the stream and its run. Off by default: no ids, and a client that disconnects stops the run.

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

- **Error handler**, catches errors and returns structured `ErrorResponse`
- **Body parser**, parses JSON for POST, PUT, PATCH requests (`bodyLimit`, 1 MiB by default, returns `413` above it). A body already parsed by upstream middleware such as `koa-bodyparser` is reused
- **Context**, injects `RouteContext` with `runtime`, `agents`, `workflows`, `swarms` into Koa state
- **Auth**, optional authentication via the `auth` callback
- **Anonymous policy**, after the health and docs routes, answers `401` to callers without a `userId` under `anonymous: 'deny'` (`createAnonymousMiddleware`)
- **Unmatched paths**, a request no route serves skips the middleware above and goes on to the middleware after the router untouched. What nothing answers goes through auth and the anonymous policy and gets `404 NOT_FOUND` in the error envelope, or `401` under `anonymous: 'deny'`. A method a path does not take is answered the same way. Under a prefix, only paths under it are answered

## Key Types

```typescript
import type {
  RouteContext, // { runtime, agents, workflows, swarms, limits?, authorizeThread?, anonymous?, deps? }, deps is for HTTP runs only
  CogitatorAppOptions,
  AuthContext,
  AuthFunction,
  DepsFunction,
  RunLimits,
  AnonymousPolicy,
  AuthorizeThread,
  WebSocketConfig,
  WebSocketAuthFunction,
  WebSocketDepsFunction,
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
