# @cogitator-ai/a2a

Native implementation of [Google's A2A Protocol v0.3](https://a2a-protocol.org) for Cogitator. Expose agents as A2A services or connect to any A2A-compatible agent across frameworks.

## Installation

```bash
pnpm add @cogitator-ai/a2a @cogitator-ai/core
```

`@cogitator-ai/core` is needed for `A2AServer` (it runs your agents) and for `asTool()`. Install the framework you mount the server on (`express`, `hono`, `fastify`, `koa` or `next`); they are optional peer dependencies.

## Features

- **A2AServer** - Expose any Cogitator agent as an A2A-compliant service
- **A2AClient** - Connect to remote A2A agents with discovery and streaming
- **asTool() Bridge** - Wrap remote A2A agents as local Cogitator tools
- **Agent Card** - Auto-generate A2A Agent Cards from agent metadata
- **Task Management** - Full task lifecycle (working, input-required, completed, failed, canceled)
- **Authentication** - Bearer / API-key auth enforced by every framework adapter and advertised on the Agent Card
- **Per-user tasks** - `auth.validate` can return `{ userId }` to keep each caller's tasks, contexts and memory apart
- **Multi-Turn Conversations** - Stateful conversations with contextId and continueTask
- **SSE Streaming** - Real-time streaming with token-level events
- **Push Notifications** - Webhook-based task event notifications
- **Agent Card Signing** - HMAC-SHA256 signing and verification
- **Extended Agent Card** - Authenticated endpoint with extra details
- **RedisTaskStore** - Production-grade task persistence
- **Framework Adapters** - Express, Hono, Fastify, Koa, Next.js
- **No A2A SDK dependency** - Own implementation of the spec (runtime deps: `@cogitator-ai/types`, `zod`)

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
  cardUrl: 'https://my-server.com',
});

const app = express();
app.use(a2aExpress(a2aServer));
app.listen(3000);
// Agent Card: GET /.well-known/agent.json
// JSON-RPC:   POST /a2a
```

`basePath` (default `/a2a`, must start with `/`) is the JSON-RPC path the adapters serve, relative to where they are mounted, and the card URL when `cardUrl` is unset; it is readable as `a2aServer.basePath`. For Next.js, put the `POST` route file at that path. `cardUrl` is the `url` the cards advertise.

### Connect to a Remote A2A Agent

```typescript
import { A2AClient } from '@cogitator-ai/a2a';

const client = new A2AClient('https://remote-agent.example.com');

// Discover
const card = await client.agentCard();
console.log(card.name, card.skills);

// Send message
const task = await client.sendMessage({
  role: 'user',
  parts: [{ type: 'text', text: 'Research quantum computing' }],
});

// Stream
for await (const event of client.sendMessageStream({
  role: 'user',
  parts: [{ type: 'text', text: 'Analyze market trends' }],
})) {
  console.log(event.type, event);
}
```

`A2AClient` options: `headers` (sent with every request, e.g. `Authorization`), `timeout` (ms, default `30000`), `agentCardPath` (default `/.well-known/agent.json`), `rpcPath` (default `/a2a`; match the server's `basePath`) and `agentName`. On a server that hosts several agents, `agentName` picks one by its registered name: the client sends it with `message/send`, `message/stream` and `agent/extendedCard`, and `agentCard()` returns that agent's card. Without it the server answers with its first agent.

```typescript
const writer = new A2AClient('https://my-server.com', { agentName: 'writer' });
```

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

The tool returns `{ output, success, error?, taskId?, state?, pendingApprovals? }`. `output` is the remote agent's latest answer. When the remote task needs more input (`state: 'input-required'`), `success` is `false`, `output` carries the remote agent's question and `taskId` lets you continue the task with `client.continueTask()`. A remote task waiting for [tool approvals](#tool-approvals) lists the calls in `pendingApprovals`. The run's abort signal and the tool timeout are forwarded to the HTTP request.

## Authentication

Protect the JSON-RPC endpoint with a bearer token or an API key. Every framework adapter extracts the credential from the request headers (`Authorization: Bearer <token>` or the API-key header) and the server validates it before routing; the public Agent Card advertises the scheme in `securitySchemes`.

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

Custom integrations can call `a2aServer.getAuthToken((name) => headers.get(name))` and pass the result to `handleJsonRpc(body, token)` / `handleJsonRpcStream(body, token, signal)`.

A missing credential or a `validate` that returns `false` answers JSON-RPC error `-32000 Unauthorized` (a `failed` status event on a stream).

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

- `tasks/get`, `tasks/cancel`, the `tasks/pushNotification/*` methods and a message that continues the task (`taskId`) answer another user's task with `-32001 Task not found`.
- `tasks/list` returns only the caller's own tasks and tasks without an owner; the server sets `TaskFilter.visibleTo` itself, whatever the client sends.
- A new message with a `contextId` that holds another user's tasks is refused with `-32602 Invalid params`.
- Runs carry the `userId`, so the agent's threads and memory are scoped to the user too.

Returning `true` admits the caller without a user: every such caller shares one space, as before, and sees only tasks without an owner. The owner is kept in the task's metadata and never sent to clients. A custom `TaskStore` must honour `filter.visibleTo` in `list()` (`InMemoryTaskStore` and `RedisTaskStore` do).

## Send Configuration

`sendMessage(message, configuration)` supports the A2A `SendMessageConfiguration`:

| Option                   | Effect                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| `blocking: false`        | Return the task immediately in `working` state; poll `getTask` or use webhooks |
| `historyLength`          | Return only the last N history messages (`0` = none); also on `getTask`        |
| `acceptedOutputModes`    | Only return artifacts with these MIME types                                    |
| `timeout`                | Maximum agent run time in ms                                                   |
| `pushNotificationConfig` | Register a webhook before the task starts executing                            |

```typescript
const task = await client.sendMessage(
  { role: 'user', parts: [{ type: 'text', text: 'Long running analysis' }] },
  {
    blocking: false,
    pushNotificationConfig: { webhookUrl: 'https://my-app.com/webhooks/a2a' },
  }
);
// task.status.state === 'working'; completion arrives at the webhook
```

Client calls also accept request options: `client.sendMessage(message, config, { signal, timeout })`.

## Multi-Turn Conversations

Continue tasks within the same conversation context using `contextId` and `continueTask`:

```typescript
const client = new A2AClient('https://remote-agent.example.com');

// Start a conversation
const task = await client.sendMessage({
  role: 'user',
  parts: [{ type: 'text', text: 'Research quantum computing' }],
});

// Continue the same task with follow-up
const updated = await client.continueTask(task.id, 'Now compare it with classical computing');

// Both tasks share the same contextId
console.log(task.contextId === updated.contextId); // true
```

On the server side, multi-turn is handled automatically. When a message includes a `taskId`, the server calls `continueTask` which appends to the existing task history and re-runs the agent with the task transcript as context, so follow-ups work even without a memory adapter. Runs are threaded by `contextId` (`threadId`), and artifacts accumulate across turns. A task that is still running cannot be continued concurrently.

## Tool Approvals

When the agent calls a tool that needs approval (`requiresApproval`), its run pauses and the task waits in `input-required`, never `completed`. The agent's message carries the waiting calls in a data part (`{ kind: 'tool-approval-request', approvals: [{ toolCallId, toolName, arguments, description }] }`) and `status.message` says `Waiting for approval of <tools>`. The client answers with a `tool-approval-response` data part in the message that continues the task, and the server resumes the run with those decisions:

```typescript
import { readToolApprovalRequest } from '@cogitator-ai/a2a';

const task = await client.sendMessage({
  role: 'user',
  parts: [{ type: 'text', text: 'Refund A-1' }],
});

const waiting = readToolApprovalRequest(task);
if (waiting) {
  const done = await client.answerApprovals(task.id, {
    decisions: { [waiting[0].toolCallId]: { approved: true } },
    // or defaultDecision: { approved: false, reason: 'not eligible' }
  });
}
```

`toolApprovalResponsePart({ decisions?, defaultDecision? })` builds the part for a hand-written message. Calls left without a decision keep the task waiting. A text reply instead of decisions moves on: the waiting calls are declined and the agent answers the new message. The server resumes through `cogitator.resume()` by the task's `contextId`, so the paused run has to be where the server Cogitator keeps paused runs (its memory, or `runCheckpoints` shared by every server instance). `asTool()` reports such a remote task with `success: false`, the `taskId` and the calls in `pendingApprovals`.

## Listing Tasks

Query tasks with filtering and pagination via `tasks/list`:

```typescript
const client = new A2AClient('https://remote-agent.example.com');

// List all tasks
const tasks = await client.listTasks();

// Filter by context (conversation)
const conversationTasks = await client.listTasks({
  contextId: 'ctx_abc123',
});

// Filter by state with pagination
const completedTasks = await client.listTasks({
  state: 'completed',
  limit: 10,
  offset: 0,
});
```

## Token Streaming

SSE streaming includes token-level events alongside status and artifact updates:

```typescript
for await (const event of client.sendMessageStream({
  role: 'user',
  parts: [{ type: 'text', text: 'Write a poem' }],
})) {
  switch (event.type) {
    case 'token':
      process.stdout.write(event.token);
      break;
    case 'status-update':
      console.log(`\nStatus: ${event.status.state}`);
      break;
    case 'artifact-update':
      console.log(`\nArtifact: ${event.artifact.id}`);
      break;
  }
}
```

The server emits `TokenStreamEvent` for each token generated by the LLM via the `onToken` callback, giving clients real-time character-by-character output.

Artifact events are sent before the final status event, and the stream closes on a terminal state or on `input-required`. The client `timeout` is an idle timeout between events (long runs are fine as long as events keep flowing); pass `{ signal }` as the third argument to cancel. When the client disconnects, the adapters abort the agent run.

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

Register webhooks to receive task event notifications:

```typescript
const client = new A2AClient('https://remote-agent.example.com');

// Start a task
const task = await client.sendMessage({
  role: 'user',
  parts: [{ type: 'text', text: 'Long running analysis' }],
});

// Register a webhook for this task
const config = await client.createPushNotification(task.id, {
  webhookUrl: 'https://my-app.com/webhooks/a2a',
  authenticationInfo: {
    scheme: 'bearer',
    credentials: { token: 'my-webhook-secret' },
  },
});

// List registered webhooks
const configs = await client.listPushNotifications(task.id);

// Remove a webhook
await client.deletePushNotification(task.id, config.id!);
```

Server-side setup requires a `PushNotificationStore`:

```typescript
import { A2AServer, InMemoryPushNotificationStore } from '@cogitator-ai/a2a';

const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  pushNotificationStore: new InMemoryPushNotificationStore(),
});
```

When configured, the server automatically sends POST requests with `A2AStreamEvent` payloads to registered webhook URLs on task status and artifact updates. The Agent Card will advertise `pushNotifications: true`. Every push-notification method (`create`, `get`, `list`, `delete`) requires an existing task the caller may see (otherwise `TaskNotFound`); use `configuration.pushNotificationConfig` with `blocking: false` to subscribe before execution starts.

Webhook delivery is SSRF-hardened unless `allowPrivateUrls: true`: loopback, private, link-local, CGNAT, multicast and IPv4-mapped IPv6 targets are rejected, the check is applied to the address the socket actually connects to (no DNS-rebinding window), and redirects are not followed. `isPrivateAddress()` is exported for reuse.

## Agent Card Signing

Sign Agent Cards with HMAC-SHA256 for integrity verification:

```typescript
import { signAgentCard, verifyAgentCardSignature } from '@cogitator-ai/a2a';

// Server-side: sign cards automatically
const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  cardSigning: {
    algorithm: 'hmac-sha256',
    secret: process.env.CARD_SIGNING_SECRET!,
  },
});

// Client-side: verify a card's signature
const client = new A2AClient('https://remote-agent.example.com');
const isValid = await client.verifyAgentCard(process.env.CARD_SIGNING_SECRET!);

// Or manually
const card = await client.agentCard();
const valid = verifyAgentCardSignature(card, 'shared-secret');
```

## Extended Agent Card

Provide an authenticated endpoint with additional agent details (rate limits, pricing, extended skills):

```typescript
// Server-side: configure extended card generator
const a2aServer = new A2AServer({
  agents: { researcher },
  cogitator,
  extendedCardGenerator: (agentName) => ({
    ...a2aServer.getAgentCard(agentName),
    extendedSkills: [
      {
        id: 'deep_research',
        name: 'deep_research',
        description: 'Multi-source deep research',
        inputModes: ['text/plain'],
        outputModes: ['text/plain', 'application/json'],
      },
    ],
    rateLimit: { requestsPerMinute: 60 },
    pricing: { model: 'per-request', details: '$0.01 per task' },
    metadata: { version: '2.1.0', region: 'us-east-1' },
  }),
});

// Client-side: fetch the extended card (requires auth)
const client = new A2AClient('https://remote-agent.example.com', {
  headers: { Authorization: 'Bearer my-token' },
});
const extendedCard = await client.extendedAgentCard();
console.log(extendedCard.rateLimit, extendedCard.pricing);
```

The `agent/extendedCard` method is only available when `extendedCardGenerator` is configured on the server. The Agent Card advertises this via `capabilities.extendedAgentCard: true`.

## Framework Adapters

```typescript
// Express
import { a2aExpress } from '@cogitator-ai/a2a/express';
app.use(a2aExpress(server));

// Hono (routes are /.well-known/agent.json and server.basePath)
import { a2aHono } from '@cogitator-ai/a2a/hono';
app.route('/', a2aHono(server));

// Fastify
import { a2aFastify } from '@cogitator-ai/a2a/fastify';
fastify.register(a2aFastify(server));

// Koa
import { a2aKoa } from '@cogitator-ai/a2a/koa';
app.use(a2aKoa(server));

// Next.js
import { a2aNext } from '@cogitator-ai/a2a/next';
export const { GET, POST } = a2aNext(server);
```

All adapters stream only for `message/stream` (an `Accept: text/event-stream` header alone does not switch `message/send` to SSE), answer JSON-RPC notifications with `204`, and pass the request credentials to the server. Structurally invalid JSON-RPC requests get `-32600 Invalid Request`; only unparseable JSON gets `-32700 Parse error`.

Errors that are neither A2A errors nor `CogitatorError`s (in parsing, authentication, routing, streams or agent runs) are logged on the server and answered as `-32603 Internal error`, without their text; a `CogitatorError` is answered as `-32603 Internal error: <message>`. A task that fails that way gets the status message `Internal error`, and so does the `failed` status event of a stream.

## A2A Protocol

| Method                          | Description                               |
| ------------------------------- | ----------------------------------------- |
| `message/send`                  | Send a message (blocking or background)   |
| `message/stream`                | Send with SSE streaming (incl. tokens)    |
| `tasks/get`                     | Retrieve task by ID                       |
| `tasks/cancel`                  | Cancel a running task                     |
| `tasks/list`                    | List tasks with filtering and pagination  |
| `tasks/pushNotification/create` | Register a webhook for task events        |
| `tasks/pushNotification/get`    | Get a push notification config            |
| `tasks/pushNotification/list`   | List push notification configs for a task |
| `tasks/pushNotification/delete` | Remove a push notification config         |
| `agent/extendedCard`            | Fetch extended Agent Card (authenticated) |

## Documentation

Full guide: [cogitator.app/docs/integrations/a2a](https://cogitator.app/docs/integrations/a2a)

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem — a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
