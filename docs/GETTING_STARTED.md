# Getting Started

> Build your first AI agent in 5 minutes

This guide walks you through installing Cogitator, creating your first agent, and running it with tools and memory. The website has the same material in more depth: [Getting Started](https://cogitator.app/docs/getting-started), [Quick Start](https://cogitator.app/docs/getting-started/quick-start), [Configuration](https://cogitator.app/docs/getting-started/configuration).

---

## Prerequisites

- **Node.js 22.12+** — [Download](https://nodejs.org/)
- **pnpm** (recommended) — `npm install -g pnpm`
- **Docker** (optional) — For Redis, Postgres, and sandboxed execution
- **Ollama** (for local LLMs) — [Download](https://ollama.com/), or use an OpenAI/Anthropic/Google API key

```bash
node --version    # v22.12.0 or higher
pnpm --version
docker --version  # optional
ollama --version  # optional
```

---

## Quick Start (3 minutes)

The fastest way to start is the project scaffolder:

```bash
npx create-cogitator-app my-agents --template basic --provider ollama --docker
cd my-agents

# Start Redis, Postgres (and Ollama, for the ollama provider)
docker compose up -d

# Run your first agent
pnpm dev
```

Templates: `basic`, `memory`, `swarm`, `workflow`, `api-server`, `nextjs`. Without flags the scaffolder asks for everything interactively. See [Project Scaffolding](https://cogitator.app/docs/getting-started/scaffolding).

The `@cogitator-ai/cli` package (`cogitator` command) covers the rest of the lifecycle: `cogitator init <name>` scaffolds a personal assistant connected to messaging channels (Telegram, Discord, Slack, WebChat, Bluesky, Threads), `cogitator up` starts the assistant from `cogitator.yml` or the Docker Compose services in the current directory, and `cogitator run`, `status`, `logs`, `down`, `deploy` and `models` do what they say. See [CLI](https://cogitator.app/docs/cli).

---

## Manual Installation

To add Cogitator to an existing project:

```bash
mkdir my-agents && cd my-agents
pnpm init

pnpm add @cogitator-ai/core @cogitator-ai/config zod
pnpm add -D typescript tsx @types/node
```

Set `"type": "module"` in `package.json` so top-level `await` works in the examples below.

---

## Create Your First Agent

Create a file `src/agent.ts`:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
    },
  },
});

const assistant = new Agent({
  name: 'assistant',
  model: 'ollama/llama3.2', // or 'openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5-5'
  instructions: 'You are a helpful assistant. Be concise and friendly.',
});

const result = await cog.run(assistant, {
  input: 'Hello! What can you help me with?',
});

console.log('Agent:', result.output);
console.log('Tokens:', result.usage.totalTokens);

await cog.close();
```

Run it (with Ollama running and `ollama pull llama3.2` done):

```bash
npx tsx src/agent.ts
```

The result carries the answer in `output`, token counts and cost in `usage`, every tool call in `toolCalls` and the run's spans in `trace`.

---

## Add Tools

Tools let your agent take actions. Define them with Zod schemas for full type safety:

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  execute: async ({ city, units }) => {
    return {
      city,
      temperature: units === 'celsius' ? 22 : 72,
      units,
      condition: 'sunny',
    };
  },
});

const weatherBot = new Agent({
  name: 'weather-bot',
  model: 'ollama/llama3.2',
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

Without any configuration, Cogitator talks to Ollama at `http://localhost:11434`.

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
  exec, // Shell commands (requires approval, Docker sandbox)
  webSearch, // Web search (Tavily, Brave or Serper)
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
  model: 'openai/gpt-6.1-sol',
  instructions: 'You are a powerful assistant with many tools.',
  tools: [calculator, datetime, fileRead, httpRequest],
});

const superAgent = new Agent({
  name: 'super-agent',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You have access to all tools.',
  tools: [...builtinTools],
});
```

Tools with `requiresApproval` (like `exec`) pause the run until someone decides — see [Approvals](https://cogitator.app/docs/tools/approvals) and [TOOLS.md](./TOOLS.md).

---

## Use Memory

Enable persistent memory so your agent remembers conversations:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  memory: {
    adapter: 'memory', // In-memory (for development)
    // adapter: 'redis', redis: { url: 'redis://localhost:6379' },
    // adapter: 'postgres', postgres: { connectionString: process.env.DATABASE_URL! },
  },
});

const assistant = new Agent({
  name: 'memory-assistant',
  model: 'ollama/llama3.2',
  instructions: 'You are a helpful assistant. Remember what the user tells you.',
});

await cog.run(assistant, {
  input: 'My name is Alex and I live in Berlin.',
  threadId: 'user-123',
});

const result = await cog.run(assistant, {
  input: 'What is my name and where do I live?',
  threadId: 'user-123',
});

console.log(result.output); // "Your name is Alex and you live in Berlin."

await cog.close();
```

### Memory Adapters

| Adapter    | Use Case                        | Persistence          | Via `memory.adapter` |
| ---------- | ------------------------------- | -------------------- | -------------------- |
| `memory`   | Development, testing            | None (RAM only)      | Yes                  |
| `redis`    | Production short-term (TTL)     | Until TTL expires    | Yes (`redis.url`)    |
| `postgres` | Production long-term + pgvector | Permanent            | Yes                  |
| `sqlite`   | Embedded / single-file storage  | Permanent            | No¹                  |
| `mongodb`  | Document-oriented workloads     | Permanent            | No¹                  |
| `qdrant`   | Vector search only              | Permanent (external) | No²                  |

¹ Create the adapter from `@cogitator-ai/memory`, `connect()` it and assign `cog.memory = adapter`.
² `QdrantAdapter` is an embedding store, not a conversation store; pair it with one of the adapters above.

For semantic retrieval, use Postgres with pgvector and a context builder. The runtime creates 768-dimensional vector columns, so pick a 768-dimension embedding model:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: {
      connectionString: 'postgresql://cogitator:cogitator@localhost:5432/cogitator',
    },
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text',
    },
    contextBuilder: {
      maxTokens: 8000,
      strategy: 'hybrid',
      includeSemanticContext: true,
    },
  },
});
```

See [MEMORY.md](./MEMORY.md) and [Memory](https://cogitator.app/docs/memory).

---

## Streaming Responses

For real-time output, enable streaming:

```typescript
const result = await cog.run(assistant, {
  input: 'Write a short poem about coding.',
  stream: true,
  onToken: (token) => {
    process.stdout.write(token);
  },
});

console.log('\n\nFull response:', result.output);
```

---

## Use Different LLM Providers

Cogitator supports Ollama, OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, vLLM, Mistral, Groq, Together and DeepSeek with one API. Backends read their keys from `llm.providers` — not from the environment directly (use `loadConfig()` from `@cogitator-ai/config` to pick up `OPENAI_API_KEY` and friends). See [LLM Backends](https://cogitator.app/docs/core/llm-backends).

### Ollama (Local)

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
    },
  },
});

const agent = new Agent({
  name: 'local',
  model: 'llama3.2', // or 'qwen3:8b', 'mistral:7b'
  instructions: 'You are a helpful assistant.',
});
```

### OpenAI

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});

const agent = new Agent({
  name: 'gpt',
  model: 'gpt-6.1-sol', // or 'gpt-5.5', 'o3'
  instructions: 'You are a helpful assistant.',
});
```

### Anthropic

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'anthropic',
    providers: {
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    },
  },
});

const agent = new Agent({
  name: 'claude',
  model: 'claude-sonnet-5-5', // or 'claude-opus-5-5'
  instructions: 'You are a helpful assistant.',
});
```

### Multiple Providers

Configure several providers and pick one per agent:

```typescript
const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
      openai: { apiKey: process.env.OPENAI_API_KEY! },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    },
  },
});

const localAgent = new Agent({
  name: 'local',
  model: 'llama3.2', // default provider (Ollama)
  instructions: 'You answer quick questions.',
});

const smartAgent = new Agent({
  name: 'smart',
  model: 'openai/gpt-6.1-sol', // provider prefix overrides the default
  instructions: 'You solve hard problems.',
});

const creativeAgent = new Agent({
  name: 'creative',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You write stories.',
});
```

**Model name format:**

- `model-name` — runs on `llm.defaultProvider` (Ollama when unset), e.g. `gpt-6.1-sol`, `llama3.2`
- `provider/model-name` — explicit provider, e.g. `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5-5`
- no `model` at all — the agent uses `llm.defaultModel`

---

## Configuration File

Create a `cogitator.yml` (or `cogitator.yaml`, `.cogitator.yml`) for project-wide settings. `${VAR}` and `${VAR:-default}` are substituted from the environment:

```yaml
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

Load it:

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { loadConfig } from '@cogitator-ai/config';

const config = loadConfig(); // synchronous: YAML, then env vars, then overrides
const cog = new Cogitator(config);
```

`loadConfig()` also maps environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_URL` and `COGITATOR_LLM_DEFAULT_MODEL` into the config, and validates the result. See [Configuration](https://cogitator.app/docs/getting-started/configuration).

---

## Docker Services

The repository's `docker-compose.yml` (and the one `create-cogitator-app --docker` generates) runs the backing services:

```bash
docker compose up -d
# or, with the CLI, from the directory holding docker-compose.yml:
cogitator up
```

The repository's compose file starts:

- **Redis** (port 6379) — Short-term memory
- **Postgres + pgvector** (port 5432) — Long-term memory with semantic search
- **Ollama** (port 11434) — Local LLM inference; an init container pulls `llama3.2:3b` and `nomic-embed-text-v2-moe`

Use `docker-compose.cpu.yml` on machines without an NVIDIA GPU. See [DOCKER.md](./DOCKER.md).

---

## Examples

The `examples/` directory has runnable scripts, for example:

| Example                                    | Description                             |
| ------------------------------------------ | --------------------------------------- |
| `examples/core/01-basic-agent.ts`          | Custom tools, streaming, usage tracking |
| `examples/core/02-built-in-tools.ts`       | Built-in tools in action                |
| `examples/core/04-context-manager.ts`      | Long conversation context management    |
| `examples/core/06-reflection.ts`           | Self-improving agent with reflection    |
| `examples/core/09-cost-routing.ts`         | Cost-aware model routing                |
| `examples/core/14-approvals.ts`            | Tool approvals with pause/resume        |
| `examples/core/15-handoffs.ts`             | Handing a conversation to another agent |
| `examples/swarms/01-debate-swarm.ts`       | Multi-agent debate swarm                |
| `examples/swarms/03-hierarchical-swarm.ts` | Hierarchical multi-agent team           |
| `examples/workflows/01-basic-workflow.ts`  | DAG-based workflow orchestration        |
| `examples/workflows/02-human-in-loop.ts`   | Workflow with human approval steps      |

Run an example from the repository root:

```bash
npx tsx examples/core/01-basic-agent.ts
```

---

## Next Steps

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
Error: model 'llama3.2' not found
```

Pull the model first:

```bash
ollama pull llama3.2
```

### Docker Services Not Starting

Check Docker is running:

```bash
docker info
```

Then start services:

```bash
docker compose up -d
```

### OpenAI API Key Error

Pass the key in the config (`llm.providers.openai.apiKey`), or export it and load the config with `loadConfig()`:

```bash
export OPENAI_API_KEY=sk-...
```

---

## Getting Help

- **Documentation**: [cogitator.app/docs](https://cogitator.app/docs)
- **Examples**: [examples/](../examples/)
- **Issues**: [GitHub Issues](https://github.com/cogitator-ai/Cogitator-AI/issues)
