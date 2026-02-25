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
  defaultBackend: 'openai',
  backends: { openai: { apiKey: process.env.OPENAI_API_KEY } },
});

const chatAgent = new Agent({
  name: 'chat',
  instructions: 'You are a helpful assistant.',
  model: 'gpt-4o-mini',
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
GET    /api/agents                    - List all agents
POST   /api/agents/:name/run          - Run agent (JSON response)
POST   /api/agents/:name/stream       - Run agent (SSE stream)
```

### Threads (Memory)

```
GET    /api/threads/:id               - Get thread messages
POST   /api/threads/:id/messages      - Add message to thread
DELETE /api/threads/:id               - Delete thread
```

### Workflows

```
GET    /api/workflows                 - List all workflows
POST   /api/workflows/:name/run       - Run workflow
POST   /api/workflows/:name/stream    - Stream workflow events
```

### Swarms

```
GET    /api/swarms                    - List all swarms
POST   /api/swarms/:name/run          - Run swarm
POST   /api/swarms/:name/stream       - Stream swarm events
GET    /api/swarms/:name/blackboard   - Get shared state
```

### Tools & Docs

```
GET    /api/tools                     - List all tools
GET    /api/health                    - Health check
GET    /api/docs                      - Swagger UI
```

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

  // Authentication
  auth: async (request) => {
    const token = request.headers.authorization?.replace('Bearer ', '');
    const user = await validateToken(token);
    return { userId: user.id, roles: user.roles };
  },

  // Rate limiting (requires @fastify/rate-limit)
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

  // WebSocket options
  websocket: {
    path: '/ws',
  },
});
```

## SSE Streaming

The `/agents/:name/stream` endpoint returns Server-Sent Events:

```typescript
const response = await fetch('/api/agents/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'Hello!' }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      console.log(event);
      // { type: 'text-delta', id: '...', delta: 'Hello' }
    }
  }
}
```

### Stream Events

| Event Type        | Description                             |
| ----------------- | --------------------------------------- |
| `start`           | Stream started, includes message ID     |
| `text-start`      | Text generation started                 |
| `text-delta`      | Text chunk received                     |
| `text-end`        | Text generation finished                |
| `tool-call-start` | Tool execution started                  |
| `tool-call-end`   | Tool execution finished                 |
| `tool-result`     | Tool returned result                    |
| `workflow`        | Workflow event (node started/completed) |
| `swarm`           | Swarm event (agent started/completed)   |
| `error`           | Error occurred                          |
| `finish`          | Stream finished, includes usage stats   |

## WebSocket Support

Enable real-time bidirectional communication:

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

// Subscribe to channel
ws.send(JSON.stringify({ type: 'subscribe', channel: 'updates' }));

// Ping/pong
ws.send(JSON.stringify({ type: 'ping' }));
```

### WebSocket Message Types

| Type          | Direction     | Description              |
| ------------- | ------------- | ------------------------ |
| `ping`        | Client→Server | Heartbeat                |
| `pong`        | Server→Client | Heartbeat response       |
| `subscribe`   | Client→Server | Subscribe to channel     |
| `subscribed`  | Server→Client | Subscription confirmed   |
| `unsubscribe` | Client→Server | Unsubscribe from channel |
| `run`         | Client→Server | Run agent/workflow/swarm |
| `stop`        | Client→Server | Cancel running operation |
| `event`       | Server→Client | Stream event             |
| `error`       | Server→Client | Error message            |

## Custom Streaming

Use `FastifyStreamWriter` for custom streaming routes:

```typescript
import { FastifyStreamWriter, generateId } from '@cogitator-ai/fastify';

fastify.post('/custom/stream', async (request, reply) => {
  const writer = new FastifyStreamWriter(reply);
  const messageId = generateId('msg');

  writer.start(messageId);
  const textId = generateId('txt');
  writer.textStart(textId);

  // Your streaming logic
  writer.textDelta(textId, 'Hello ');
  writer.textDelta(textId, 'World!');

  writer.textEnd(textId);
  writer.finish(messageId);
  writer.close();
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
  toolCallStart(id: string, toolName: string): void;
  toolCallDelta(id: string, argsTextDelta: string): void;
  toolCallEnd(id: string): void;
  toolResult(id: string, toolCallId: string, result: unknown): void;
  workflowEvent(event: string, data: unknown): void;
  swarmEvent(event: string, data: unknown): void;
  error(message: string, code?: string): void;
  finish(messageId: string, usage?: Usage): void;
  close(): void;
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

- `INVALID_INPUT` → 400
- `UNAUTHORIZED` → 401
- `PERMISSION_DENIED` → 403
- `NOT_FOUND` → 404
- `RATE_LIMIT_EXCEEDED` → 429
- `INTERNAL` → 500
- `UNAVAILABLE` → 503
- `UNIMPLEMENTED` → 501

## JSON Schema Validation

Fastify's built-in validation is used for all endpoints. Request schemas are exported:

```typescript
import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  AddMessageRequestSchema,
  WorkflowRunRequestSchema,
  SwarmRunRequestSchema,
} from '@cogitator-ai/fastify';
```

## License

MIT
