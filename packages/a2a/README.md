# @cogitator-ai/a2a

Native implementation of [Google's A2A Protocol v0.3](https://a2a-protocol.org) for Cogitator. Expose agents as A2A services or connect to any A2A-compatible agent across frameworks.

## Installation

```bash
pnpm add @cogitator-ai/a2a
```

## Features

- **A2AServer** - Expose any Cogitator agent as an A2A-compliant service
- **A2AClient** - Connect to remote A2A agents with discovery and streaming
- **asTool() Bridge** - Wrap remote A2A agents as local Cogitator tools
- **Agent Card** - Auto-generate A2A Agent Cards from agent metadata
- **Task Management** - Full task lifecycle (working, completed, failed, canceled)
- **SSE Streaming** - Real-time streaming on both server and client
- **Framework Adapters** - Express, Hono, Fastify, Koa, Next.js
- **Zero Dependencies** - Own implementation from spec, no external A2A deps

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
  model: 'openai/gpt-4o',
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

### Use Remote Agent as a Tool

```typescript
const client = new A2AClient('https://research-agent.example.com');
const card = await client.agentCard();
const remoteTool = client.asToolFromCard(card);

const orchestrator = new Agent({
  name: 'orchestrator',
  model: 'openai/gpt-4o',
  instructions: 'Use the researcher for information gathering.',
  tools: [remoteTool],
});

const result = await cogitator.run(orchestrator, {
  input: 'Write a report on AI trends',
});
```

## Framework Adapters

```typescript
// Express
import { a2aExpress } from '@cogitator-ai/a2a/express';
app.use(a2aExpress(server));

// Hono
import { a2aHono } from '@cogitator-ai/a2a/hono';
app.route('/a2a', a2aHono(server));

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

## A2A Protocol

| Method           | Description                        |
| ---------------- | ---------------------------------- |
| `message/send`   | Send a message, get completed task |
| `message/stream` | Send with SSE streaming            |
| `tasks/get`      | Retrieve task by ID                |
| `tasks/cancel`   | Cancel a running task              |

## Part of Cogitator

This package is part of the [Cogitator](https://github.com/cogitator-ai/Cogitator-AI) ecosystem — a self-hosted, production-grade AI agent runtime for TypeScript.

## License

MIT
