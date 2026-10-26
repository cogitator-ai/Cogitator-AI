# @cogitator-ai/express

Express.js server adapter for Cogitator AI runtime. Automatically generates REST API endpoints for agents, workflows, and swarms with SSE streaming, WebSocket support, and Swagger documentation.

## Installation

```bash
npm install @cogitator-ai/express express
# or
pnpm add @cogitator-ai/express express
```

## Quick Start

```typescript
import express from 'express';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';

const app = express();

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

const server = new CogitatorServer({
  app,
  cogitator,
  agents: { chat: chatAgent },
  config: {
    basePath: '/api',
    enableSwagger: true,
  },
});

await server.init();
app.listen(3000, () => console.log('Server running on http://localhost:3000'));
```

## Auto-generated Endpoints

### Agents

```
GET    /api/agents                         - List all agents
POST   /api/agents/:name/run               - Run agent (JSON response)
POST   /api/agents/:name/stream            - Run agent (SSE stream)
POST   /api/agents/:name/resume            - Resume a run paused for tool approvals
POST   /api/agents/:name/resume/stream     - Resume a paused run (SSE stream)
```

Run/stream body: `{ input: string; context?: object; threadId?: string; multitaskStrategy?: 'enqueue' | 'reject' | 'interrupt' | 'rollback' }`. `input` must contain more than whitespace and `threadId`, when sent, must be a non-empty string (`400 INVALID_INPUT` otherwise, before the model is called). The validator comes from `@cogitator-ai/server-shared`, so Express, Fastify, Hono and Koa refuse exactly the same bodies. The `usage` of a run answer carries `inputTokens`, `outputTokens` and `totalTokens`, plus `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the model reported them, the same shape as every other adapter. The `finish` event of an agent stream carries the same `usage` (never the run's cost or duration). The agent list exposes `config.description`, never the agent instructions. The authenticated `userId` (from `auth`) is passed to the run, and the run is aborted when the client disconnects.

- A run sends `context` to the model as data the application supplied, and the model reads a `system` thread message as operator instructions, so clients may set neither unless the server allows it: `acceptContext` lists the `context` keys clients may send (`true` accepts any key, for clients trusted like your own code), and `threadMessageRoles` the roles of `POST /threads/:id/messages` (`user` and `assistant` by default). Anything else is refused with `400 INVALID_INPUT`, over HTTP and WebSocket alike.
- A `POST` body that is not JSON (`text/plain`, a form) is refused with `415 UNSUPPORTED_MEDIA_TYPE` before it is parsed: browsers send those across origins without a CORS preflight.
- `POST /agents/:name/run` and `/resume` answer `toAgentRunResponse()` of `@cogitator-ai/server-shared`: `output`, `threadId`, `usage`, `toolCalls` (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply. The WebSocket `complete` event carries the same object, never the system prompt, the history, trace spans or a paused run's checkpoint.
- The `start` event of an agent stream names the run's thread (the request's `threadId`, or a new one), and `finish` repeats it with the run's outcome, so a client that sent no thread continues the conversation with this one.
- Swarm routes close each swarm they build once its run ends, so a distributed swarm leaves no Redis connections behind and its state expires. `GET /swarms` lists every agent, the router and pipeline stages included.

### Threads (Memory)

```
GET    /api/threads/:id               - Get thread messages, a page at a time with ?limit&cursor
POST   /api/threads/:id/messages      - Add message to thread
DELETE /api/threads/:id               - Delete thread
```

The routes use `cogitator.getMemory()`, which connects the configured memory adapter on first use, so threads can be read on a fresh server before any agent has run. Only a `Cogitator` without `memory` configured answers `503 UNAVAILABLE`. New messages need `role` (`user` or `assistant`, more with `threadMessageRoles`) and a non-empty string `content`, optional `metadata` is stored on the memory entry.

`GET /threads/:id` answers the whole thread by default. With `?limit=50` it answers the newest 50 messages (oldest first within the page) and a `nextCursor`, and `?limit=50&cursor=<nextCursor>` the 50 before them, until an answer has no `nextCursor`. Messages written in the same millisecond are never skipped or repeated across pages. A `limit` outside 1 to 1000 or a cursor the server never gave is refused with `400 INVALID_INPUT`.

```typescript
let cursor: string | undefined;
do {
  const query = new URLSearchParams({ limit: '50', ...(cursor && { cursor }) });
  const page = await (await fetch(`/api/threads/${threadId}?${query}`)).json();
  render(page.messages);
  cursor = page.nextCursor;
} while (cursor);
```

### Workflows

```
GET    /api/workflows                 - List all workflows
POST   /api/workflows/:name/run            - Run workflow
POST   /api/workflows/:name/stream         - Stream workflow events
POST   /api/workflows/:name/resume         - Resume a workflow from a checkpoint
POST   /api/workflows/:name/resume/stream  - Resume a workflow and stream its events
```

Body: `{ input?: object; options?: { maxConcurrency?: number; maxIterations?: number; checkpoint?: boolean } }`. `maxConcurrency`/`maxIterations` must be positive integers (400 otherwise). With `limits.workflowMaxIterations` or `limits.workflowMaxConcurrency` set, a larger value is held to the limit, and a request that asks for nothing gets the limit. Other options are dropped, and `checkpoint: true` is refused with 400 unless the server has `workflowCheckpoints` (see [Checkpoints and resume](#checkpoints-and-resume)). A failed workflow answers the error it failed with, mapped like any other run error (a node that hit `LLM_RATE_LIMITED` answers `429` with `Retry-After`, an internal error `500 INTERNAL_ERROR`), and its stream ends with an `error` event carrying that code instead of `workflow_completed`. Disconnecting aborts the workflow.

The stream sends `{ type: 'workflow', event, data }` events: `node_started`, `node_completed`, `node_error`, `node_progress` and finally `workflow_completed` (`{ workflowId, duration, checkpointId? }`), or, when the run fails, `workflow_failed` (`{ checkpointId? }`) right before the `error` event.

#### Checkpoints and resume

`config.workflowCheckpoints` takes any `CheckpointStore` of `@cogitator-ai/workflows`, such as `PostgresCheckpointStore` or `RedisCheckpointStore`. With it, a run with `options.checkpoint: true` saves its checkpoints there as the caller's, the `userId` that `auth` returned (none for an anonymous caller), and its answer and `workflow_completed` event carry the last one as `checkpointId`.

`POST /workflows/:name/resume` takes `{ checkpointId: string; options?: { maxConcurrency?: number; maxIterations?: number } }`, passes over the nodes the checkpoint completed and runs the rest. It answers like `/run`, and `/resume/stream` streams like `/stream`. The `limits` hold as on `/run`, and the resumed run keeps saving checkpoints, so it can be resumed again. A checkpoint that is missing, belongs to another user or to another workflow answers `404 CHECKPOINT_NOT_FOUND` before anything runs, on `/resume/stream` before the stream opens. Without `workflowCheckpoints` every resume answers `404 CHECKPOINT_NOT_FOUND`. A run that fails answers its error with the last checkpoint it saved as `checkpointId`, next to `code` and `message` (`{ error: { message, code, checkpointId } }`), and a failed stream sends a `workflow_failed` event with `{ checkpointId }` right before its `error` event, so the client resumes the failed run from there. A resume that fails again names the checkpoint to resume from, its own last one or, when it saved none, the one it started from.

```typescript
import { PostgresCheckpointStore } from '@cogitator-ai/workflows';

const server = new CogitatorServer({
  app,
  cogitator,
  workflows: { shipping },
  config: { auth, workflowCheckpoints: new PostgresCheckpointStore({ client: pool }) },
});
```

### Swarms

```
GET    /api/swarms                    - List all swarms
POST   /api/swarms/:name/run          - Run swarm
POST   /api/swarms/:name/stream       - Stream swarm events
GET    /api/swarms/:name/blackboard   - Get configured blackboard sections
```

Run/stream body: `{ input: string; context?: object; threadId?: string; timeout?: number }` (`timeout` must be positive, at most `2147483647` ms). With `limits.swarmTimeout` set, a longer timeout is held to it and a run without one gets it, and a swarm that runs out of time answers `504 RUN_TIMEOUT`. Disconnecting aborts the swarm. The stream sends `{ type: 'swarm', event, data }` events (`agent_start`, `agent_complete`, `agent_error`, `message`, the swarm's own events, and finally `swarm_completed` with the output and usage). Each run creates a fresh swarm, so the blackboard endpoint returns the configured initial sections.

### Tools & Docs

```
GET    /api/tools                     - List all tools
GET    /api/health                    - Health check ({ status, uptime, timestamp })
GET    /api/ready                     - Readiness probe ({ status, checks })
GET    /api/docs                      - Swagger UI
GET    /api/openapi.json              - OpenAPI spec
```

## Configuration

```typescript
const server = new CogitatorServer({
  app,
  cogitator,
  agents: { chat: chatAgent, research: researchAgent },
  workflows: { 'code-review': codeReviewWorkflow },
  swarms: { 'dev-team': devTeamSwarm },
  config: {
    basePath: '/cogitator',
    enableWebSocket: true,
    enableSwagger: true,

    // Authentication — throw to reject (401); the returned context is available
    // as req.cogitator.auth and its userId is passed to agent runs.
    // Also applied to WebSocket upgrade requests.
    auth: async (req) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const user = await validateToken(token);
      return { userId: user.id, roles: user.roles };
    },

    // Rate limiting (in-memory, per process). windowMs must be positive and max
    // non-negative, otherwise the constructor throws. Requests without a client
    // address share a single bucket.
    rateLimit: {
      windowMs: 60000, // 1 minute
      max: 100, // 100 requests per window
      trustProxy: false, // true: key by the nearest X-Forwarded-For hop
    },

    // CORS — credentials default to true for explicit origins and to false for '*'.
    // `origin: '*'` with `credentials: true` reflects any origin with credentials;
    // only do that for trusted, non-cookie setups.
    cors: {
      origin: ['https://myapp.com'],
      credentials: true,
    },

    // Swagger customization
    swagger: {
      title: 'My AI API',
      description: 'AI-powered API endpoints',
      version: '1.0.0',
    },

    // Caps on what a request may ask a run for. A larger value is held to the cap,
    // a request without one gets the cap. Checked when the server is created.
    limits: { swarmTimeout: 120_000, workflowMaxIterations: 50, workflowMaxConcurrency: 4 },

    // 'deny' answers 401 to callers without a userId. Health, ready and the docs stay open.
    anonymous: 'deny',

    // Called with the auth context and the thread of every request that names one.
    // false answers 403 THREAD_FORBIDDEN and no run starts.
    authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}:`),

    // Dependencies for the tools of HTTP agent runs, streams and resumes (context.deps).
    // Built from the request on the server, never read from the body.
    deps: async (req) => ({ db: await tenantDb(req.get('x-tenant')) }),

    // WebSocket runs build theirs from the upgrade request, a plain Node IncomingMessage.
    websocket: { deps: async (req) => ({ db: await tenantDb(req.headers['x-tenant']) }) },
  },
});
```

### Multiple users

When `auth` returns a `userId`, everything a caller does with threads is scoped to it:

- Agent runs and streams (REST and WebSocket) pass the `userId` to `cogitator.run()`, so a thread created by a run belongs to that user and a `threadId` owned by someone else is refused.
- `GET /threads/:id`, `POST /threads/:id/messages` and `DELETE /threads/:id` check the thread's owner first; `POST` to an unknown id creates the thread owned by the caller.
- Another user's thread answers `403` with code `THREAD_ACCESS_DENIED`, and its messages are neither returned nor changed.
- Threads created earlier without an owner (no `userId`) stay open only to callers without a `userId`, such as servers with no `auth` configured.
- `authorizeThread(auth, threadId)` adds your own rule on top of ownership, for shared or team threads. It runs on every route that names a thread (agent run, stream and resume, swarm run and stream, `GET`, `DELETE` and `POST /threads/:id/messages`) and on WebSocket runs with a `threadId`, after the body is validated and before core checks the owner. Answering `false` refuses with `403 THREAD_FORBIDDEN`, and no run starts.
- `anonymous: 'deny'` refuses every caller whose `auth` gave no `userId` with `401 UNAUTHORIZED`, WebSocket upgrades included. `/health`, `/ready`, `/openapi.json` and `/docs` stay open. An unknown path under the base path answers `401` too, so an anonymous caller cannot probe which routes exist, and `404 NOT_FOUND` once the caller has a `userId`. The default, `'allow'`, lets anonymous callers in as before, and an unknown path answers `404 NOT_FOUND` in the error envelope.

### Limits and deps

`limits` caps what a client may ask a run for: `swarmTimeout` (ms), `workflowMaxIterations` and `workflowMaxConcurrency`. A request is never refused over a limit: it gets the smaller of what it asked for and the limit, or the limit when it asked for nothing, over HTTP and SSE alike. The OpenAPI spec shows each limit as the default of its field. Each limit must be a positive integer, or the constructor throws.

`deps: (req) => deps` builds the dependencies agent tools read as `context.deps` (a database handle, a tenant, a client), and the HTTP run, stream or resume gets them as `deps`. They are built on the server for each request and never come from the body. An error the hook throws is answered like a run error, before a stream starts.

WebSocket runs and resumes take theirs from `websocket.deps: (req) => deps`, called for each run with the upgrade request. That request is a plain Node `IncomingMessage` that never went through Express, so it has `headers`, `url` and `socket` but no `req.get()` and nothing a middleware adds, which is why it gets a hook of its own. Without `websocket.deps` WebSocket runs get no deps. An error it throws (or one `authorizeThread` throws) answers `{ type: 'error', id, error }` and starts no run.

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

## SSE Streaming

The `/agents/:name/stream` endpoint returns Server-Sent Events:

```typescript
// Client-side
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

While an SSE stream is open it writes a `: keep-alive` comment every `sseHeartbeatMs` (5 s by default, `0` turns it off), which SSE clients skip, so a proxy or load balancer does not close a stream that waits on a slow tool or model (nginx closes a connection silent for 60 s).

Events: `start`, `text-start`/`text-delta`/`text-end`, `tool-call-start`/`tool-call-delta`/`tool-call-end` (with the model's tool call id), `tool-result` (`toolCallId` matches the call), `approval-required`, `interrupt-required`, `error` (`{ message, code }`), and `finish` with the run's `usage` (the same object as the JSON answer), followed by `data: [DONE]`.

When the agent sets `reasoning: { summary: true }` and the provider returns a reasoning summary, it streams as its own part: `reasoning-start`, `reasoning-delta` (`{ id, delta }`), `reasoning-end`. A reasoning part is always closed before text or a tool call starts, so reasoning and text parts never interleave.

## Resumable streams

With `resumableStreams` on, a client that loses the stream of `/agents/:name/stream` or `/agents/:name/resume/stream` (a flaky network, a tab that went to sleep) gets back what it missed, and the run goes on while it is away:

```typescript
const server = new CogitatorServer({
  app,
  cogitator,
  agents: { chat: chatAgent },
  config: {
    resumableStreams: true,
  },
});
```

- Every event carries an SSE `id`, `<streamId>:<seq>` with `seq` from 1 up. Heartbeat comments carry none.
- A client that disconnects no longer stops the run. Its events keep going into the store.
- The same route with `Last-Event-ID: <id>` reconnects instead of starting a run, and the body is not read: the answer replays the events after that id with their ids, then follows the run to `finish` (and `data: [DONE]`) or `error`. Several clients may follow one stream. `?lastEventId=<id>` works too, for clients that cannot set headers, but it puts the id into URLs and access logs, so prefer the header.
- `DELETE /agents/:name/stream/:streamId` cancels the run (`204`): its stream ends with an `error` event `STREAM_CANCELLED`. The stream id is the part of an event id before the last `:`.
- A stream is bound to the caller who started it: every field of what `auth` returned (user id, roles, permissions, metadata such as a tenant), so callers without a user id are told apart too. Give `owner: (auth) => key` to bind it to fewer fields, such as the user id alone when the identity carries a token expiry. Anyone else, an unknown or expired stream and an event id the stream never sent get `404 STREAM_NOT_FOUND` before any SSE header, an id that is not `<streamId>:<seq>` gets `400 INVALID_INPUT`. `authorizeThread` is asked about the stream's thread on every reconnect and cancel (`403 THREAD_FORBIDDEN`).
- A reconnect after events that are no longer kept (more than `maxEvents` since) gets one `error` event with `STREAM_RESUME_GAP`: fetch the thread (`GET /threads/:id`) to catch up. A client that reads slowly holds at most `maxEvents` events and catches up from the store.
- A run nobody follows for `detachedTimeoutMs` (5 minutes by default) is stopped, so a client that never comes back does not run up cost, and so is every run when `until` aborts (pass the signal your server stops on). Such a stream ends with an `error` event `STREAM_ABORTED`.
- A stream whose run goes on is never evicted: when `maxStreams` streams all go on, a new one is refused with `503 STREAM_LIMIT_REACHED`.

`true` keeps the events in the memory of the process: 1000 events of each stream, a finished stream for 5 minutes, 1000 streams at once (`maxEvents`, `retentionMs`, `maxStreams`). Behind a load balancer with several processes, pass a `store` they share (`StreamReplayStore` from `@cogitator-ai/server-shared`, backed by Redis or similar with pub/sub), so a reconnect or a cancel that lands on another process reaches the stream and its run. Off by default: no ids, and a client that disconnects stops the run.

## WebSocket Support

Enable real-time bidirectional communication (requires the optional `ws` package):

```typescript
import { createServer } from 'http';

const server = new CogitatorServer({
  // ...
  config: {
    enableWebSocket: true,
    websocket: { path: '/api/ws', pingInterval: 30000, maxPayloadSize: 1024 * 1024 },
  },
});

await server.init();

const httpServer = createServer(app);
await server.attachWebSocket(httpServer); // defaults to `${basePath}/ws`
httpServer.listen(3000);
```

`attachWebSocket` throws if `enableWebSocket` is off, `init()` has not run, or `ws` is not installed. The configured `auth` function runs on the upgrade request (rejected with 401 when it throws, or when it gives no `userId` under `anonymous: 'deny'`). A `run` or `resume` on a thread `authorizeThread` refuses answers `{ type: 'error', id, error }` without starting, and `websocket.deps` is called with the upgrade request. For custom setups, `setupWebSocket(httpServer, routeContext, config)` is also exported.

Protocol:

| Message                                                                             | Direction     | Description                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: 'run', id, payload: { type: 'agent', name, input, context?, threadId? } }` | Client→Server | Run an agent; events arrive as `{ type: 'event', id, payload }` (`token`, `reasoning`, `tool-call`, `tool-result`, `complete`, `cancelled`) |
| `{ type: 'resume', id, payload: { name, threadId, decisions?, defaultDecision? } }` | Client→Server | Resume a run paused for tool approvals; events arrive like those of `run`                                                                   |
| `{ type: 'stop' }`                                                                  | Client→Server | Abort the client's running agent (emits `cancelled`)                                                                                        |
| `{ type: 'subscribe', channel: 'agent:<name>' }`                                    | Client→Server | Receive events of runs of that agent started by the same user elsewhere, on threads `authorizeThread` allows                                |
| `{ type: 'unsubscribe', channel }`                                                  | Client→Server | Stop receiving channel events                                                                                                               |
| `{ type: 'ping' }`                                                                  | Client→Server | Answered with `{ type: 'pong' }`                                                                                                            |
| `{ type: 'subscribed' \| 'unsubscribed', id, channel }`                             | Server→Client | Subscription confirmed (at most 64 channels per connection)                                                                                 |
| `{ type: 'error', id?, error }`                                                     | Server→Client | Invalid message or payload, unknown agent, or a failed run                                                                                  |

Only agent runs are supported over WebSocket, use the HTTP endpoints for workflows and swarms. A new `run` from the same connection aborts the previous one. A failed run reports a `CogitatorError`'s message, any other error is logged and sent as `Internal server error`. The server pings every `pingInterval` ms and terminates clients that miss a pong.

A subscriber gets the events of a run only when it has the `userId` of the caller who started it and, with `authorizeThread` set, when `authorizeThread(subscriberAuth, threadId)` allows it on the run's thread (the `threadId` of the run, or the one core created for it). The answer is asked once per subscriber and run, and a subscriber it refuses, or throws for, gets none of the run's events. Without `authorizeThread`, callers without a `userId` share the events of each other's runs, so set `authorizeThread` or `anonymous: 'deny'` when anonymous callers must not see each other.

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
```

## Custom Middleware

Use built-in middleware factories or create your own:

```typescript
import {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createCorsMiddleware,
  errorHandler,
} from '@cogitator-ai/express';

// Use individually
app.use(
  '/api',
  createAuthMiddleware(async (req) => {
    // Custom auth logic
  })
);

app.use(
  '/api',
  createRateLimitMiddleware({
    windowMs: 60000,
    max: 100,
    keyGenerator: (req) => req.headers['x-api-key'] as string,
    trustProxy: false, // set true if behind a trusted reverse proxy
  })
);
```

## Custom Routes

Create custom routes with streaming support:

```typescript
import { Router } from 'express';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '@cogitator-ai/express';

const router = Router();

router.post('/custom/stream', async (req, res) => {
  setupSSEHeaders(res);
  const writer = new ExpressStreamWriter(res);
  const messageId = generateId('msg');
  const textId = generateId('txt');

  // Use res.on('close') (not req.on('close'), which fires once the body is read)
  res.on('close', () => writer.close());

  writer.start(messageId);
  writer.textStart(textId);

  // Your streaming logic
  writer.textDelta(textId, 'Hello ');
  writer.textDelta(textId, 'World!');

  writer.textEnd(textId);
  writer.finish(messageId);
  writer.close();
});
```

## API Reference

### CogitatorServer

```typescript
class CogitatorServer {
  constructor(options: CogitatorServerConfig);
  init(): Promise<void>;
  attachWebSocket(server: http.Server): Promise<WebSocketServer>;
  readonly isInitialized: boolean;
}
```

### CogitatorServerConfig

```typescript
interface CogitatorServerConfig {
  app: Router;
  cogitator: Cogitator;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow>;
  swarms?: Record<string, SwarmConfig>;
  config?: {
    basePath?: string; // Default: '/cogitator'
    enableWebSocket?: boolean; // Default: false
    enableSwagger?: boolean; // Default: true
    auth?: AuthFunction;
    rateLimit?: RateLimitConfig;
    cors?: CorsConfig;
    swagger?: SwaggerConfig;
    websocket?: WebSocketConfig;
    sseHeartbeatMs?: number; // Default: 5000, 0 turns SSE heartbeats off
    acceptContext?: boolean | string[]; // context keys clients may send: none by default, a list, or true for any
    threadMessageRoles?: ('user' | 'assistant' | 'system')[]; // roles of POST /threads/:id/messages, default user and assistant
    limits?: RunLimits; // { swarmTimeout?, workflowMaxIterations?, workflowMaxConcurrency? }
    anonymous?: 'allow' | 'deny'; // Default: 'allow'
    authorizeThread?: (
      auth: AuthContext | undefined,
      threadId: string
    ) => boolean | Promise<boolean>;
    deps?: (req: Request) => unknown | Promise<unknown>; // HTTP runs, WebSocket runs use websocket.deps
    workflowCheckpoints?: CheckpointStore; // workflow checkpoints and /resume, none by default
    resumableStreams?: boolean | ResumableStreamOptions; // see Resumable streams, off by default
  };
}

interface WebSocketConfig {
  path?: string; // Default: `${basePath}/ws`
  pingInterval?: number; // Default: 30000
  maxPayloadSize?: number; // Default: 1 MiB
  deps?: (req: IncomingMessage) => unknown | Promise<unknown>; // deps of WebSocket runs, from the upgrade request
}
```

`CogitatorServer` writes nothing to the console when it starts. `init()` and the WebSocket setup report through the core logger at `debug` level (`getLogger()` from `@cogitator-ai/core`, `LOG_LEVEL=debug` to see them, or `setLogger()` to route them into your own logger). Errors are still logged.

### ExpressStreamWriter

```typescript
class ExpressStreamWriter {
  constructor(res: Response);
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
  close(): void;
  readonly isClosed: boolean;
}
```

Writes after the response has ended (or the client disconnected) are ignored.

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

- `INVALID_INPUT` → 400 (validation errors and malformed JSON bodies)
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

A `CogitatorError` keeps its message and code and answers with its own `statusCode`, which is the code's mapped status unless the error was given another (for example `LLM_RATE_LIMITED` → 429). When it says when to retry (`retryAfter`, as provider rate limits do), the answer carries `Retry-After` in whole seconds. The mapping is `describeHttpError` of `@cogitator-ai/server-shared`, so Express, Fastify, Hono, Koa and Next answer the same error the same way. Any other error is logged on the server and answered as `500 Internal server error`, so connection strings, file paths and other internals never reach the client. The same mapping applies to a failed workflow, and the same masking to SSE `error` events, the `node_error`/`agent_error` stream events and WebSocket run errors.

## Documentation

Full guide: [cogitator.app/docs/server-adapters/express](https://cogitator.app/docs/server-adapters/express). Tool approvals: [cogitator.app/docs/tools/approvals](https://cogitator.app/docs/tools/approvals).

## License

MIT
