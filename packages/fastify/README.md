# @cogitator-ai/fastify

Fastify server adapter for Cogitator AI runtime. Automatically generates REST API endpoints for agents, workflows, and swarms with SSE streaming, WebSocket support, and Swagger documentation.

## Installation

```bash
npm install @cogitator-ai/fastify fastify
# or
pnpm add @cogitator-ai/fastify fastify
```

## Quick Start

```typescript
import Fastify from 'fastify';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { cogitatorPlugin } from '@cogitator-ai/fastify';

const fastify = Fastify({ logger: true });

const cogitator = new Cogitator({
  llm: {
    defaultModel: 'openai/gpt-6-luna',
    providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  },
});

const chatAgent = new Agent({
  name: 'chat',
  description: 'General-purpose chat assistant',
  instructions: 'You are a helpful assistant.',
  model: 'openai/gpt-6-luna',
});

await fastify.register(cogitatorPlugin, {
  cogitator,
  agents: { chat: chatAgent },
  prefix: '/api',
  enableSwagger: true,
});

await fastify.listen({ port: 3000 });
console.log('Server running on http://localhost:3000');
```

## Auto-generated Endpoints

### Agents

```
GET    /api/agents                         - List all agents
POST   /api/agents/:name/run               - Run agent (JSON response)
POST   /api/agents/:name/stream            - Run agent (SSE stream)
POST   /api/agents/:name/resume            - Resume a run paused for tool approvals
POST   /api/agents/:name/resume/stream     - Resume a paused run (SSE stream)
POST   /api/agents/:name/agui              - Run or resume for an AG-UI client (AG-UI SSE)
```

Bodies are validated with JSON Schema (`input` must contain more than whitespace, the same rule the other adapters share from `@cogitator-ai/server-shared`); validation failures return `400 INVALID_INPUT` before the model is called. The `usage` of a run answer carries `inputTokens`, `outputTokens` and `totalTokens`, plus `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, the same shape as every other adapter. The `finish` event of an agent stream carries the same `usage` (never the run's cost or duration). The agent list exposes `config.description`, never the instructions. The authenticated `userId` is passed to the run, and runs are aborted when the client disconnects.

### Threads (Memory)

```
GET    /api/threads/:id               - Get thread messages, a page at a time with ?limit&cursor
POST   /api/threads/:id/messages      - Add message to thread
DELETE /api/threads/:id               - Delete thread
```

The routes use `cogitator.getMemory()`, which connects the configured memory adapter on first use, so threads can be read on a fresh server before any agent has run. Only a `Cogitator` without `memory` configured answers `503 UNAVAILABLE`. Messages take `role` `user` or `assistant` (more with `threadMessageRoles`), and `metadata` is stored on the memory entry.

`GET /threads/:id` answers the whole thread by default. With `?limit=50` it answers the newest 50 messages (oldest first within the page) and a `nextCursor`, and `?limit=50&cursor=<nextCursor>` the 50 before them, until an answer has no `nextCursor`. Messages written in the same millisecond are never skipped or repeated across pages. A `limit` outside 1 to 1000 or a cursor the server never gave is refused with `400 INVALID_INPUT`, with the message every adapter gives.

```typescript
let cursor: string | undefined;
do {
  const query = new URLSearchParams({ limit: '50', ...(cursor && { cursor }) });
  const page = await (await fetch(`/api/threads/${threadId}?${query}`)).json();
  render(page.messages);
  cursor = page.nextCursor;
} while (cursor);
```

Request bodies go through the validators of `@cogitator-ai/server-shared` in a `preValidation` hook, before the JSON schema could coerce `input: 42` into `"42"`, so Fastify refuses exactly what the other adapters refuse, and the schemas document the bodies.

- A run sends `context` to the model as data the application supplied, and the model reads a `system` thread message as operator instructions, so clients may set neither unless the server allows it: `acceptContext` lists the `context` keys clients may send (`true` accepts any key, for clients trusted like your own code), and `threadMessageRoles` the roles of `POST /threads/:id/messages` (`user` and `assistant` by default). Anything else is refused with `400 INVALID_INPUT`, over HTTP and WebSocket alike.
- A `POST` body that is not JSON (`text/plain`, a form) is refused with `415 UNSUPPORTED_MEDIA_TYPE` before it is parsed: browsers send those across origins without a CORS preflight.
- `POST /agents/:name/run` and `/resume` answer `toAgentRunResponse()` of `@cogitator-ai/server-shared`: `output`, `threadId`, `usage`, `toolCalls` (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply. The WebSocket `complete` event carries the same object, never the system prompt, the history, trace spans or a paused run's checkpoint.
- The `start` event of an agent stream names the run's thread (the request's `threadId`, or a new one), and `finish` repeats it with the run's outcome, so a client that sent no thread continues the conversation with this one.
- Swarm routes close each swarm they build once its run ends, so a distributed swarm leaves no Redis connections behind and its state expires. `GET /swarms` lists every agent, the router and pipeline stages included.

### Workflows

```
GET    /api/workflows                 - List all workflows
POST   /api/workflows/:name/run            - Run workflow
POST   /api/workflows/:name/stream         - Stream workflow events
POST   /api/workflows/:name/resume         - Resume a workflow from a checkpoint
POST   /api/workflows/:name/resume/stream  - Resume a workflow and stream its events
```

Options are limited to `maxConcurrency`/`maxIterations` (positive integers, held to `limits.workflowMaxConcurrency` and `limits.workflowMaxIterations` when set, which a request that asks for nothing gets) and `checkpoint`, refused as `true` unless the plugin has `workflowCheckpoints` (see [Checkpoints and resume](#checkpoints-and-resume)). A failed workflow answers the error it failed with, mapped like any other run error (a node that hit `LLM_RATE_LIMITED` answers `429` with `Retry-After`, an internal error `500 INTERNAL_ERROR`), and its stream ends with an `error` event carrying that code instead of `workflow_completed`. Disconnecting aborts the workflow. Stream events are `{ type: 'workflow', event, data }` with `event` one of `node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed` (`{ workflowId, duration, checkpointId? }`), `workflow_failed` (`{ checkpointId? }`, right before the `error` event of a failed run).

#### Checkpoints and resume

`workflowCheckpoints` takes any `CheckpointStore` of `@cogitator-ai/workflows`, such as `PostgresCheckpointStore` or `RedisCheckpointStore`. With it, a run with `options.checkpoint: true` saves its checkpoints there as the caller's, the `userId` that `auth` returned (none for an anonymous caller), and its answer and `workflow_completed` event carry the last one as `checkpointId`. Without it such a run is refused with `400`.

`POST /workflows/:name/resume` takes `{ checkpointId: string; options?: { maxConcurrency?: number; maxIterations?: number } }`, passes over the nodes the checkpoint completed and runs the rest. It answers like `/run`, and `/resume/stream` streams like `/stream`. The `limits` hold as on `/run`, and the resumed run keeps saving checkpoints, so it can be resumed again. A checkpoint that is missing, belongs to another user or to another workflow answers `404 CHECKPOINT_NOT_FOUND` before anything runs, on `/resume/stream` before the stream opens. Without `workflowCheckpoints` every resume answers `404 CHECKPOINT_NOT_FOUND`. A run that fails answers its error with the last checkpoint it saved as `checkpointId`, next to `code` and `message` (`{ error: { message, code, checkpointId } }`), and a failed stream sends a `workflow_failed` event with `{ checkpointId }` right before its `error` event, so the client resumes the failed run from there. A resume that fails again names the checkpoint to resume from, its own last one or, when it saved none, the one it started from.

```typescript
import { PostgresCheckpointStore } from '@cogitator-ai/workflows';

await fastify.register(cogitatorPlugin, {
  cogitator,
  workflows: { shipping },
  auth,
  workflowCheckpoints: new PostgresCheckpointStore({ client: pool }),
});
```

### Swarms

```
GET    /api/swarms                    - List all swarms
POST   /api/swarms/:name/run          - Run swarm
POST   /api/swarms/:name/stream       - Stream swarm events
GET    /api/swarms/:name/blackboard   - Get configured blackboard sections
```

`timeout` must be positive. With `limits.swarmTimeout` set, a longer timeout is held to it and a run without one gets it, and a swarm that runs out of time answers `504 RUN_TIMEOUT`. Disconnecting aborts the swarm. Stream events are `{ type: 'swarm', event, data }`: `agent_start`, `agent_complete`, `agent_error`, `message`, the swarm's own events, and finally `swarm_completed` with the output and usage. Each run creates a fresh swarm, so the blackboard endpoint returns the configured initial sections.

### Tools & Docs

```
GET    /api/tools                     - List all tools
GET    /api/health                    - Health check ({ status, uptime, timestamp })
GET    /api/ready                     - Readiness probe ({ status, checks })
GET    /api/docs                      - Swagger UI (enableSwagger)
GET    /api/docs/json                 - OpenAPI spec (enableSwagger)
```

The OpenAPI document is generated by `@fastify/swagger` from the route schemas, which show the operator's `limits` as the defaults of the capped fields.

## Configuration

```typescript
await fastify.register(cogitatorPlugin, {
  cogitator,
  agents: { chat: chatAgent, research: researchAgent },
  workflows: { 'code-review': codeReviewWorkflow },
  swarms: { 'dev-team': devTeamSwarm },
  prefix: '/cogitator',
  enableWebSocket: true,
  enableSwagger: true,

  // Authentication — throw to reject with 401. Runs as an onRequest hook, so it
  // also guards WebSocket upgrades; the returned userId is passed to agent runs.
  auth: async (request) => {
    const token = request.headers.authorization?.replace('Bearer ', '');
    const user = await validateToken(token);
    return { userId: user.id, roles: user.roles };
  },

  // Rate limiting (requires @fastify/rate-limit); keyGenerator and
  // errorResponseBuilder are passed through. Rejections answer 429 RATE_LIMIT_EXCEEDED.
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
  },

  // Swagger customization
  swagger: {
    title: 'My AI API',
    description: 'AI-powered API endpoints',
    version: '1.0.0',
  },

  // WebSocket options (path is relative to the prefix)
  websocket: {
    path: '/ws',
  },

  // Caps on what a request may ask a run for. A larger value is held to the cap,
  // a request without one gets the cap. Checked when the plugin is registered.
  limits: { swarmTimeout: 120_000, workflowMaxIterations: 50, workflowMaxConcurrency: 4 },

  // 'deny' answers 401 to callers without a userId. Health, ready and the docs stay open.
  anonymous: 'deny',

  // Called with the auth context and the thread of every request that names one.
  // false answers 403 THREAD_FORBIDDEN and no run starts.
  authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}:`),

  // Dependencies for the tools of agent runs, streams and resumes (context.deps).
  // Built from the request on the server, never read from the body.
  deps: async (request) => ({ db: await tenantDb(request.headers['x-tenant']) }),
});
```

### Multiple users

When `auth` returns a `userId`, everything a caller does with threads is scoped to it:

- Agent runs and streams (REST and WebSocket) pass the `userId` to `cogitator.run()`, so a thread created by a run belongs to that user and a `threadId` owned by someone else is refused.
- `GET /threads/:id`, `POST /threads/:id/messages` and `DELETE /threads/:id` check the thread's owner first; `POST` to an unknown id creates the thread owned by the caller.
- Another user's thread answers `403` with code `THREAD_ACCESS_DENIED`, and its messages are neither returned nor changed.
- Threads created earlier without an owner (no `userId`) stay open only to callers without a `userId`, such as servers with no `auth` configured.
- `authorizeThread(auth, threadId)` adds your own rule on top of ownership, for shared or team threads. It runs on every route that names a thread (agent run, stream and resume, swarm run and stream, `GET`, `DELETE` and `POST /threads/:id/messages`) and on WebSocket runs with a `threadId`, after the body is validated and before core checks the owner. Answering `false` refuses with `403 THREAD_FORBIDDEN`, and no run starts.
- `anonymous: 'deny'` refuses every caller whose `auth` gave no `userId` with `401 UNAUTHORIZED`, WebSocket upgrades included. `/health`, `/ready` and `/docs` stay open. An unknown path under the prefix answers `401` too, so an anonymous caller cannot probe which routes exist, and `404 NOT_FOUND` once the caller has a `userId`. The default, `'allow'`, lets anonymous callers in as before, and an unknown path answers `404 NOT_FOUND` in the error envelope.

### Limits and deps

`limits` caps what a client may ask a run for: `swarmTimeout` (ms), `workflowMaxIterations` and `workflowMaxConcurrency`. A request is never refused over a limit: it gets the smaller of what it asked for and the limit, or the limit when it asked for nothing, over HTTP and SSE alike. The route schemas give each limit as the default of its field, without a `maximum`, so Fastify does not refuse a larger value. Each limit must be a positive integer, or registering the plugin fails.

`deps: (request) => deps` builds the dependencies agent tools read as `context.deps` (a database handle, a tenant, a client), and the run, stream or resume gets them as `deps`. They are built on the server for each request and never come from the body. Over WebSocket the hook gets the upgrade's `FastifyRequest`, which went through your hooks like any request, and is called for each run. An error the hook throws is answered like a run error, before a stream starts, and over WebSocket (like an error `authorizeThread` throws) with `{ type: 'error', id, error }`, starting no run.

### Approvals

A tool with `requiresApproval` (`true`, or a function of the arguments) pauses the run before that turn executes:

1. `POST /api/agents/:name/run` answers with `status: 'paused'` and `pendingApprovals` (`{ toolCallId, toolName, arguments, description, sideEffects? }`); finished runs carry `status: 'completed'`. The run's checkpoint stays on the server and is never sent to the client.
2. `POST /api/agents/:name/stream` emits `{ type: 'approval-required', threadId, approvals }` right before `finish`.
3. The client shows the pending calls and sends the answers to `POST /api/agents/:name/resume`:

```typescript
await fetch('/api/agents/support/resume', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    threadId,
    decisions: { [toolCallId]: { approved: true } },
    defaultDecision: { approved: false, reason: 'Not approved' },
  }),
});
```

The body is `{ threadId, decisions?, defaultDecision? }`, where a decision is `{ approved: boolean, reason?: string, updatedArguments?: object, remember?: boolean | { rule?: string, layer?: string } }` (see [Permissions](https://cogitator.app/docs/tools/permissions#always-allow)); malformed bodies get `400 INVALID_INPUT`. The response has the same shape as `/run` and may pause again for calls left without a decision. The run resumes as the authenticated `userId`: a thread with no paused run answers `409 RUN_NOT_PAUSED`, and another user's paused run `403 THREAD_ACCESS_DENIED`. Over WebSocket, send `{ type: 'resume', id, payload: { name, threadId, decisions?, defaultDecision? } }`; a paused run's `complete` event carries `status` and `pendingApprovals`.

A tool can also ask the user a question with `context.interrupt()`, which pauses the run the same way. The answer then carries `interrupts` (`{ id, kind, reason, message, responseSchema?, expiresAt?, toolCallId?, toolName?, details? }`, `kind` one of `input`, `plan` and `budget`), the stream sends `{ type: 'interrupt-required', threadId, interrupts }` instead of `approval-required`, and the client resumes with the answers by interrupt id: `{ threadId, responses: { [id]: answer } }`, over HTTP and WebSocket alike (`payload: { name, threadId, responses }`). An answer that does not match its `responseSchema` is refused with `400 INTERRUPT_ANSWER_INVALID`, and one sent after `expiresAt` with `410 INTERRUPT_EXPIRED` (`/resume/stream` sends both as an `error` event with that `code`).

A run or stream body may also name a `multitaskStrategy` for a thread that already has a run going on in this Cogitator: `enqueue` waits for that run, `reject` refuses the new run with `THREAD_BUSY`, `interrupt` stops the running one (it fails with `RUN_INTERRUPTED`) and `rollback` stops it and branches from where it started. `POST /agents/:name/run` answers both codes with `409`. A stream has already answered `200` and sent `start` when its run meets the other runs of the thread, so it gets them as an `error` event instead (`{ type: 'error', message, code: 'THREAD_BUSY' }`), and a WebSocket `run` as an `error` frame. Without one the Cogitator's `multitaskStrategy` applies, and any other value is refused with `400 INVALID_INPUT`. The WebSocket `run` payload takes it too. Swarm routes have no thread queue and ignore `multitaskStrategy`.

`POST /agents/:name/resume/stream` takes the same body and streams the rest of the run like `/stream`. `start` and `finish` name the resumed thread, and a body, agent or thread refused before the stream opens is answered as JSON, just like `/resume`. A thread with no paused run ends the open stream with an `error` event, `code: 'RUN_NOT_PAUSED'`, and disconnecting aborts the resume.

## Triggers and inbox (experimental)

Give the plugin the runtime's trigger manager as `triggers` and it serves the routes of API triggers, webhooks and the inbox of their results. Start the manager yourself.

```typescript
const cog = new Cogitator({ experimental_triggers: { agents, routines } });
const triggers = cog.experimental_triggers;
await triggers?.start();

await fastify.register(cogitatorPlugin, { cogitator: cog, agents, triggers, auth, prefix: '/api' });
```

| Route                        | Auth                                                                      | Body                                                             |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /triggers/:id/fire`    | the trigger's own bearer token                                            | `{ "text": "..." }`, read raw                                    |
| `POST /triggers/:id/webhook` | the sender's signature (HMAC, GitHub, Mailgun, Postmark, SendGrid, Slack) | any content type, read raw                                       |
| `GET /inbox`                 | the adapter's `auth` and `anonymous`                                      | `?status=unread&kind=failure&routineId=...&limit=20&before=<ms>` |
| `PATCH /inbox/:id`           | the adapter's `auth` and `anonymous`                                      | `{ "status": "read" \| "unread" \| "archived" }`                 |

The two trigger routes authenticate themselves, so they are registered beside the API routes, in a context of their own with a raw body parser, and none of the plugin's hooks run on them (`auth`, the anonymous policy, the JSON body check, rate limiting). A trigger checks the token or the signature over the body exactly as it came, which is read raw for any content type (JSON, forms, multipart) up to 10 MiB and never parsed or re-serialized. A larger body answers `413 PAYLOAD_TOO_LARGE`. They answer with the status, JSON body and headers of the trigger manager, `{ error: { code, message } }` on a refusal. The inbox routes go through `auth` and `anonymous` like every other route: a caller sees and changes only the items of its `userId`, a caller without one gets `401 UNAUTHORIZED` unless `anonymous` is set to `'allow'` explicitly (then the items without a user), and another user's item answers `404 NOT_FOUND`. With `enableSwagger` the document lists them. Without `triggers` none of these routes exist.

## SSE Streaming

The `/agents/:name/stream` endpoint returns Server-Sent Events:

```typescript
const response = await fetch('/api/agents/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'Hello!' }),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const event = JSON.parse(line.slice(6));
      console.log(event);
      // { type: 'text-delta', id: '...', delta: 'Hello' }
    }
  }
}
```

### Stream Events

| Event Type           | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `start`              | Stream started, includes message ID                  |
| `text-start`         | Text generation started                              |
| `text-delta`         | Text chunk received                                  |
| `text-end`           | Text generation finished                             |
| `reasoning-start`    | Reasoning summary started                            |
| `reasoning-delta`    | Reasoning summary chunk received                     |
| `reasoning-end`      | Reasoning summary finished                           |
| `tool-call-start`    | Tool call started (`id` = model call id)             |
| `tool-call-delta`    | Tool call arguments (JSON text)                      |
| `tool-call-end`      | Tool call finished                                   |
| `tool-result`        | Tool result (`toolCallId` = call id)                 |
| `approval-required`  | Run paused: `{ threadId, approvals }`                |
| `interrupt-required` | Run paused for questions: `{ threadId, interrupts }` |
| `workflow`           | Workflow event (node started/completed)              |
| `swarm`              | Swarm event (agent started/completed)                |
| `error`              | Error occurred                                       |
| `finish`             | Stream finished, with the `usage` of `/run`          |

While an SSE stream is open it writes a `: keep-alive` comment every `sseHeartbeatMs` (5 s by default, `0` turns it off), which SSE clients skip, so a proxy or load balancer does not close a stream that waits on a slow tool or model (nginx closes a connection silent for 60 s).

Text is emitted in `text-start`/`text-delta`/`text-end` blocks that are closed around tool calls; when the agent sets `reasoning: { summary: true }` and the provider returns a reasoning summary, it streams as separate `reasoning-start`/`reasoning-delta`/`reasoning-end` blocks that are closed before text or a tool call starts; the stream ends with `data: [DONE]` after `finish`. Headers set by your hooks (CORS, rate-limit) are kept on SSE responses.

## Resumable streams

With `resumableStreams` on, a client that loses the stream of `/agents/:name/stream` or `/agents/:name/resume/stream` (a flaky network, a tab that went to sleep) gets back what it missed, and the run goes on while it is away:

```typescript
await fastify.register(cogitatorPlugin, {
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
- A run nobody follows for `detachedTimeoutMs` (5 minutes by default) is stopped, so a client that never comes back does not run up cost, and so is every run as soon as the Fastify instance starts closing (`preClose`, before it waits for open connections), or when `until` aborts. Such a stream ends with an `error` event `STREAM_ABORTED`.
- A stream whose run goes on is never evicted: when `maxStreams` streams all go on, a new one is refused with `503 STREAM_LIMIT_REACHED`.

`true` keeps the events in the memory of the process: 1000 events of each stream, a finished stream for 5 minutes, 1000 streams at once (`maxEvents`, `retentionMs`, `maxStreams`). Behind a load balancer with several processes, pass a `store` they share (`StreamReplayStore` from `@cogitator-ai/server-shared`, backed by Redis or similar with pub/sub), so a reconnect or a cancel that lands on another process reaches the stream and its run. Off by default: no ids, and a client that disconnects stops the run.

## WebSocket Support

Enable real-time bidirectional communication (requires `@fastify/websocket`, without it the plugin logs a warning and skips the endpoint). The endpoint is `<prefix>/ws` unless `websocket.path` says otherwise, and the `auth` hook runs on the upgrade request, which `anonymous: 'deny'` refuses with 401 when it gives no `userId`. A `run` or `resume` on a thread `authorizeThread` refuses answers `{ type: 'error', id, error }` without starting, and `deps` is called with the upgrade request.

```typescript
await fastify.register(cogitatorPlugin, {
  // ...
  enableWebSocket: true,
});
```

Client usage:

```typescript
const ws = new WebSocket('ws://localhost:3000/api/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message);
};

// Run agent
ws.send(
  JSON.stringify({
    type: 'run',
    id: 'req-1',
    payload: {
      type: 'agent',
      name: 'chat',
      input: 'Hello!',
    },
  })
);

// Observe runs of an agent started by other clients
ws.send(JSON.stringify({ type: 'subscribe', channel: 'agent:chat' }));

// Abort the running agent (emits { type: 'event', payload: { type: 'cancelled' } })
ws.send(JSON.stringify({ type: 'stop' }));

// Ping/pong
ws.send(JSON.stringify({ type: 'ping' }));
```

### WebSocket Message Types

| Type           | Direction     | Description                                                                                                                   |
| -------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ping`         | Client→Server | Heartbeat                                                                                                                     |
| `pong`         | Server→Client | Heartbeat response                                                                                                            |
| `subscribe`    | Client→Server | Subscribe to `agent:<name>`: receive events of the same user's runs on other connections, on threads `authorizeThread` allows |
| `subscribed`   | Server→Client | Subscription confirmed                                                                                                        |
| `unsubscribe`  | Client→Server | Unsubscribe from channel                                                                                                      |
| `unsubscribed` | Server→Client | Unsubscription confirmed                                                                                                      |
| `run`          | Client→Server | Run an agent (`payload: { type: 'agent', name, input, context?, threadId? }`), one run per connection at a time               |
| `resume`       | Client→Server | Resume a run paused for tool approvals (`payload: { name, threadId, decisions?, defaultDecision? }`)                          |
| `stop`         | Client→Server | Abort the running agent                                                                                                       |
| `event`        | Server→Client | Run event: `token`, `reasoning`, `tool-call`, `tool-result`, `complete`, `cancelled`                                          |
| `error`        | Server→Client | `{ type: 'error', id?, error }`: invalid message, unknown agent, run already in progress, or a failed run                     |

Only agent runs are supported over WebSocket, use the HTTP endpoints for workflows and swarms. A second `run` while one is active is refused with `A run is already in progress`, send `stop` first. A connection may subscribe to at most 64 channels. A failed run reports a `CogitatorError`'s message, any other error is logged and sent as `Internal server error`.

A subscriber gets the events of a run only when it has the `userId` of the caller who started it and, with `authorizeThread` set, when `authorizeThread(subscriberAuth, threadId)` allows it on the run's thread (the `threadId` of the run, or the one core created for it). The answer is asked once per subscriber and run, and a subscriber it refuses, or throws for, gets none of the run's events. Without `authorizeThread`, callers without a `userId` share the events of each other's runs, so set `authorizeThread` or `anonymous: 'deny'` when anonymous callers must not see each other.

## Custom Streaming

Use `FastifyStreamWriter` for custom streaming routes:

```typescript
import { FastifyStreamWriter, generateId } from '@cogitator-ai/fastify';

fastify.post('/custom/stream', async (request, reply) => {
  const writer = new FastifyStreamWriter(reply); // start() hijacks the reply
  const messageId = generateId('msg');
  reply.raw.on('close', () => writer.close());

  writer.start(messageId);
  const textId = generateId('txt');
  writer.textStart(textId);

  // Your streaming logic
  writer.textDelta(textId, 'Hello ');
  writer.textDelta(textId, 'World!');

  writer.textEnd(textId);
  writer.finish(messageId);
  writer.close();
  return reply;
});
```

## Optional Dependencies

Install these packages to enable additional features:

```bash
# Swagger UI
pnpm add @fastify/swagger @fastify/swagger-ui

# Rate limiting
pnpm add @fastify/rate-limit

# WebSocket support
pnpm add @fastify/websocket

# Workflows support
pnpm add @cogitator-ai/workflows

# Swarms support
pnpm add @cogitator-ai/swarms
```

## API Reference

### cogitatorPlugin

```typescript
import { cogitatorPlugin } from '@cogitator-ai/fastify';

await fastify.register(cogitatorPlugin, options);
```

### CogitatorPluginOptions

```typescript
interface CogitatorPluginOptions {
  cogitator: Cogitator;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow>;
  swarms?: Record<string, SwarmConfig>;
  prefix?: string; // Default: '/cogitator'
  auth?: AuthFunction;
  rateLimit?: RateLimitConfig;
  enableSwagger?: boolean; // Default: false
  enableWebSocket?: boolean; // Default: false
  swagger?: SwaggerConfig;
  websocket?: WebSocketConfig;
  sseHeartbeatMs?: number; // Default: 5000, 0 turns SSE heartbeats off
  acceptContext?: boolean | string[]; // context keys clients may send: none by default, a list, or true for any
  threadMessageRoles?: ('user' | 'assistant' | 'system')[]; // roles of POST /threads/:id/messages, default user and assistant
  limits?: RunLimits; // { swarmTimeout?, workflowMaxIterations?, workflowMaxConcurrency? }
  anonymous?: 'allow' | 'deny'; // Default: 'allow'
  authorizeThread?: (auth: AuthContext | undefined, threadId: string) => boolean | Promise<boolean>;
  deps?: (request: FastifyRequest) => unknown | Promise<unknown>;
  workflowCheckpoints?: CheckpointStore; // workflow checkpoints and /resume, none by default
  resumableStreams?: boolean | ResumableStreamOptions; // see Resumable streams, off by default
}
```

### FastifyStreamWriter

```typescript
class FastifyStreamWriter {
  constructor(reply: FastifyReply);
  start(messageId: string): void;
  textStart(id: string): void;
  textDelta(id: string, delta: string): void;
  textEnd(id: string): void;
  reasoningStart(id: string): void;
  reasoningDelta(id: string, delta: string): void;
  reasoningEnd(id: string): void;
  toolCallStart(id: string, toolName: string): void;
  toolCallDelta(id: string, argsTextDelta: string): void;
  toolCallEnd(id: string): void;
  toolResult(id: string, toolCallId: string, result: unknown): void;
  approvalRequired(threadId: string, approvals: readonly PendingApproval[]): void;
  workflowEvent(event: string, data: unknown): void;
  swarmEvent(event: string, data: unknown): void;
  error(message: string, code?: string): void;
  finish(messageId: string, usage?: Usage): void;
  close(): void; // no-op before start(); ignores writes after the response ended
  readonly isClosed: boolean;
}
```

## Fastify Decorators

The plugin adds decorators to the Fastify instance:

```typescript
// Access cogitator context
fastify.cogitator.runtime; // Cogitator instance
fastify.cogitator.agents; // Registered agents
fastify.cogitator.workflows; // Registered workflows
fastify.cogitator.swarms; // Registered swarms
fastify.cogitator.limits; // The checked run limits

// Request decorators (in handlers)
request.cogitatorAuth; // Auth context from auth hook
request.cogitatorRequestId; // Unique request ID
request.cogitatorStartTime; // Request start timestamp
```

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": {
    "message": "Agent 'unknown' not found",
    "code": "NOT_FOUND"
  }
}
```

Error codes map to HTTP status codes:

- `INVALID_INPUT` → 400 (schema validation and malformed JSON; `details` carries the validation errors)
- `UNAUTHORIZED` → 401
- `THREAD_ACCESS_DENIED` → 403 (another user's thread)
- `THREAD_FORBIDDEN` → 403 (`authorizeThread` refused the thread)
- `NOT_FOUND` → 404
- `RUN_NOT_PAUSED` → 409 (resume of a thread without a paused run)
- `PAYLOAD_TOO_LARGE` → 413
- `RATE_LIMIT_EXCEEDED` → 429
- `INTERNAL_ERROR` → 500
- `UNIMPLEMENTED` → 501 (optional workflows/swarms package missing)
- `UNAVAILABLE` → 503 (no memory configured)
- `RUN_TIMEOUT` → 504 (a swarm ran out of time)

A `CogitatorError` keeps its message and code and answers with its own `statusCode`, which is the code's mapped status unless the error was given another (for example `LLM_RATE_LIMITED` → 429). When it says when to retry (`retryAfter`, as provider rate limits do), the answer carries `Retry-After` in whole seconds. The mapping is `describeHttpError` of `@cogitator-ai/server-shared`, so Express, Fastify, Hono, Koa and Next answer the same error the same way. Any other error is logged through the Fastify logger and answered as `500 Internal server error`, so internals never reach the client. The same mapping applies to a failed workflow, and the same masking to SSE `error` events, the `node_error`/`agent_error` stream events and WebSocket run errors.

## JSON Schema Validation

Fastify's built-in validation is used for all endpoints. Request schemas are exported:

```typescript
import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  AgentResumeRequestSchema,
  AddMessageRequestSchema,
  WorkflowRunRequestSchema,
  WorkflowResumeRequestSchema,
  SwarmRunRequestSchema,
  ThreadPageQuerySchema,
  ThreadResponseSchema,
  workflowRunRequestSchema,
  workflowResumeRequestSchema,
  swarmRunRequestSchema,
} from '@cogitator-ai/fastify';
```

`AgentResumeRequestSchema` requires a non-blank `threadId` and validates each decision as `{ approved: boolean, reason?: string, updatedArguments?: object, remember?: boolean | { rule?, layer? } }`. `AgentRunRequestSchema` and `SwarmRunRequestSchema` require a non-blank `input` (the swarm `timeout` must be greater than 0), `AddMessageRequestSchema` requires a non-blank `content` and a `user`/`assistant`/`system` role (the routes accept `system` only with `threadMessageRoles`), and `WorkflowRunRequestSchema.options` only allows `maxConcurrency`/`maxIterations` (integers ≥ 1) and `checkpoint: false` (`additionalProperties: false`), and `WorkflowResumeRequestSchema` requires a non-blank `checkpointId` with the same `maxConcurrency`/`maxIterations` options. The routes validate bodies with the shared validators first, so the schemas describe what they accept. `workflowRunRequestSchema(limits, checkpoints)`, `workflowResumeRequestSchema(limits)` and `swarmRunRequestSchema(limits)` build the same schemas with the operator's limits as defaults, as the routes use them, and `checkpoints: true` lets `checkpoint` be `true`, as on a plugin with `workflowCheckpoints`. `ThreadPageQuerySchema` and `ThreadResponseSchema` describe `GET /threads/:id`.

## Documentation

Full guide: [cogitator.app/docs/server-adapters/fastify](https://cogitator.app/docs/server-adapters/fastify). Tool approvals: [cogitator.app/docs/tools/approvals](https://cogitator.app/docs/tools/approvals).

## License

MIT
