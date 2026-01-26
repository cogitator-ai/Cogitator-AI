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
  defaultBackend: 'openai',
  backends: { openai: { apiKey: process.env.OPENAI_API_KEY } },
});

const chatAgent = new Agent({
  name: 'chat',
  instructions: 'You are a helpful assistant.',
  model: 'gpt-4o-mini',
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

    // Authentication
    auth: async (req) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const user = await validateToken(token);
      return { userId: user.id, roles: user.roles };
    },

    // Rate limiting
    rateLimit: {
      windowMs: 60000, // 1 minute
      max: 100, // 100 requests per window
    },

    // CORS
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

Enable real-time bidirectional communication:

```typescript
const server = new CogitatorServer({
  // ...
  config: { enableWebSocket: true },
});

// After init, setup WebSocket on HTTP server
import { setupWebSocket } from '@cogitator-ai/express';
import { createServer } from 'http';

const httpServer = createServer(app);
await setupWebSocket(httpServer, routeContext, { path: '/api/ws' });
httpServer.listen(3000);
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

  writer.start(messageId);
  writer.textStart(generateId('txt'));

  // Your streaming logic
  writer.textDelta('txt-1', 'Hello ');
  writer.textDelta('txt-1', 'World!');

  writer.textEnd('txt-1');
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
    requestTimeout?: number; // Default: 30000
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
}
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

## License

MIT
