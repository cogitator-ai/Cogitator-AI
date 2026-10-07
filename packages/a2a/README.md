# @cogitator-ai/a2a

Native implementation of the [A2A (Agent2Agent) protocol v0.3](https://a2a-protocol.org/v0.3.0/specification/) for Cogitator. Expose agents as A2A services or connect to any A2A v0.3 agent, whatever framework it is built with. Every response is checked against the official v0.3.0 JSON schema in the test suite, and the official A2A JavaScript SDK talks to `A2AServer` (and `A2AClient` to an SDK server) in it.

## Installation

```bash
pnpm add @cogitator-ai/a2a @cogitator-ai/core
```

`@cogitator-ai/core` is needed for `A2AServer` (it runs your agents) and for `asTool()`. Install the framework you mount the server on (`express`, `hono`, `fastify`, `koa` or `next`), they are optional peer dependencies.

## Features

- **A2AServer** - Expose any Cogitator agent as an A2A v0.3 JSON-RPC service
- **A2AClient** - Talk to any A2A v0.3 agent: card discovery, messages, streaming, tasks
- **asTool() Bridge** - Wrap remote A2A agents as local Cogitator tools
- **Agent Card** - Generated from agent metadata at `/.well-known/agent-card.json`, one card and endpoint per agent
- **Task lifecycle** - `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`
- **Authentication** - Bearer or API-key auth on every adapter, declared in the card's `securitySchemes`, answered with HTTP 401
- **Per-user tasks** - `auth.validate` can return `{ userId }` to keep each caller's tasks, contexts and memory apart
- **Multi-turn** - `input-required` tasks take the client's answer, new tasks in a `contextId` carry the conversation on
- **SSE streaming** - Every event is a JSON-RPC response, the reply streams token by token as artifact chunks
- **Push notifications** - The task is POSTed to the client's webhook on every status change
- **Agent Card signing** - JWS (HS256) signatures in `signatures`
- **Authenticated extended card** - `agent/getAuthenticatedExtendedCard`
- **Tool approvals** - Paused runs wait in `input-required` with the calls in a data part
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
// JSON-RPC:   POST /a2a
```

`basePath` (default `/a2a`, must start with `/`) is the JSON-RPC path the adapters serve, relative to where they are mounted. It is readable as `a2aServer.basePath`.

The card's `url` is the absolute address of the agent's endpoint, as the specification requires. Without `cardUrl` the adapters derive it from the request that fetches the card (scheme, host and mount path). Behind a proxy that changes the host or the path, set `cardUrl` to the public URL of the endpoint, e.g. `https://agents.example.com/a2a`.

Cards also declare `protocolVersion: '0.3.0'`, `preferredTransport: 'JSONRPC'`, the agent `version` (`agentVersion`, default `1.0.0`) and, with `provider: { organization, url }`, who runs it. The description is the agent's `description` (its name when unset), never its instructions.

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

The client fills in `kind: 'message'` and a fresh `messageId` when a message leaves them out. It reads the card at `/.well-known/agent-card.json` (falling back to `/.well-known/agent.json` for servers before v0.3) and sends every request to the `url` the card names.

`A2AClient` options: `headers` (sent with every request, e.g. `Authorization`), `timeout` (ms, default `30000`), `agentCardPath` (a card path relative to the base URL, no fallback), `rpcPath` (send requests to this path at the base URL instead of the card's `url`, without reading the card) and `agentName` (an agent of a Cogitator server hosting several: the client uses that agent's own card and endpoint).

Other calls: `getTask(id, historyLength?)`, `cancelTask(id)`, `resubscribeTask(id)` (reconnect to a task's stream), `continueTask(id, text)`, `answerApprovals(id, decisions)`, `listTasks(filter?)` and the push notification calls below.

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

The tool returns `{ output, success, error?, taskId?, state?, pendingApprovals? }`. `output` is the remote agent's answer: the text of the task's status message, else of its last agent message, else of its artifacts. When the remote task waits on the client (`state: 'input-required'`), `success` is `false`, `output` carries the remote agent's question and `taskId` lets you answer with `client.continueTask()`. A remote task waiting for [tool approvals](#tool-approvals) lists the calls in `pendingApprovals`. The run's abort signal and the tool timeout are forwarded to the HTTP request.

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

Custom integrations can call `a2aServer.getAuthToken((name) => headers.get(name))` and pass the result to `handleJsonRpc(body, token)` or `handleJsonRpcStream(body, token, signal)`.

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

- `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, the `tasks/pushNotificationConfig/*` methods and a message that continues the task (`taskId`) answer another user's task with `-32001 Task not found`.
- `tasks/list` returns only the caller's own tasks and tasks without an owner. The server sets `TaskFilter.visibleTo` itself, whatever the client sends.
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

A task in a terminal state (`completed`, `failed`, `canceled`, `rejected`) can't be restarted, as the specification says: a message for it is refused with `-32600 Invalid request`. Carry the conversation on with a new message in the same `contextId` instead:

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

`toolApprovalResponsePart({ decisions?, defaultDecision? })` builds the part for a hand-written message. Calls left without a decision keep the task waiting. A text reply instead of decisions moves on: the waiting calls are declined and the agent answers the new message. The server resumes through `cogitator.resume()` by the task's `contextId`, so the paused run has to be where the server Cogitator keeps paused runs (its memory, or `runCheckpoints` shared by every server instance). `asTool()` reports such a remote task with `success: false`, the `taskId` and the calls in `pendingApprovals`.

## Listing Tasks

`tasks/list` is a Cogitator extension method (A2A v0.3 defines no JSON-RPC method for it):

```typescript
const tasks = await client.listTasks();
const conversation = await client.listTasks({ contextId: 'ctx_abc123' });
const completed = await client.listTasks({ state: 'completed', limit: 10, offset: 0 });
```

## Streaming

`message/stream` answers with Server-Sent Events. Every event is a JSON-RPC response with the request `id` whose `result` is the task, a `status-update` or an `artifact-update`. The stream ends after the status update with `final: true` (a terminal state, `input-required` or `auth-required`):

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

A request that fails before the stream starts (bad params, unknown task, missing credentials) is answered with a plain JSON-RPC error instead of a stream. A failure during the stream ends it with a JSON-RPC error response. `tasks/resubscribe` reconnects to the stream of a task: the task as it is now, then its updates while it still runs in this process.

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

`RedisTaskStore` implements the full `TaskStore` interface including `list()` with filtering by `contextId`, `state`, pagination, and timestamp-based sorting. Updates are atomic when the client supports `eval` (Lua).

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

Configs live in `InMemoryPushNotificationStore` unless you pass a `pushNotificationStore`, and cards declare `capabilities.pushNotifications: true`.

Webhook delivery is SSRF-hardened unless `allowPrivateUrls: true`: loopback, private, link-local, CGNAT, multicast and IPv4-mapped IPv6 targets are rejected, the check is applied to the address the socket actually connects to (no DNS-rebinding window), and redirects are not followed. `isPrivateAddress()` is exported for reuse.

## Agent Card Signing

Sign Agent Cards with a JWS (RFC 7515, `HS256`, detached payload) over the card's canonical JSON (RFC 8785, without `signatures`), as A2A v0.3 specifies:

```typescript
import { signAgentCard, verifyAgentCardSignature } from '@cogitator-ai/a2a';

const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  cardSigning: { secret: process.env.CARD_SIGNING_SECRET! },
});

// Client-side
const client = new A2AClient('https://remote-agent.example.com');
const isValid = await client.verifyAgentCard(process.env.CARD_SIGNING_SECRET!);

// Or manually
const card = await client.agentCard();
const valid = verifyAgentCardSignature(card, 'shared-secret');
```

The signature is in the card's `signatures` array (`{ protected, signature }`, both base64url).

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

The public card declares `supportsAuthenticatedExtendedCard: true` when `extendedCardGenerator` is set. Without it the method answers `-32007 Authenticated Extended Card not configured`.

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

// Koa (after a JSON body parser)
import { a2aKoa } from '@cogitator-ai/a2a/koa';
app.use(a2aKoa(server));

// Next.js: app/.well-known/agent-card.json/route.ts exports GET, app/a2a/route.ts exports POST
// (and app/a2a/[agent]/route.ts serves each agent's own endpoint)
import { a2aNext } from '@cogitator-ai/a2a/next';
export const { GET, POST } = a2aNext(server);
```

All adapters serve the routes listed [above](#several-agents-on-one-server), stream only for `message/stream` and `tasks/resubscribe` (an `Accept: text/event-stream` header alone does not switch `message/send` to SSE), answer JSON-RPC notifications with `204`, a request that is not `application/json` with `415`, and pass the request credentials to the server. While a stream is open they write a `: keep-alive` comment every `sseHeartbeatMs` (an `A2AServer` option, 5 seconds by default, `0` turns it off), so a proxy or Bun's idle timeout does not cut a run that waits on a slow tool. Structurally invalid JSON-RPC requests get `-32600 Invalid Request`, only unparseable JSON gets `-32700 Parse error`.

Errors that are neither A2A errors nor `CogitatorError`s (in parsing, authentication, routing, streams or agent runs) are logged on the server and answered as `-32603 Internal error`, without their text. A `CogitatorError` is answered as `-32603 Internal error: <message>`. A task that fails that way gets the status message `Internal error`.

## A2A Protocol

| Method                                | Description                                             |
| ------------------------------------- | ------------------------------------------------------- |
| `message/send`                        | Send a message (blocking or background)                 |
| `message/stream`                      | Send with SSE streaming                                 |
| `tasks/get`                           | Retrieve a task by id                                   |
| `tasks/cancel`                        | Cancel a running task                                   |
| `tasks/resubscribe`                   | Reconnect to the stream of a task                       |
| `tasks/pushNotificationConfig/set`    | Register a webhook for a task                           |
| `tasks/pushNotificationConfig/get`    | Get a webhook config                                    |
| `tasks/pushNotificationConfig/list`   | List the webhook configs of a task                      |
| `tasks/pushNotificationConfig/delete` | Remove a webhook config                                 |
| `agent/getAuthenticatedExtendedCard`  | Fetch the authenticated extended Agent Card             |
| `tasks/list`                          | Cogitator extension: list tasks with filters and paging |

Error codes follow section 8 of the specification (`-32001` task not found, `-32002` not cancelable, `-32004` unsupported operation, `-32007` extended card not configured), plus `-32000` for missing or rejected credentials. An unknown agent name is `-32602 Invalid params`.

## Documentation

Full guide: [cogitator.app/docs/integrations/a2a](https://cogitator.app/docs/integrations/a2a)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem, a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
