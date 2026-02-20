# Getting Started

> Build your first AI agent in 5 minutes

This guide will walk you through installing Cogitator, creating your first agent, and running it with tools and memory.

---

## Prerequisites

Before you begin, make sure you have:

- **Node.js 20+** — [Download](https://nodejs.org/)
- **pnpm** (recommended) — `npm install -g pnpm`
- **Docker** (optional) — For Redis, Postgres, and sandboxed execution
- **Ollama** (for local LLMs) — [Download](https://ollama.ai/) or use OpenAI/Anthropic API

### Verify Installation

```bash
node --version    # v20.0.0 or higher
pnpm --version    # 8.0.0 or higher
docker --version  # Optional: 24.0.0 or higher
ollama --version  # Optional: 0.1.0 or higher
```

---

## Quick Start (3 minutes)

The fastest way to get started is using the Cogitator CLI:

```bash
# Install CLI globally
npm install -g @cogitator-ai/cli

# Create a new project
cogitator init my-agents
cd my-agents

# Start infrastructure (Redis, Postgres, Ollama)
cogitator up

# Run your first agent
pnpm dev
```

That's it! You should see your agent respond to a greeting.

---

## Manual Installation

If you prefer to set up manually or add Cogitator to an existing project:

```bash
# Create a new project
mkdir my-agents && cd my-agents
pnpm init

# Install Cogitator packages
pnpm add @cogitator-ai/core @cogitator-ai/config zod

# Install dev dependencies
pnpm add -D typescript tsx @types/node
```

---

## Create Your First Agent

Create a file `src/agent.ts`:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

// 1. Create the Cogitator runtime
const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
    },
  },
});

// 2. Create an agent
const assistant = new Agent({
  name: 'assistant',
  model: 'llama3.1:8b', // or 'gpt-4o', 'claude-sonnet-4-5'
  instructions: `You are a helpful assistant. Be concise and friendly.`,
});

// 3. Run the agent
const result = await cog.run(assistant, {
  input: 'Hello! What can you help me with?',
});

console.log('Agent:', result.output);
console.log('Tokens:', result.usage.totalTokens);

// 4. Cleanup
await cog.close();
```

Run it:

```bash
npx tsx src/agent.ts
```

---

## Add Tools

Tools give your agent superpowers. Define them with Zod schemas for full type safety:

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

// Define a custom tool
const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  execute: async ({ city, units }) => {
    // In production, call a real weather API
    return {
      city,
      temperature: units === 'celsius' ? 22 : 72,
      units,
      condition: 'sunny',
    };
  },
});

// Create agent with tools
const weatherBot = new Agent({
  name: 'weather-bot',
  model: 'llama3.1:8b',
  instructions:
    'You are a weather assistant. Use the get_weather tool to answer questions about weather.',
  tools: [getWeather],
});

const cog = new Cogitator();

const result = await cog.run(weatherBot, {
  input: 'What is the weather like in Tokyo?',
});

console.log('Response:', result.output);
console.log(
  'Tools used:',
  result.toolCalls.map((t) => t.name)
);

await cog.close();
```

### Built-in Tools

Cogitator includes 26 ready-to-use tools:

```typescript
import {
  // Math & Utils
  calculator, // Math expressions
  datetime, // Current time with timezone
  uuid, // Generate UUIDs
  randomNumber, // Random numbers
  randomString, // Random strings
  hash, // MD5, SHA256, etc.
  sleep, // Pause execution

  // Data Processing
  base64Encode, // Encode to base64
  base64Decode, // Decode from base64
  jsonParse, // Parse JSON
  jsonStringify, // Stringify to JSON
  regexMatch, // Pattern matching
  regexReplace, // Pattern replacement

  // File System
  fileRead, // Read files
  fileWrite, // Write files
  fileList, // List directory
  fileExists, // Check file exists
  fileDelete, // Delete files

  // Network & External
  httpRequest, // HTTP calls
  exec, // Shell commands (sandboxed)
  webSearch, // Web search
  webScrape, // Scrape web pages
  sqlQuery, // SQL queries
  vectorSearch, // Vector similarity search
  sendEmail, // Send emails
  githubApi, // GitHub API

  // Or import all at once
  builtinTools, // Array of all tools above
} from '@cogitator-ai/core';

const agent = new Agent({
  name: 'power-user',
  model: 'gpt-4.1',
  instructions: 'You are a powerful assistant with many tools.',
  tools: [calculator, datetime, fileRead, httpRequest],
});

// Or use all built-in tools
const superAgent = new Agent({
  name: 'super-agent',
  model: 'gpt-4.1',
  instructions: 'You have access to all tools.',
  tools: builtinTools,
});
```

---

## Use Memory

Enable persistent memory so your agent remembers conversations:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
  },
  // Enable memory
  memory: {
    adapter: 'memory', // In-memory (for development)
    // adapter: 'redis',   // Redis (for production short-term)
    // adapter: 'postgres', // Postgres (for production long-term)
  },
});

const assistant = new Agent({
  name: 'memory-assistant',
  model: 'llama3.1:8b',
  instructions: 'You are a helpful assistant. Remember what the user tells you.',
});

// First conversation
await cog.run(assistant, {
  input: 'My name is Alex and I live in Berlin.',
  threadId: 'user-123', // Unique thread ID
});

// Later conversation (agent remembers!)
const result = await cog.run(assistant, {
  input: 'What is my name and where do I live?',
  threadId: 'user-123', // Same thread ID
});

console.log(result.output); // "Your name is Alex and you live in Berlin."

await cog.close();
```

### Memory Adapters

| Adapter    | Use Case              | Persistence     |
| ---------- | --------------------- | --------------- |
| `memory`   | Development, testing  | None (RAM only) |
| `redis`    | Production short-term | Session-based   |
| `postgres` | Production long-term  | Permanent       |

For production with semantic search, use Postgres with pgvector:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: {
      connectionString: 'postgresql://user:pass@localhost:5432/cogitator',
    },
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text',
    },
  },
});
```

---

## Streaming Responses

For real-time output, enable streaming:

```typescript
const result = await cog.run(assistant, {
  input: 'Write a short poem about coding.',
  stream: true,
  onToken: (token) => {
    process.stdout.write(token); // Print each token as it arrives
  },
});

console.log('\n\nFull response:', result.output);
```

---

## Use Different LLM Providers

Cogitator supports multiple LLM providers with a unified API:

### Ollama (Local)

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: {
        baseUrl: 'http://localhost:11434',
      },
    },
  },
});

const agent = new Agent({
  model: 'llama3.1:8b', // or 'codellama:13b', 'mistral:7b'
  // ...
});
```

### OpenAI

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
      },
    },
  },
});

const agent = new Agent({
  model: 'gpt-4o', // or 'gpt-4.1', 'o3'
  // ...
});
```

### Anthropic

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'anthropic',
    providers: {
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    },
  },
});

const agent = new Agent({
  model: 'claude-sonnet-4-5-20250929', // or 'claude-opus-4-5'
  // ...
});
```

### Multiple Providers

You can configure multiple providers and use different ones for different agents:

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
      openai: { apiKey: process.env.OPENAI_API_KEY },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    },
  },
});

// Uses Ollama (default provider)
const localAgent = new Agent({
  model: 'llama3.1:8b',
  // ...
});

// Uses OpenAI (provider prefix overrides default)
const smartAgent = new Agent({
  model: 'openai/gpt-4.1',
  // ...
});

// Uses Anthropic (provider prefix overrides default)
const creativeAgent = new Agent({
  model: 'anthropic/claude-sonnet-4-5',
  // ...
});
```

**Model name format:**

- `model-name` — Uses the default provider (e.g., `gpt-4.1`, `llama3.1:8b`)
- `provider/model-name` — Explicitly specify provider (e.g., `openai/gpt-4.1`, `anthropic/claude-sonnet-4-5`)

---

## Configuration File

Create a `cogitator.yml` for project-wide settings:

```yaml
# cogitator.yml
llm:
  defaultProvider: ollama
  providers:
    ollama:
      baseUrl: http://localhost:11434
    openai:
      apiKey: ${OPENAI_API_KEY}

memory:
  adapter: redis
  redis:
    url: redis://localhost:6379

logging:
  level: info
  format: pretty
```

Load it automatically:

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { loadConfig } from '@cogitator-ai/config';

const config = await loadConfig(); // Loads cogitator.yml
const cog = new Cogitator(config);
```

---

## Docker Services

Start the required services with Docker Compose:

```bash
# Start all services
cogitator up

# Or manually with docker-compose
docker-compose up -d
```

This starts:

- **Redis** (port 6379) — Short-term memory
- **Postgres + pgvector** (port 5432) — Long-term memory with semantic search
- **Ollama** (port 11434) — Local LLM inference

Pull an Ollama model:

```bash
ollama pull llama3.1:8b
```

---

## Examples

Check out the `examples/` directory for more:

| Example                   | Description                    |
| ------------------------- | ------------------------------ |
| `basic-agent.ts`          | Simple agent with tools        |
| `research-agent.ts`       | Web search and summarization   |
| `code-assistant.ts`       | Code generation and execution  |
| `dev-team-swarm.ts`       | Multi-agent development team   |
| `workflow-code-review.ts` | DAG-based code review workflow |

Run an example:

```bash
npx tsx examples/basic-agent.ts
```

---

## Next Steps

Now that you have a working agent, explore more advanced features:

| Topic            | Description                                | Guide                                |
| ---------------- | ------------------------------------------ | ------------------------------------ |
| **Agents**       | Agent patterns, configuration, lifecycle   | [AGENTS.md](./AGENTS.md)             |
| **Tools**        | Building custom tools, MCP compatibility   | [TOOLS.md](./TOOLS.md)               |
| **Memory**       | Hybrid memory, semantic search             | [MEMORY.md](./MEMORY.md)             |
| **Workflows**    | DAG-based orchestration, human-in-the-loop | [WORKFLOWS.md](./WORKFLOWS.md)       |
| **Swarms**       | Multi-agent coordination strategies        | [SWARMS.md](./SWARMS.md)             |
| **Architecture** | System design deep dive                    | [ARCHITECTURE.md](./ARCHITECTURE.md) |

---

## Troubleshooting

### Ollama Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:11434
```

Make sure Ollama is running:

```bash
ollama serve
```

### Model Not Found

```
Error: model 'llama3.1:8b' not found
```

Pull the model first:

```bash
ollama pull llama3.1:8b
```

### Docker Services Not Starting

Check Docker is running:

```bash
docker info
```

Then start services:

```bash
docker-compose up -d
```

### OpenAI API Key Error

Set your API key as environment variable:

```bash
export OPENAI_API_KEY=sk-...
```

Or in `.env` file:

```
OPENAI_API_KEY=sk-...
```

---

## Getting Help

- **Documentation**: [docs/](./README.md)
- **Examples**: [examples/](../examples/)
- **Issues**: [GitHub Issues](https://github.com/cogitator-ai/Cogitator-AI/issues)

---

<div align="center">

**Ready to build something amazing?**

[Explore Agents →](./AGENTS.md)

</div>
