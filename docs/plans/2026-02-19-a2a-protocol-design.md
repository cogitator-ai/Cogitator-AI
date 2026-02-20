# A2A Protocol Integration Design

## Overview

Implement Google's Agent2Agent (A2A) Protocol v0.3 as `@cogitator-ai/a2a` — making Cogitator the first TypeScript agent runtime with native A2A support. Zero external dependencies, own implementation from spec.

## Motivation

- First-mover in TS ecosystem for A2A
- Enables cross-framework agent interoperability (Cogitator ↔ LangChain ↔ CrewAI ↔ any A2A agent)
- Enterprise credibility (Google-backed, Linux Foundation, 50+ partners)
- Natural extension of existing server adapter architecture

## A2A Protocol Summary (v0.3)

- JSON-RPC 2.0 over HTTPS
- Agent Card — JSON manifest describing agent capabilities, skills, endpoints, auth
- Task — unit of work with lifecycle states: WORKING, COMPLETED, FAILED, INPUT_REQUIRED, AUTH_REQUIRED, CANCELED, REJECTED
- Messages with Parts: TextPart, FilePart, DataPart
- SSE streaming for real-time updates
- Discovery via `GET /.well-known/agent.json`

## Architecture: `@cogitator-ai/a2a`

### Package Structure

```
packages/a2a/src/
├── types.ts          — A2A protocol types (AgentCard, Task, Message, Part, etc.)
├── server.ts         — A2AServer (registers agents, handles JSON-RPC, manages tasks)
├── client.ts         — A2AClient (connects to remote A2A agents, wraps as Tools)
├── agent-card.ts     — Auto-generates Agent Card from Cogitator Agent metadata
├── task-manager.ts   — Task lifecycle management with pluggable store
├── task-store.ts     — TaskStore interface + InMemoryTaskStore
├── json-rpc.ts       — JSON-RPC 2.0 parser/serializer
├── errors.ts         — A2A-specific error codes
├── index.ts          — Public API exports
└── adapters/
    ├── express.ts    — Express middleware
    ├── hono.ts       — Hono middleware
    ├── fastify.ts    — Fastify plugin
    ├── koa.ts        — Koa middleware
    └── next.ts       — Next.js route handler
```

### Concept Mapping

| A2A Concept          | Cogitator Equivalent          | Mapping Strategy                                    |
| -------------------- | ----------------------------- | --------------------------------------------------- |
| Agent Card           | `Agent` metadata              | Auto-generated from name, description, tools, model |
| Task                 | `RunResult` + state           | New `A2ATask` wrapping cogitator run                |
| Message (role=user)  | `RunOptions.input`            | Direct                                              |
| Message (role=agent) | `RunResult.output`            | Direct                                              |
| TextPart             | `string` output               | Direct                                              |
| DataPart             | `RunResult.structured`        | Structured output                                   |
| FilePart             | Multimodal tool outputs       | Via image/audio generation tools                    |
| Artifact             | Tool results, generated files | Tool outputs as artifacts                           |
| Skill                | `Tool` definitions            | Each tool = skill in Agent Card                     |

### Task State Mapping

- Agent running, LLM processing → `WORKING`
- Agent returned `RunResult` → `COMPLETED`
- Agent threw error → `FAILED`
- Agent requests human input (workflow `humanNode`) → `INPUT_REQUIRED`
- Client called cancel → `CANCELED`

## API Design

### A2AServer

```ts
const a2aServer = new A2AServer({
  agents: { researcher: agent },
  cogitator,
  basePath: '/a2a',
  taskStore: new InMemoryTaskStore(),
  auth: { type: 'bearer', validate: async (token) => true },
});
```

Endpoints:

- `GET /.well-known/agent.json` — Agent Card discovery
- `POST /a2a` — JSON-RPC endpoint routing:
  - `message/send` → runs agent, returns Task
  - `message/sendStream` → SSE streaming run
  - `tasks/get` → returns Task by ID
  - `tasks/cancel` → cancels running task

Core method:

```ts
// Framework-agnostic request handler
async handleRequest(request: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse | AsyncIterable<StreamEvent>>
```

### A2AClient

```ts
const client = new A2AClient('https://remote-agent.example.com')

// Discovery
const card = await client.agentCard()

// Convert to Cogitator Tool (killer feature)
const remoteTool = client.asTool()

// Direct usage
const task = await client.sendMessage({
  role: 'user',
  parts: [{ type: 'text', text: 'Research quantum computing' }]
})

// Streaming
for await (const event of client.sendMessageStream({ ... })) {
  console.log(event)
}

// Task management
const status = await client.getTask(task.id)
await client.cancelTask(task.id)
```

`client.asTool()` wraps remote A2A agent as a Cogitator Tool:

```ts
const remoteResearcher = new A2AClient('https://research-agent.ai').asTool();
const orchestrator = new Agent({
  name: 'orchestrator',
  tools: [remoteResearcher],
  instructions: 'Use the researcher for...',
});
```

### Agent Card Generation

Auto-generated from Agent + Tools:

```json
{
  "name": "researcher",
  "description": "Research agent",
  "url": "https://my-server.com/a2a",
  "version": "0.3",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "web_search",
      "name": "Web Search",
      "description": "Search the web for information",
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain", "application/json"]
    }
  ],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"]
}
```

### TaskStore

```ts
interface TaskStore {
  create(task: A2ATask): Promise<void>;
  get(taskId: string): Promise<A2ATask | null>;
  update(taskId: string, update: Partial<A2ATask>): Promise<void>;
  list(filter?: TaskFilter): Promise<A2ATask[]>;
  delete(taskId: string): Promise<void>;
}
```

Implementations: `InMemoryTaskStore` (default), `RedisTaskStore` (production)

### Framework Adapters

```ts
// Express
import { a2aExpress } from '@cogitator-ai/a2a/express';
app.use(a2aExpress(a2aServer));

// Hono
import { a2aHono } from '@cogitator-ai/a2a/hono';
app.route('/a2a', a2aHono(a2aServer));

// Fastify
import { a2aFastify } from '@cogitator-ai/a2a/fastify';
fastify.register(a2aFastify(a2aServer));

// Koa
import { a2aKoa } from '@cogitator-ai/a2a/koa';
app.use(a2aKoa(a2aServer));

// Next.js
import { a2aNext } from '@cogitator-ai/a2a/next';
export const { GET, POST } = a2aNext(a2aServer);
```

All adapters delegate to `A2AServer.handleRequest()`.

## Scope

### v1 (complete)

- A2AServer with Agent Card discovery
- A2AClient with `asTool()` bridge
- JSON-RPC: message/send, message/stream, tasks/get, tasks/cancel
- SSE streaming
- InMemoryTaskStore
- All 5 framework adapters
- Agent Card auto-generation from Agent metadata

### v2 (complete)

- Multi-turn conversations with contextId (continueTask, context linking)
- ListTasks with pagination (tasks/list method with filters)
- Token-level streaming (onToken → TokenStreamEvent in SSE)
- RedisTaskStore for production persistence
- Timestamp-based sorting in task stores

### v3 (future)

- Push notifications (webhooks)
- gRPC binding
- Agent Card signing
- Extended Agent Card (authenticated)

## Dependencies

Zero external — all implemented from spec. Uses only:

- `@cogitator-ai/core` (Agent, Cogitator, Tool)
- `@cogitator-ai/types` (shared interfaces)
- Framework peer deps for adapters (express, hono, fastify, koa, next)
