# @cogitator-ai/a2a

Native implementation of the [A2A (Agent2Agent) protocol](https://a2a-protocol.org/) for Cogitator, [1.0](https://a2a-protocol.org/v1.0.0/specification/) and [0.3](https://a2a-protocol.org/v0.3.0/specification/) on one server. Expose agents as A2A services or connect to any A2A agent, whatever framework it is built with. Every response is checked against the official 1.0.0 and 0.3.0 JSON schemas in the test suite, and the official A2A JavaScript SDK (1.3 for protocol 1.0, 0.3 for 0.3) talks to `A2AServer` (and `A2AClient` to an SDK server) in it.

## Installation

```bash
pnpm add @cogitator-ai/a2a @cogitator-ai/core
```

`@cogitator-ai/core` is needed for `A2AServer` (it runs your agents) and for `asTool()`. Install the framework you mount the server on (`express`, `hono`, `fastify`, `koa` or `next`), they are optional peer dependencies.

## Features

- **A2A 1.0 and 0.3 at once** - The `A2A-Version` header picks the version of each request, a request without it speaks 0.3
- **A2AServer** - Expose any Cogitator agent over JSON-RPC (1.0 and 0.3) and the A2A 1.0 HTTP+JSON (REST) binding
- **A2AClient** - Talk to any A2A agent: it speaks 1.0 when the card offers it, else 0.3, over JSON-RPC or HTTP+JSON
- **asTool() Bridge** - Wrap remote A2A agents as local Cogitator tools
- **Agent Card** - Generated from agent metadata at `/.well-known/agent-card.json`, one card and endpoint per agent, served with `ETag` and `Cache-Control`
- **Tenants** - Over 1.0 every agent is a tenant: its interfaces name it, and its tasks are visible only through it
- **ListTasks** - Cursor pagination over the caller's tasks, `totalSize`, filters by state, context and time
- **Extensions** - Declared in the card, asked for with `A2A-Extensions`, required ones enforced
- **Task lifecycle** - `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`
- **Authentication** - Bearer or API-key auth on every adapter, declared in the card's `securitySchemes`, answered with HTTP 401
- **Per-user tasks** - `auth.validate` can return `{ userId }` to keep each caller's tasks, contexts and memory apart
- **Multi-turn** - `input-required` tasks take the client's answer, new tasks in a `contextId` carry the conversation on
- **SSE streaming** - Every event is a JSON-RPC response, the reply streams token by token as artifact chunks
- **Push notifications** - The task is POSTed to the client's webhook on every status change
- **Agent Card signing** - JWS with a private key (ES256, RS256, PS256, EdDSA) over the JCS of the 1.0 card, JWKS at `/.well-known/jwks.json`
- **Authenticated extended card** - `GetExtendedAgentCard` (0.3: `agent/getAuthenticatedExtendedCard`)
- **Tool approvals** - Paused runs wait in `input-required` with the calls in a data part
- **Tool questions** - Questions tools ask with `context.interrupt()` reach the client in a data part, its answer resumes the run
- **RedisTaskStore** - Production-grade task persistence
- **Framework adapters** - Express, Hono, Fastify, Koa, Next.js
- **No A2A SDK dependency** - Own implementation of the spec (runtime deps: `@cogitator-ai/types`, `@cogitator-ai/server-shared`, `zod`)

---

## Quick Start

### Expose an Agent via A2A

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { A2AServer } from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import express from 'express';

const cogitator = new Cogitator();
const agent = new Agent({
  name: 'researcher',
  description: 'Research agent',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You are a research assistant.',
});

const a2aServer = new A2AServer({
  agents: { researcher: agent },
  cogitator,
});

const app = express();
app.use(a2aExpress(a2aServer));
app.listen(3000);
// Agent Card: GET  /.well-known/agent-card.json
// JSON-RPC:   POST /a2a        (1.0 with A2A-Version: 1.0, else 0.3)
// HTTP+JSON:  /a2a/rest/...    (1.0)
```

`basePath` (default `/a2a`, must start with `/`) is the JSON-RPC path the adapters serve, relative to where they are mounted. It is readable as `a2aServer.basePath`.

The card's `url` is the absolute address of the agent's endpoint, as the specification requires. Without `cardUrl` the adapters derive it from the request that fetches the card (scheme, host and mount path). Behind a proxy that changes the host or the path, set `cardUrl` to the public URL of the endpoint, e.g. `https://agents.example.com/a2a`.

Cards also declare the agent `version` (`agentVersion`, default `1.0.0`) and, with `provider: { organization, url }`, who runs it. The description is the agent's `description` (its name when unset), never its instructions. Its tools are its skills, and an agent without tools gets one `chat` skill, as A2A 1.0 needs a card to list one.

## Protocol Versions

One server speaks A2A 1.0 and A2A 0.3 on the same endpoints. A request names its version in the `A2A-Version` header (or an `A2A-Version` query parameter) as `Major.Minor`, a request without one speaks 0.3, as the specification says. So every A2A 0.3 client keeps working unchanged, and an A2A 1.0 client gets the PascalCase methods, the ProtoJSON model (no `kind`, `ROLE_USER`, `TASK_STATE_COMPLETED`, one `Part` with `mediaType`), `google.rpc` error details and the REST binding. A version the server does not speak is refused with `-32009` (HTTP 400 on REST), its `ErrorInfo` listing the supported ones.

| Option             | Default            | Effect                                                            |
| ------------------ | ------------------ | ----------------------------------------------------------------- |
| `protocolVersions` | `['1.0', '0.3']`   | The versions the server speaks. `['0.3']` restores the old one    |
| `restPath`         | `<basePath>/rest`  | Where the HTTP+JSON binding is served. `false` turns it off       |
| `extensions`       | the Cogitator ones | More extensions the cards declare (see [Extensions](#extensions)) |

The card at `/.well-known/agent-card.json` comes in the version the client asks for. Without `A2A-Version` it is the A2A 0.3 card (`protocolVersion`, `url`, `preferredTransport`) with every interface of both versions added in `supportedInterfaces`, so any client finds its endpoint. With `A2A-Version: 1.0` it is the pure A2A 1.0 card. Interfaces come in the order clients should prefer them: JSON-RPC 1.0, HTTP+JSON 1.0, JSON-RPC 0.3. Card responses carry `Vary: A2A-Version`, an `ETag` (the SHA-256 of the body), `Cache-Control: public, max-age=300`, and a request with a matching `If-None-Match` gets `304`.

The server keeps one model of every task, so a task created over 0.3 is readable over 1.0 and back. `TaskStore` and `RedisTaskStore` are unchanged. A2A 1.0 `data` parts may hold any JSON value: a value that is not an object is kept as `{ value }` with the part metadata key `cogitator:dataValue`, the only form a 0.3 data part has, and comes back bare over 1.0.

## HTTP+JSON Binding

The A2A 1.0 REST binding is served under `restPath`, with the routes of the proto's `google.api.http` bindings. Every route also exists under `/<tenant>/`:

| Route                                                 | Method                         |
| ----------------------------------------------------- | ------------------------------ |
| `POST /message:send`                                  | `SendMessage`                  |
| `POST /message:stream`                                | `SendStreamingMessage` (SSE)   |
| `GET /tasks/{id}`                                     | `GetTask` (`?historyLength=`)  |
| `GET /tasks`                                          | `ListTasks` (query parameters) |
| `POST /tasks/{id}:cancel`                             | `CancelTask`                   |
| `GET` or `POST /tasks/{id}:subscribe`                 | `SubscribeToTask` (SSE)        |
| `POST /tasks/{taskId}/pushNotificationConfigs`        | Create a push config (`201`)   |
| `GET /tasks/{taskId}/pushNotificationConfigs`         | List push configs              |
| `GET /tasks/{taskId}/pushNotificationConfigs/{id}`    | Get a push config              |
| `DELETE /tasks/{taskId}/pushNotificationConfigs/{id}` | Delete a push config (`204`)   |
| `GET /extendedAgentCard`                              | `GetExtendedAgentCard`         |

Bodies are `application/a2a+json` or `application/json`, query parameters camelCase. The binding speaks only 1.0, so a request needs `A2A-Version: 1.0`. Errors are `google.rpc.Status` bodies, `{ error: { code, status, message, details } }`, with the HTTP status of the specification: `404` for a missing task, `400` for invalid params and the A2A errors of a refused operation, `401` for missing credentials, `500` for server errors. Streams are SSE whose events are `StreamResponse` objects, and a failure during a stream ends it with an `event: error` frame. Custom integrations call `a2aServer.handleRest({ method, path, query, body, authToken })`.

## Tenants

Over A2A 1.0 every agent is a tenant: its interfaces carry its name as `tenant`, and a client sends it back in every request (`tenant` in the JSON-RPC params, `/<tenant>/` in the REST path). On the shared endpoint the tenant picks the agent, on an agent's own endpoint a different tenant is refused with `-32602`. A task belongs to the agent that created it: over 1.0 it is visible only through that agent, so a task of `writer` is not found through `researcher`. Tasks stored before this version recorded their agent stay visible to every agent, and 0.3 requests see every task as before. The agent is kept in the task metadata (`cogitator:agent`) and never sent to clients.

### Several agents on one server

Every agent gets its own card and endpoint, so any A2A client reaches it by URL:

| Route                                                | Serves                                                  |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `GET /.well-known/agent-card.json`                   | Card of the first agent                                 |
| `POST <basePath>`                                    | First agent (or the one named by an `agentName` param)  |
| `GET <basePath>/<agent>/.well-known/agent-card.json` | Card of `<agent>`                                       |
| `POST <basePath>/<agent>`                            | `<agent>`                                               |
| `GET /.well-known/agent.json`                        | Pre-v0.3 card path: the card, or every card in an array |

```typescript
// any A2A v0.3 client
const writer = await new ClientFactory().createFromUrl('https://my-server.com/a2a/writer/');
// this package
const writerClient = new A2AClient('https://my-server.com', { agentName: 'writer' });
```

### Connect to a Remote A2A Agent

```typescript
import { A2AClient } from '@cogitator-ai/a2a';

const client = new A2AClient('https://remote-agent.example.com');

// Discover
const card = await client.agentCard();
console.log(card.name, card.skills);

// Send a message: the server answers with a task (or a direct reply message)
const result = await client.sendMessage({
  role: 'user',
  parts: [{ kind: 'text', text: 'Research quantum computing' }],
});
if (result.kind === 'task') console.log(result.status.state);

// Stream
for await (const event of client.sendMessageStream({
  role: 'user',
  parts: [{ kind: 'text', text: 'Analyze market trends' }],
})) {
  console.log(event.kind, event);
}
```

The client fills in `kind: 'message'` and a fresh `messageId` when a message leaves them out. It reads the card at `/.well-known/agent-card.json` (falling back to `/.well-known/agent.json` for servers before v0.3) and talks to the interface the card names. Its API speaks the A2A 0.3 model whatever the wire version, so code written for 0.3 keeps working against a 1.0 server.

By default (`protocolVersion: 'auto'`) the client speaks A2A 1.0 when the card offers a 1.0 interface: a hybrid card of a Cogitator server, or a pure 1.0 card. It takes the first 1.0 interface the card lists, or the one of the `transport` you prefer, and sends that interface's `tenant` in every request. A card with only 0.3 fields keeps it on JSON-RPC 0.3. `protocolVersion: '0.3'` keeps a client on 0.3 against any server, `'1.0'` refuses a server without a 1.0 interface (`-32009`). `await client.endpoint()` tells what it chose: `{ protocolVersion, transport, url, tenant? }`.

`A2AClient` options: `headers` (sent with every request, e.g. `Authorization`), `timeout` (ms, default `30000`), `agentCardPath` (a card path relative to the base URL, no fallback), `rpcPath` (send requests to this JSON-RPC path at the base URL instead of the card's interface, without reading the card, as 0.3 unless `protocolVersion: '1.0'`), `agentName` (an agent of a Cogitator server hosting several: the client uses that agent's own card and endpoint), `protocolVersion`, `transport` (`'JSONRPC'` or `'HTTP+JSON'`) and `extensions` (URIs sent in `A2A-Extensions`).

Other calls: `getTask(id, historyLength?)`, `cancelTask(id)`, `resubscribeTask(id)` (reconnect to a task's stream), `continueTask(id, text)`, `answerApprovals(id, decisions)`, `answerQuestions(id, responses)`, `listTasks(filter?)`, `listTasksPage(query?)` (1.0) and the push notification calls below.

### Use Remote Agent as a Tool

```typescript
const client = new A2AClient('https://research-agent.example.com');
const card = await client.agentCard();
const remoteTool = client.asToolFromCard(card);

const orchestrator = new Agent({
  name: 'orchestrator',
  model: 'openai/gpt-6.1-sol',
  instructions: 'Use the researcher for information gathering.',
  tools: [remoteTool],
});

const result = await cogitator.run(orchestrator, {
  input: 'Write a report on AI trends',
});
```

`asToolFromCard` names the tool after the card, made into a name every LLM provider accepts (`Research Agent` becomes `Research_Agent`). Pass `{ name }` to choose it yourself.

The tool returns `{ output, success, error?, taskId?, state?, pendingApprovals?, pendingQuestions? }`. `output` is the remote agent's answer: the text of the task's status message, else of its last agent message, else of its artifacts. When the remote task waits on the client (`state: 'input-required'`), `success` is `false`, `output` carries the remote agent's question and `taskId` lets you answer with `client.continueTask()`. A remote task waiting for [tool approvals](#tool-approvals) lists the calls in `pendingApprovals`, one waiting on [questions of its tools](#tool-questions) lists them in `pendingQuestions`. The run's abort signal and the tool timeout are forwarded to the HTTP request.

## Authentication

Protect the JSON-RPC endpoints with a bearer token or an API key. Every framework adapter extracts the credential from the request headers (`Authorization: Bearer <token>` or the API-key header) and the server validates it before routing. The Agent Card declares the scheme in `securitySchemes` and `security`.

```typescript
const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  auth: {
    type: 'bearer', // or 'apiKey' (header: 'x-api-key' unless headerName is set)
    validate: async (token) => token === process.env.A2A_TOKEN,
  },
});

const client = new A2AClient('https://remote-agent.example.com', {
  headers: { Authorization: `Bearer ${process.env.A2A_TOKEN}` },
});
```

A missing credential or a `validate` that returns `false` is answered with HTTP `401` (with `WWW-Authenticate: Bearer` for bearer auth) and the JSON-RPC error `-32000 Unauthorized`, for streaming methods too.

Over A2A 1.0 the error carries an `ErrorInfo` with the reason `UNAUTHENTICATED`, and REST answers `401` with `status: 'UNAUTHENTICATED'`.

Custom integrations can call `a2aServer.getAuthToken((name) => headers.get(name))` and pass the result to `handleJsonRpc(body, token, options)` or `handleJsonRpcStream(body, token, signal, options)`. `options.protocolVersion: '1.0'` takes the 1.0 methods, `options.extensions` the extensions the client asked for.

### One caller per user

When several users or tenants share the server, have `validate` return who the caller is (`{ userId }`) instead of `true`:

```typescript
const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  auth: {
    type: 'bearer',
    validate: async (token) => {
      const session = await sessions.find(token);
      return session ? { userId: session.userId } : false;
    },
  },
});
```

Each task then belongs to the user who created it:

- `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, the `tasks/pushNotificationConfig/*` methods (and their 1.0 counterparts) and a message that continues the task (`taskId`) answer another user's task with `-32001 Task not found`.
- `tasks/list` and `ListTasks` return only the caller's own tasks and tasks without an owner. The server sets `TaskFilter.visibleTo` itself, whatever the client sends.
- A new message with a `contextId` that holds another user's tasks is refused with `-32602 Invalid params`.
- Runs carry the `userId`, so the agent's threads and memory are scoped to the user too.

Returning `true` admits the caller without a user: every such caller shares one space and sees only tasks without an owner. The owner is kept in the task's metadata and never sent to clients. A custom `TaskStore` must honour `filter.visibleTo` in `list()` (`InMemoryTaskStore` and `RedisTaskStore` do).

## Send Configuration

`sendMessage(message, configuration)` takes the A2A `MessageSendConfiguration`:

| Option                   | Effect                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `blocking: false`        | Return the task at once (`submitted`), poll `getTask` or use a webhook  |
| `historyLength`          | Return only the last N history messages (`0` = none), also on `getTask` |
| `acceptedOutputModes`    | Only return artifacts with a part of these MIME types                   |
| `pushNotificationConfig` | Register a webhook before the task starts executing                     |
| `timeout`                | Cogitator extension: a shorter run time limit in ms (see below)         |

Over A2A 1.0 the client sends these as the 1.0 `SendMessageConfiguration`: `blocking: false` is `returnImmediately: true`, the webhook is `taskPushNotificationConfig`, and `timeout` goes in the request metadata of the [run-timeout extension](#extensions) (`metadata["https://cogitator.app/a2a/extensions/run-timeout/v1"].timeoutMs`). A `historyLength` of `0` leaves the history out of a 1.0 task altogether.

```typescript
const task = await client.sendMessage(
  { role: 'user', parts: [{ kind: 'text', text: 'Long running analysis' }] },
  {
    blocking: false,
    pushNotificationConfig: { url: 'https://my-app.com/webhooks/a2a', token: 'my-secret' },
  }
);
// task.status.state === 'submitted', the finished task arrives at the webhook
```

`timeout` lets a client shorten a run, never lift or remove the operator's limit. It must be a positive integer, and the server caps it at the agent's own `timeout`, or at `maxRunTimeoutMs` (an `A2AServer` option, default `120000`, the Cogitator run default) for an agent without one. Without a client `timeout` the agent's own limit applies.

Client calls also accept request options: `client.sendMessage(message, config, { signal, timeout })`.

## Multi-Turn Conversations

A task that waits on the client (`input-required`) takes the answer as a message with its `taskId`. The server appends it to the task and runs the agent again with the task transcript:

```typescript
const task = await client.sendMessage({
  role: 'user',
  parts: [{ kind: 'text', text: 'Book a flight to Paris' }],
});

if (task.kind === 'task' && task.status.state === 'input-required') {
  // the question is in task.status.message
  const answered = await client.continueTask(task.id, 'Next Friday');
}
```

A task in a terminal state (`completed`, `failed`, `canceled`, `rejected`) can't be restarted, as the specification says: a message for it is refused with `-32004 Unsupported operation` over 1.0 (`-32600 Invalid request` over 0.3). Carry the conversation on with a new message in the same `contextId` instead:

```typescript
const first = await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] });
const next = await client.sendMessage({
  role: 'user',
  contextId: first.kind === 'task' ? first.contextId : undefined,
  parts: [{ kind: 'text', text: 'Tell me more' }],
});
```

Runs are threaded by `contextId` (`threadId`), and the agent gets the transcript of the earlier tasks of the context, so follow-ups work even without a memory adapter. Artifacts accumulate across the turns of a task. A task that is still running takes no second message.

## Tool Approvals

When the agent calls a tool that needs approval (`requiresApproval`), its run pauses and the task waits in `input-required`, never `completed`. Its status message says `Waiting for approval of <tools>` and carries the waiting calls in a data part (`{ kind: 'tool-approval-request', approvals: [{ toolCallId, toolName, arguments, description }] }`). The client answers with a `tool-approval-response` data part in the message that continues the task, and the server resumes the run with those decisions:

```typescript
import { readToolApprovalRequest } from '@cogitator-ai/a2a';

const task = await client.sendMessage({
  role: 'user',
  parts: [{ kind: 'text', text: 'Refund A-1' }],
});

const waiting = task.kind === 'task' ? readToolApprovalRequest(task) : undefined;
if (waiting) {
  const done = await client.answerApprovals(task.id, {
    decisions: { [waiting[0].toolCallId]: { approved: true } },
    // or defaultDecision: { approved: false, reason: 'not eligible' }
  });
}
```

`toolApprovalResponsePart({ decisions?, defaultDecision? })` builds the part for a hand-written message. Calls left without a decision keep the task waiting. A text reply instead of decisions moves on: the waiting calls are declined and the agent answers the new message. The task keeps the paused run's id and checkpoint, and the server resumes exactly that run through `cogitator.resume()` from the checkpoint (by the task's `contextId` when the Cogitator returns none). Before it resumes, it checks with `cogitator.pausedRun(contextId)` that the run still waits, so the paused run has to be where the server Cogitator keeps paused runs (its memory, or `runCheckpoints` shared by every server instance). `asTool()` reports such a remote task with `success: false`, the `taskId` and the calls in `pendingApprovals`.

## Tool Questions

A tool can stop the run to ask a person something with `context.interrupt({ reason, message, responseSchema })`. The task then waits in `input-required` too: its status message says the question and carries it in a data part (`{ kind: 'interrupt-request', questions: [{ id, reason, message, responseSchema?, expiresAt?, toolName? }] }`). The client answers by question id with an `interrupt-response` data part in the message that continues the task, and the server resumes the run with those answers:

```typescript
import { readInterruptRequest } from '@cogitator-ai/a2a';

const questions = task.kind === 'task' ? readInterruptRequest(task) : undefined;
if (questions) {
  const done = await client.answerQuestions(task.id, { [questions[0].id]: { ok: true } });
}
```

`interruptResponsePart(responses)` builds the part for a hand-written message. A task waiting on a single question also takes the continuing message itself as the answer: its first data part, else its text, read by the question's `responseSchema` with `parseAnswer()` from `@cogitator-ai/types` (`yes` for a boolean, `3` for a number, a member of an enum, a comma-separated list). The status message names the answer form after each question, such as `Go ahead? (yes or no)`. A text that does not answer, an answer the run refuses as not matching the schema (`INTERRUPT_ANSWER_INVALID`) and an interrupt response naming no waiting question keep the task in `input-required` with why, so the client can answer again. Other resume errors fail the task.

An answer after the question's `expiresAt` ends the task `failed`, its status message saying which question expired, and lifts the pause with `cogitator.cancelPause()` (the waiting calls answered as declined because the question expired), so the context goes on with its next message. A run that waits for approvals and questions at once carries both parts, and one message can answer both.

A new task in the same context starts a run on the context's thread, and the runtime answers the calls an earlier task's paused run waits on with "The user moved on". That earlier task then ends `canceled`, its status message saying a newer message moved on, instead of waiting in `input-required` on a run that is gone: answer a task's questions before sending the context something new. A message that continues the task itself without answering (plain text while several questions wait) moves on the same way, as a new turn of the task. `asTool()` reports such a remote task with `success: false`, the `taskId` and the questions in `pendingQuestions`.

## Listing Tasks

A2A 1.0 `ListTasks` pages through the caller's tasks of the agent, the most recently updated first (ties broken by id), behind a keyset cursor, so a page never repeats or skips a task that did not change meanwhile:

```typescript
const page = await client.listTasksPage({ state: 'completed', pageSize: 20 });
console.log(page.tasks.length, page.totalSize);
if (page.nextPageToken) {
  const next = await client.listTasksPage({ state: 'completed', pageToken: page.nextPageToken });
}
```

`pageSize` is 1 to 100 (default 50), `nextPageToken` is `''` on the last page, `totalSize` counts the matches of every page. `contextId`, `state` and `statusTimestampAfter` (an ISO time) filter, `historyLength` trims each history (`0` leaves it out), and artifacts come only with `includeArtifacts: true`. A page token the server did not issue is refused with `-32602`, its `BadRequest` naming `pageToken`. The cursor is base64url of `{ v: 1, t, id }` over `TaskStore.list()`, so any store works.

`tasks/list` is the A2A 0.3 Cogitator extension method with offset paging, and `client.listTasks(filter?)` lists every match (over 1.0 it walks the pages, with artifacts):

```typescript
const tasks = await client.listTasks();
const conversation = await client.listTasks({ contextId: 'ctx_abc123' });
const completed = await client.listTasks({ state: 'completed', limit: 10, offset: 0 });
```

## Streaming

`message/stream` answers with Server-Sent Events. Every event is a JSON-RPC response with the request `id` whose `result` is the task, a `status-update` or an `artifact-update`. The stream ends after the status update with `final: true` (a terminal state, `input-required` or `auth-required`). Over A2A 1.0 (`SendStreamingMessage`) every `result` is a `StreamResponse` (`{ task }`, `{ statusUpdate }` or `{ artifactUpdate }`) without `final`: the stream closes on the same states, and the client marks that update `final` for you:

```typescript
for await (const event of client.sendMessageStream({
  role: 'user',
  parts: [{ kind: 'text', text: 'Write a poem' }],
})) {
  switch (event.kind) {
    case 'task':
      console.log(`Task ${event.id}`);
      break;
    case 'artifact-update':
      for (const part of event.artifact.parts) {
        if (part.kind === 'text') process.stdout.write(part.text);
      }
      break;
    case 'status-update':
      console.log(`\nStatus: ${event.status.state}${event.final ? ' (final)' : ''}`);
      break;
  }
}
```

The reply streams token by token as chunks of one artifact: the first chunk starts it, the next ones have `append: true`, the last one `lastChunk: true`. When the final reply differs from the streamed text (text the model wrote before a tool call, for instance), the last chunk replaces the artifact (`append: false`) with the reply, so the artifact a client assembles is always the one `tasks/get` returns.

A request that fails before the stream starts (bad params, unknown task, missing credentials) is answered with a plain JSON-RPC error instead of a stream. A failure during the stream ends it with a JSON-RPC error response. `tasks/resubscribe` reconnects to the stream of a task: the task as it is now, then its updates while it still runs in this process. Its 1.0 form `SubscribeToTask` refuses a task that already ended with `-32004`, as the specification says.

The client `timeout` is an idle timeout between events (long runs are fine as long as events keep flowing), pass `{ signal }` as the third argument to cancel. When the client disconnects, the adapters abort the agent run.

## RedisTaskStore

For production deployments, use `RedisTaskStore` instead of the default in-memory store:

```typescript
import { A2AServer, RedisTaskStore } from '@cogitator-ai/a2a';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379');

const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  taskStore: new RedisTaskStore({
    client: redis,
    keyPrefix: 'a2a:task:',
    ttl: 86400, // 24h expiry
  }),
});
```

`RedisTaskStore` implements the full `TaskStore` interface including `list()` with filtering by `contextId`, `state`, pagination, and sorting by status time (ties broken by id, like `InMemoryTaskStore`, so the `ListTasks` cursor is stable). Updates are atomic when the client supports `eval` (Lua).

`InMemoryTaskStore` keeps at most `maxSize` tasks (default 10 000) and evicts the oldest finished tasks first.

## Push Notifications

Register a webhook and the server POSTs the task (as `tasks/get` returns it) to it on every status change:

```typescript
const client = new A2AClient('https://remote-agent.example.com');

const config = await client.setPushNotificationConfig(task.id, {
  url: 'https://my-app.com/webhooks/a2a',
  token: 'per-task-secret', // sent back in X-A2A-Notification-Token
  authentication: { schemes: ['Bearer'], credentials: 'my-webhook-token' },
});

const one = await client.getPushNotificationConfig(task.id, config.pushNotificationConfig.id);
const all = await client.listPushNotificationConfigs(task.id);
await client.deletePushNotificationConfig(task.id, config.pushNotificationConfig.id!);
```

The webhook gets `X-A2A-Notification-Token` with the config's `token`, and `Authorization: Bearer <credentials>` (or `Basic <credentials>`) for the first of `authentication.schemes` the server knows. Every config method requires an existing task the caller may see (otherwise `-32001 Task not found`). Use `configuration.pushNotificationConfig` with `blocking: false` to subscribe before execution starts.

A config keeps the protocol version it was registered with (never sent back to clients). A config registered over 0.3 gets the task as before. One registered over 1.0 gets a `StreamResponse`, `{ task }` in the 1.0 form, as `application/a2a+json`, with `Authorization: <scheme> <credentials>` for the one scheme of its `authentication` and the `X-A2A-Notification-Token` header.

Configs live in `InMemoryPushNotificationStore` unless you pass a `pushNotificationStore`, and cards declare `capabilities.pushNotifications: true`.

Webhook delivery is SSRF-hardened unless `allowPrivateUrls: true`: loopback, private, link-local, CGNAT, multicast and IPv4-mapped IPv6 targets are rejected, the check is applied to the address the socket actually connects to (no DNS-rebinding window), and redirects are not followed. `isPrivateAddress()` is exported for reuse.

## Agent Card Signing

Sign Agent Cards with a private key, as A2A 1.0 specifies (section 8.4): a JWS (RFC 7515, detached payload) whose protected header is `{ alg, typ: 'JOSE', kid, jku? }`, over the JCS (RFC 8785) of the card's A2A 1.0 form without `signatures` and without the fields ProtoJSON leaves out. That is the payload the official SDK signs and verifies, so its `verifyAgentCardSignature` checks a Cogitator card. Signing runs on `node:crypto` alone.

```typescript
import { createPrivateKey } from 'node:crypto';

const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  cardSigning: {
    alg: 'ES256', // RS256, PS256 or EdDSA
    privateKey: process.env.CARD_SIGNING_KEY!, // PEM, a private JWK, or a KeyObject
    kid: 'cards-2026',
    publishJwks: true, // serve the public key at /.well-known/jwks.json
    jku: 'https://agents.example.com/.well-known/jwks.json', // optional
  },
});

// Client-side
const client = new A2AClient('https://agents.example.com');
await client.verifyAgentCard({ keys: { 'cards-2026': publicKeyPem } }); // trusted keys by kid
await client.verifyAgentCard({ keys: jwks }); // or a JWKS
await client.verifyAgentCard({ resolveKey: async (kid, jku) => lookUp(kid) });
await client.verifyAgentCard({}); // fetch the JWKS of a jku on the card's own origin
await client.verifyAgentCard({ trustJku: ['https://keys.example.com'] }); // or of trusted origins
```

ES256 takes a P-256 key (signatures in IEEE P1363 form), RS256 and PS256 an RSA key, EdDSA an Ed25519 or Ed448 key, and a key that does not fit the algorithm is refused at construction. The 1.0 card and the hybrid card carry the same signature: it covers the 1.0 form, which the hybrid card holds as well. Signatures are kept per payload, so an unchanged card keeps its signature and its `ETag` even with randomized ECDSA signatures. `verifyAgentCardJws(card, options)` checks any card (1.0, hybrid or 0.3) without a client. A `jku` is fetched only from the card's own origin unless `trustJku` lists other origins, never otherwise.

The shared-secret form `cardSigning: { secret }` (HMAC `HS256` over each served card) still works and is deprecated: anyone who can check such a signature can forge it. `verifyAgentCardSignature(card, secret)` and `client.verifyAgentCard(secret)` check it.

## Authenticated Extended Agent Card

Serve a more detailed card to authenticated clients with `agent/getAuthenticatedExtendedCard`:

```typescript
const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  auth: { type: 'bearer', validate: async (token) => token === process.env.A2A_TOKEN },
  extendedCardGenerator: (agentName) => ({
    ...a2aServer.getAgentCard(agentName),
    skills: [
      {
        id: 'deep_research',
        name: 'Deep research',
        description: 'Multi-source deep research',
        tags: ['research'],
      },
    ],
  }),
});

const client = new A2AClient('https://remote-agent.example.com', {
  headers: { Authorization: `Bearer ${process.env.A2A_TOKEN}` },
});
const extendedCard = await client.extendedAgentCard();
```

The public card declares `supportsAuthenticatedExtendedCard: true` (1.0: `capabilities.extendedAgentCard: true`) when `extendedCardGenerator` is set. Without it the 0.3 method answers `-32007 Authenticated Extended Card not configured`, and the 1.0 method `GetExtendedAgentCard` answers `-32004`, as for any capability the card does not declare. Over 1.0 the generated card comes in its 1.0 form, with the agent's interfaces unless it lists its own in `supportedInterfaces`.

## Extensions

Cards declare their extensions in `capabilities.extensions`. Every Cogitator agent supports three, none required:

| URI                                                      | What it is                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `https://cogitator.app/a2a/extensions/tool-approvals/v1` | [Tool approvals](#tool-approvals) in data parts                         |
| `https://cogitator.app/a2a/extensions/interrupts/v1`     | [Tool questions](#tool-questions) in data parts                         |
| `https://cogitator.app/a2a/extensions/run-timeout/v1`    | A shorter run: `metadata[uri].timeoutMs` (0.3: `configuration.timeout`) |

Declare your own with `extensions: [{ uri, description, required, params }]`. A client asks for extensions in the `A2A-Extensions` header (`X-A2A-Extensions` in 0.3, comma-separated), and the response names the ones the agent supports in the same header. A message that does not ask for a `required` extension is refused with `-32008 Extension support required` (HTTP 400 on REST). The constants `TOOL_APPROVALS_EXTENSION`, `INTERRUPTS_EXTENSION` and `RUN_TIMEOUT_EXTENSION` are exported, and `A2AClient` takes `extensions` to ask for some on every request.

## Framework Adapters

```typescript
// Express
import { a2aExpress } from '@cogitator-ai/a2a/express';
app.use(a2aExpress(server));

// Hono
import { a2aHono } from '@cogitator-ai/a2a/hono';
app.route('/', a2aHono(server));

// Fastify
import { a2aFastify } from '@cogitator-ai/a2a/fastify';
fastify.register(a2aFastify(server));

// Koa (reads the body itself when no body parser did)
import { a2aKoa } from '@cogitator-ai/a2a/koa';
app.use(a2aKoa(server));

// Next.js: one catch-all route serves everything by the request path,
// app/[[...a2a]]/route.ts
import { a2aNext } from '@cogitator-ai/a2a/next';
export const { GET, POST, DELETE } = a2aNext(server);
// or app/.well-known/agent-card.json/route.ts exports GET, app/a2a/route.ts exports POST
// (and app/a2a/[agent]/route.ts serves each agent's own endpoint)
```

All adapters serve the routes listed [above](#several-agents-on-one-server), the [HTTP+JSON binding](#httpjson-binding) under `restPath` and the JWKS when the server publishes one, parse `application/a2a+json` bodies (Fastify gets a content type parser for it), stream only for `message/stream` and `tasks/resubscribe` (1.0: `SendStreamingMessage` and `SubscribeToTask`) (an `Accept: text/event-stream` header alone does not switch `message/send` to SSE), answer JSON-RPC notifications with `204`, a request that is not `application/json` with `415`, and pass the request credentials to the server. While a stream is open they write a `: keep-alive` comment every `sseHeartbeatMs` (an `A2AServer` option, 5 seconds by default, `0` turns it off), so a proxy or Bun's idle timeout does not cut a run that waits on a slow tool. Structurally invalid JSON-RPC requests get `-32600 Invalid Request`, only unparseable JSON gets `-32700 Parse error`.

Errors that are neither A2A errors nor `CogitatorError`s (in parsing, authentication, routing, streams or agent runs) are logged on the server and answered as `-32603 Internal error`, without their text. A `CogitatorError` is answered as `-32603 Internal error: <message>`. A task that fails that way gets the status message `Internal error`.

## A2A Protocol

| A2A 1.0 method                     | A2A 0.3 method                        | Description                                  |
| ---------------------------------- | ------------------------------------- | -------------------------------------------- |
| `SendMessage`                      | `message/send`                        | Send a message (blocking or background)      |
| `SendStreamingMessage`             | `message/stream`                      | Send with SSE streaming                      |
| `GetTask`                          | `tasks/get`                           | Retrieve a task by id                        |
| `ListTasks`                        | `tasks/list` (Cogitator extension)    | List tasks: cursor pages (1.0), offset (0.3) |
| `CancelTask`                       | `tasks/cancel`                        | Cancel a running task                        |
| `SubscribeToTask`                  | `tasks/resubscribe`                   | Reconnect to the stream of a task            |
| `CreateTaskPushNotificationConfig` | `tasks/pushNotificationConfig/set`    | Register a webhook for a task                |
| `GetTaskPushNotificationConfig`    | `tasks/pushNotificationConfig/get`    | Get a webhook config                         |
| `ListTaskPushNotificationConfigs`  | `tasks/pushNotificationConfig/list`   | List the webhook configs of a task           |
| `DeleteTaskPushNotificationConfig` | `tasks/pushNotificationConfig/delete` | Remove a webhook config                      |
| `GetExtendedAgentCard`             | `agent/getAuthenticatedExtendedCard`  | Fetch the authenticated extended Agent Card  |

| Code     | Error                           | HTTP (REST) | Notes                                                     |
| -------- | ------------------------------- | ----------- | --------------------------------------------------------- |
| `-32700` | Parse error                     | 400         | Unparseable JSON                                          |
| `-32600` | Invalid request                 | 400         | 0.3: also a message to a task that ended                  |
| `-32601` | Method not found                | 404         | Also a REST route that names no method                    |
| `-32602` | Invalid params                  | 400         | 1.0 adds a `google.rpc.BadRequest`, also an unknown agent |
| `-32603` | Internal error                  | 500         |                                                           |
| `-32001` | Task not found                  | 404         | 1.0: also a push config that does not exist               |
| `-32002` | Task not cancelable             | 400         |                                                           |
| `-32003` | Push notification not supported | 400         |                                                           |
| `-32004` | Unsupported operation           | 400         | 1.0: a message to, or a subscription of, an ended task    |
| `-32005` | Content type not supported      | 400         |                                                           |
| `-32006` | Invalid agent response          | 500         |                                                           |
| `-32007` | Extended card not configured    | 400         |                                                           |
| `-32008` | Extension support required      | 400         | A required extension the request did not ask for          |
| `-32009` | Version not supported           | 400         | Its `ErrorInfo` lists the supported versions              |
| `-32000` | Unauthorized (Cogitator)        | 401         | Missing or rejected credentials                           |

Over A2A 1.0 an error's `data` is a list of `google.rpc` details: an `ErrorInfo` (`reason` such as `TASK_NOT_FOUND`, `domain: 'a2a-protocol.org'`, the details as string `metadata`) and, for invalid params, a `BadRequest` with the `fieldViolations`. Over 0.3 errors keep their old form.

## Documentation

Full guide: [cogitator.app/docs/integrations/a2a](https://cogitator.app/docs/integrations/a2a)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem, a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
