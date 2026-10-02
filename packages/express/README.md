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
    defaultModel: 'openai/gpt-4o-mini',
    providers: { openai: { apiKey: process.env.OPENAI_API_KEY } },
  },
});

const chatAgent = new Agent({
  name: 'chat',
  description: 'General-purpose chat assistant',
  instructions: 'You are a helpful assistant.',
  model: 'openai/gpt-4o-mini',
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
GET    /api/agents                    - List all agents
POST   /api/agents/:name/run          - Run agent (JSON response)
POST   /api/agents/:name/stream       - Run agent (SSE stream)
```

Run/stream body: `{ input: string; context?: object; threadId?: string }` — `input` must be a non-empty string (400 otherwise). The agent list exposes `config.description`, never the agent instructions. The authenticated `userId` (from `auth`) is passed to the run, and the run is aborted when the client disconnects.

### Threads (Memory)

```
GET    /api/threads/:id               - Get thread messages
POST   /api/threads/:id/messages      - Add message to thread
DELETE /api/threads/:id               - Delete thread
```

Requires `memory` on the `Cogitator` instance (503 otherwise). New messages need `role` (`user` | `assistant` | `system`) and a non-empty string `content`; optional `metadata` is stored on the memory entry.

### Workflows

```
GET    /api/workflows                 - List all workflows
POST   /api/workflows/:name/run       - Run workflow
POST   /api/workflows/:name/stream    - Stream workflow events
```

Body: `{ input?: object; options?: { maxConcurrency?: number; maxIterations?: number; checkpoint?: boolean } }`. `maxConcurrency`/`maxIterations` must be positive integers and `checkpoint` a boolean (400 otherwise); other options are dropped. A failed workflow returns `500` with code `WORKFLOW_FAILED` (the stream ends with an `error` event instead of `workflow_completed`). Disconnecting aborts the workflow.

### Swarms

```
GET    /api/swarms                    - List all swarms
POST   /api/swarms/:name/run          - Run swarm
POST   /api/swarms/:name/stream       - Stream swarm events
GET    /api/swarms/:name/blackboard   - Get configured blackboard sections
```

Run/stream body: `{ input: string; context?: object; threadId?: string; timeout?: number }` (`timeout` must be positive). Disconnecting aborts the swarm. Each run creates a fresh swarm, so the blackboard endpoint returns the configured initial sections.

### Tools & Docs

```
GET    /api/tools                     - List all tools
GET    /api/health                    - Health check
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
  },
});
```

## SSE Streaming

The `/agents/:name/stream` endpoint returns Server-Sent Events:

```typescript
// Client-side
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

`attachWebSocket` throws if `enableWebSocket` is off, `init()` has not run, or `ws` is not installed. The configured `auth` function runs on the upgrade request (rejected with 401 when it throws). For custom setups, `setupWebSocket(httpServer, routeContext, config)` is also exported.

Protocol:

| Message                                                                             | Direction     | Description                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `{ type: 'run', id, payload: { type: 'agent', name, input, context?, threadId? } }` | Client→Server | Run an agent; events arrive as `{ type: 'event', id, payload }` (`token`, `tool-call`, `tool-result`, `complete`, `cancelled`) |
| `{ type: 'stop' }`                                                                  | Client→Server | Abort the client's running agent (emits `cancelled`)                                                                           |
| `{ type: 'subscribe', channel: 'agent:<name>' }`                                    | Client→Server | Receive events of runs of that agent started by other clients                                                                  |
| `{ type: 'unsubscribe', channel }`                                                  | Client→Server | Stop receiving channel events                                                                                                  |
| `{ type: 'ping' }`                                                                  | Client→Server | Answered with `{ type: 'pong' }`                                                                                               |

Only agent runs are supported over WebSocket; use the HTTP endpoints for workflows and swarms. A new `run` from the same connection aborts the previous one.

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
  };
}
```

### ExpressStreamWriter

```typescript
class ExpressStreamWriter {
  constructor(res: Response);
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
- `NOT_FOUND` → 404
- `PAYLOAD_TOO_LARGE` → 413
- `RATE_LIMIT_EXCEEDED` → 429
- `WORKFLOW_FAILED` → 500
- `INTERNAL` → 500 (details are logged, not returned)
- `UNIMPLEMENTED` → 501 (optional workflows/swarms package missing)
- `UNAVAILABLE` → 503 (memory not configured)

`CogitatorError`s thrown by runs keep their own code and use its mapped status (for example `LLM_RATE_LIMITED` → 429).

## License

MIT
