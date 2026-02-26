<p align="center">
  <img src="logo.png" alt="Cogitator" width="200">
</p>

<div align="center">

# Cogitator

### AI agents that actually do things.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20+-green.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/@cogitator-ai/core.svg)](https://www.npmjs.com/package/@cogitator-ai/core)

[Quick Start](#-quick-start) · [Examples](./examples) · [Docs](https://cogitator.app/docs) · [Discord](https://discord.gg/SkmRsYvA)

</div>

---

## What is Cogitator?

You know how ChatGPT and Claude are great at _talking_? Cogitator makes AI that can _do things_.

An **agent** is an AI that has **tools** - it can search the web, read files, call APIs, write code, run queries. You give it a goal, it figures out which tools to use and in what order.

Cogitator is a TypeScript framework for building these agents. One agent or a hundred, local model or cloud API, simple script or production service - same code, same patterns.

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const weather = tool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `${city}: 22°C, sunny`,
});

const agent = new Agent({
  name: 'assistant',
  model: 'google/gemini-2.5-flash', // free tier, no credit card
  instructions: 'You help people with questions. Use tools when needed.',
  tools: [weather],
});

const cog = new Cogitator();
const result = await cog.run(agent, { input: 'What is the weather in Tokyo?' });
console.log(result.output);
```

That's it. The agent reads your question, decides to call `get_weather`, gets the result, and writes a human-friendly response.

---

## Quick Start

**Option A - scaffold a project:**

```bash
npx create-cogitator-app my-agents
cd my-agents && pnpm dev
```

Choose from 6 templates: basic agent, agent with memory, multi-agent swarm, DAG workflow, REST API server, or Next.js chat app.

**Option B - add to existing project:**

```bash
pnpm add @cogitator-ai/core zod
```

Set `GOOGLE_API_KEY` in your `.env` ([get one free here](https://aistudio.google.com/apikey)) and run any [example](./examples):

```bash
npx tsx examples/core/01-basic-agent.ts
```

> **Works with any LLM**: swap `google/gemini-2.5-flash` for `openai/gpt-4o`, `anthropic/claude-sonnet-4-6`, `ollama/llama3.3`, or [10+ other providers](https://cogitator.app/docs).

---

## What Can You Build?

| Use Case                     | What happens                                                           | Try it                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Chatbot with memory**      | Agent remembers your name, preferences, past conversations             | [`examples/memory/01-basic-memory.ts`](./examples/memory/01-basic-memory.ts)                 |
| **Research assistant**       | Agent uses tools, reasons step by step, returns structured answers     | [`examples/core/01-basic-agent.ts`](./examples/core/01-basic-agent.ts)                       |
| **Content pipeline**         | Researcher → Writer → Editor, each agent builds on the previous        | [`examples/swarms/02-pipeline-swarm.ts`](./examples/swarms/02-pipeline-swarm.ts)             |
| **Dev team simulation**      | Manager delegates frontend/backend to specialists, synthesizes results | [`examples/swarms/03-hierarchical-swarm.ts`](./examples/swarms/03-hierarchical-swarm.ts)     |
| **REST API server**          | Mount agents as HTTP endpoints with Swagger, SSE streaming, WebSocket  | [`examples/integrations/01-express-server.ts`](./examples/integrations/01-express-server.ts) |
| **Data processing workflow** | Analyze documents in parallel, aggregate with map-reduce               | [`examples/workflows/03-map-reduce.ts`](./examples/workflows/03-map-reduce.ts)               |
| **Knowledge graph**          | Extract entities from text, build a graph, traverse relationships      | [`examples/memory/04-knowledge-graph.ts`](./examples/memory/04-knowledge-graph.ts)           |
| **RAG Q&A system**           | Load docs, chunk, embed, retrieve relevant context, answer questions   | [`examples/rag/01-basic-retrieval.ts`](./examples/rag/01-basic-retrieval.ts)                 |
| **Agent evaluation**         | Measure accuracy, compare models, run A/B tests with LLM judges        | [`examples/evals/01-basic-eval.ts`](./examples/evals/01-basic-eval.ts)                       |
| **Cross-framework agents**   | Expose your agent via Google's A2A protocol, consume external agents   | [`examples/a2a/01-a2a-server.ts`](./examples/a2a/01-a2a-server.ts)                           |

---

## Packages

Install only what you need. Everything is a separate npm package.

| Package                                                                                      | What it does                                                                                   | Example                                                              |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@cogitator-ai/core`](https://www.npmjs.com/package/@cogitator-ai/core)                     | Agents, tools, LLM backends, streaming, everything you need to start                           | [12 core examples](./examples/core/)                                 |
| [`@cogitator-ai/memory`](https://www.npmjs.com/package/@cogitator-ai/memory)                 | Your agents remember things. Redis, Postgres, SQLite, MongoDB, Qdrant, in-memory               | [4 memory examples](./examples/memory/)                              |
| [`@cogitator-ai/swarms`](https://www.npmjs.com/package/@cogitator-ai/swarms)                 | 7 swarm strategies — hierarchy, round-robin, consensus, pipeline, debate, auction, negotiation | [4 swarm examples](./examples/swarms/)                               |
| [`@cogitator-ai/workflows`](https://www.npmjs.com/package/@cogitator-ai/workflows)           | DAG workflows with branching, human approval gates, map-reduce                                 | [3 workflow examples](./examples/workflows/)                         |
| [`@cogitator-ai/a2a`](https://www.npmjs.com/package/@cogitator-ai/a2a)                       | Google's Agent-to-Agent protocol - expose agents as services, consume external ones            | [2 a2a examples](./examples/a2a/)                                    |
| [`@cogitator-ai/mcp`](https://www.npmjs.com/package/@cogitator-ai/mcp)                       | Connect to any MCP server and use its tools                                                    | [1 mcp example](./examples/mcp/)                                     |
| [`@cogitator-ai/sandbox`](https://www.npmjs.com/package/@cogitator-ai/sandbox)               | Run untrusted code in Docker or WASM. Never on your host                                       | [sandbox example](./examples/infrastructure/05-sandbox-execution.ts) |
| [`@cogitator-ai/wasm-tools`](https://www.npmjs.com/package/@cogitator-ai/wasm-tools)         | 14 pre-built tools running in WASM sandbox (calc, json, hash, csv, markdown...)                | [wasm example](./examples/advanced/03-wasm-tools.ts)                 |
| [`@cogitator-ai/self-modifying`](https://www.npmjs.com/package/@cogitator-ai/self-modifying) | Agents that generate new tools at runtime and evolve their own architecture                    | [self-modifying example](./examples/advanced/01-self-modifying.ts)   |
| [`@cogitator-ai/neuro-symbolic`](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) | Prolog-style logic, constraint solving, knowledge graphs for agents                            | [neuro-symbolic example](./examples/advanced/02-neuro-symbolic.ts)   |
| [`@cogitator-ai/rag`](https://www.npmjs.com/package/@cogitator-ai/rag)                       | RAG pipeline - document loaders, chunking, retrieval, reranking                                | [3 rag examples](./examples/rag/)                                    |
| [`@cogitator-ai/evals`](https://www.npmjs.com/package/@cogitator-ai/evals)                   | Evaluation framework - metrics, LLM judges, A/B testing, assertions                            | [3 eval examples](./examples/evals/)                                 |
| [`@cogitator-ai/voice`](https://www.npmjs.com/package/@cogitator-ai/voice)                   | Voice/Realtime agent capabilities - STT, TTS, VAD, realtime sessions                           | [3 voice examples](./examples/voice/)                                |
| [`@cogitator-ai/browser`](https://www.npmjs.com/package/@cogitator-ai/browser)               | Browser automation - Playwright, stealth, vision, network control                              | [4 browser examples](./examples/browser/)                            |
| [`@cogitator-ai/deploy`](https://www.npmjs.com/package/@cogitator-ai/deploy)                 | Deploy your agents to Docker or Fly.io                                                         | [deploy example](./examples/infrastructure/04-deploy-docker.ts)      |
| [`@cogitator-ai/cli`](https://www.npmjs.com/package/@cogitator-ai/cli)                       | `cogitator init` / `up` / `run` / `deploy` from your terminal                                  | -                                                                    |

**Server adapters** - mount agents as REST APIs with one line:

[`express`](https://www.npmjs.com/package/@cogitator-ai/express) ·
[`fastify`](https://www.npmjs.com/package/@cogitator-ai/fastify) ·
[`hono`](https://www.npmjs.com/package/@cogitator-ai/hono) ·
[`koa`](https://www.npmjs.com/package/@cogitator-ai/koa) ·
[`next`](https://www.npmjs.com/package/@cogitator-ai/next) ·
[`ai-sdk`](https://www.npmjs.com/package/@cogitator-ai/ai-sdk) ·
[`openai-compat`](https://www.npmjs.com/package/@cogitator-ai/openai-compat)

All with Swagger docs, SSE streaming, and WebSocket support. See [integration examples](./examples/integrations/).

---

## Features at a Glance

### LLM & Models

| Feature                | What it means                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **Any provider**       | OpenAI, Anthropic, Google, Ollama, Azure, Bedrock, Mistral, Groq, Together, DeepSeek - same code |
| **Structured outputs** | JSON mode and JSON Schema validation across all providers                                        |
| **Vision & audio**     | Send images, transcribe audio, generate speech                                                   |
| **Cost-aware routing** | Auto-pick cheap models for easy tasks, expensive for hard ones                                   |
| **Cost prediction**    | Know how much a run will cost before you execute it                                              |

### Memory & Knowledge

| Feature                | What it means                                                    |
| ---------------------- | ---------------------------------------------------------------- |
| **6 storage backends** | Redis, Postgres, SQLite, MongoDB, Qdrant, in-memory              |
| **Semantic search**    | BM25 + vector hybrid search with Reciprocal Rank Fusion          |
| **Knowledge graphs**   | Extract entities, build graphs, traverse multi-hop relationships |
| **RAG pipeline**       | Document loaders, smart chunking, hybrid retrieval, reranking    |
| **Context management** | Auto-compress long conversations to fit model limits             |

### Multi-Agent

| Feature                | What it means                                                                |
| ---------------------- | ---------------------------------------------------------------------------- |
| **7 swarm strategies** | Hierarchical, consensus, round-robin, auction, pipeline, debate, negotiation |
| **DAG workflows**      | Build pipelines with branching, retries, compensation, human approval        |
| **A2A Protocol**       | Google's standard for agents talking to agents across frameworks             |
| **Agent-as-Tool**      | Use one agent as a tool for another - simple delegation                      |

### Safety & Security

| Feature                        | What it means                                                   |
| ------------------------------ | --------------------------------------------------------------- |
| **Constitutional AI**          | Auto-filter harmful inputs/outputs with critique-revision loops |
| **Prompt injection detection** | Catch jailbreaks, DAN attacks, encoding tricks                  |
| **Sandboxed execution**        | Docker and WASM isolation for untrusted code                    |
| **Tool guards**                | Block dangerous commands, validate paths, require approval      |

### Advanced

| Feature                   | What it means                                                        |
| ------------------------- | -------------------------------------------------------------------- |
| **Self-modifying agents** | Agents detect missing capabilities and generate new tools at runtime |
| **Tree of Thoughts**      | Explore multiple reasoning paths with backtracking                   |
| **Causal reasoning**      | Pearl's Ladder - association, intervention, counterfactuals          |
| **Self-reflection**       | Agents learn from their actions and improve over time                |
| **Agent optimizer**       | DSPy-style instruction tuning from execution traces                  |
| **Time-travel debugging** | Checkpoint, replay, fork agent executions like `git bisect`          |
| **Neuro-symbolic**        | Prolog-style logic + SAT solving for formal reasoning                |

### Developer Experience

| Feature                 | What it means                                   |
| ----------------------- | ----------------------------------------------- |
| **OpenTelemetry**       | Full tracing to Jaeger, Grafana, Datadog        |
| **Langfuse**            | LLM-native observability with prompt management |
| **Tool caching**        | Cache tool results (exact or semantic matching) |
| **Agent serialization** | Save agents to JSON, restore later              |
| **Debug mode**          | Full request/response logging for LLM calls     |
| **Evals framework**     | Metrics, LLM judges, A/B testing, assertions    |
| **Plugin system**       | Register custom LLM backends                    |

---

## Why Cogitator?

|                   | Cogitator     | LangChain      | OpenAI Assistants |
| ----------------- | ------------- | -------------- | ----------------- |
| **Language**      | TypeScript    | Python         | REST API          |
| **Self-hosted**   | Yes           | Yes            | No                |
| **Any LLM**       | Yes           | Yes            | OpenAI only       |
| **Multi-agent**   | 7 strategies  | Limited        | No                |
| **A2A Protocol**  | Yes           | No             | No                |
| **Observability** | OpenTelemetry | Requires setup | Dashboard only    |
| **Dependencies**  | ~20           | 150+           | N/A               |

---

## 52 Runnable Examples

Every major feature has a working example you can run right now.

```bash
npx tsx examples/core/01-basic-agent.ts
```

| Category                                        | Count | What you'll learn                                                                                                                                              |
| ----------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`core/`](./examples/core/)                     | 12    | Agents, tools, streaming, caching, tree-of-thought, reflection, optimization, time-travel, cost routing, constitutional AI, prompt injection, causal reasoning |
| [`memory/`](./examples/memory/)                 | 4     | In-memory storage, context building, semantic search, knowledge graphs                                                                                         |
| [`swarms/`](./examples/swarms/)                 | 4     | Debate, pipeline, hierarchical coordination, negotiation                                                                                                       |
| [`workflows/`](./examples/workflows/)           | 3     | DAG workflows, human-in-the-loop, map-reduce                                                                                                                   |
| [`a2a/`](./examples/a2a/)                       | 2     | A2A server and client                                                                                                                                          |
| [`mcp/`](./examples/mcp/)                       | 1     | MCP server integration                                                                                                                                         |
| [`rag/`](./examples/rag/)                       | 3     | Basic retrieval, chunking strategies, agent with RAG                                                                                                           |
| [`evals/`](./examples/evals/)                   | 3     | Basic evaluation, LLM judge, A/B comparison                                                                                                                    |
| [`voice/`](./examples/voice/)                   | 3     | Voice pipeline, realtime sessions, voice agents                                                                                                                |
| [`browser/`](./examples/browser/)               | 4     | Web scraping, form automation, stealth agents, crypto price scraper                                                                                            |
| [`integrations/`](./examples/integrations/)     | 7     | Express, Fastify, Hono, Koa, Next.js, OpenAI compat, AI SDK                                                                                                    |
| [`infrastructure/`](./examples/infrastructure/) | 4     | Redis, PostgreSQL, job queues, Docker deploy                                                                                                                   |
| [`advanced/`](./examples/advanced/)             | 3     | Self-modifying agents, neuro-symbolic reasoning, WASM tools                                                                                                    |

Default LLM is **Google Gemini 2.5 Flash** - free tier, no credit card. See [`examples/README.md`](./examples/README.md) for setup.

---

## Contributing

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/cogitator.git
cd cogitator && pnpm install && pnpm dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

<details>
<summary><strong>All npm packages</strong></summary>

| Package                                                                                    | Description                                                  | Version                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [@cogitator-ai/core](https://www.npmjs.com/package/@cogitator-ai/core)                     | Core runtime (Agent, Tool, Cogitator)                        | [![npm](https://img.shields.io/npm/v/@cogitator-ai/core.svg)](https://www.npmjs.com/package/@cogitator-ai/core)                     |
| [create-cogitator-app](https://www.npmjs.com/package/create-cogitator-app)                 | Interactive project scaffolding (`npx create-cogitator-app`) | [![npm](https://img.shields.io/npm/v/create-cogitator-app.svg)](https://www.npmjs.com/package/create-cogitator-app)                 |
| [@cogitator-ai/cli](https://www.npmjs.com/package/@cogitator-ai/cli)                       | CLI tool (`cogitator init/up/run/deploy`)                    | [![npm](https://img.shields.io/npm/v/@cogitator-ai/cli.svg)](https://www.npmjs.com/package/@cogitator-ai/cli)                       |
| [@cogitator-ai/types](https://www.npmjs.com/package/@cogitator-ai/types)                   | Shared TypeScript interfaces                                 | [![npm](https://img.shields.io/npm/v/@cogitator-ai/types.svg)](https://www.npmjs.com/package/@cogitator-ai/types)                   |
| [@cogitator-ai/config](https://www.npmjs.com/package/@cogitator-ai/config)                 | Configuration management                                     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/config.svg)](https://www.npmjs.com/package/@cogitator-ai/config)                 |
| [@cogitator-ai/memory](https://www.npmjs.com/package/@cogitator-ai/memory)                 | Memory adapters (Postgres, Redis, SQLite, MongoDB, Qdrant)   | [![npm](https://img.shields.io/npm/v/@cogitator-ai/memory.svg)](https://www.npmjs.com/package/@cogitator-ai/memory)                 |
| [@cogitator-ai/models](https://www.npmjs.com/package/@cogitator-ai/models)                 | Dynamic model registry with pricing                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/models.svg)](https://www.npmjs.com/package/@cogitator-ai/models)                 |
| [@cogitator-ai/workflows](https://www.npmjs.com/package/@cogitator-ai/workflows)           | DAG-based workflow engine                                    | [![npm](https://img.shields.io/npm/v/@cogitator-ai/workflows.svg)](https://www.npmjs.com/package/@cogitator-ai/workflows)           |
| [@cogitator-ai/swarms](https://www.npmjs.com/package/@cogitator-ai/swarms)                 | Multi-agent swarm coordination                               | [![npm](https://img.shields.io/npm/v/@cogitator-ai/swarms.svg)](https://www.npmjs.com/package/@cogitator-ai/swarms)                 |
| [@cogitator-ai/mcp](https://www.npmjs.com/package/@cogitator-ai/mcp)                       | MCP (Model Context Protocol) support                         | [![npm](https://img.shields.io/npm/v/@cogitator-ai/mcp.svg)](https://www.npmjs.com/package/@cogitator-ai/mcp)                       |
| [@cogitator-ai/a2a](https://www.npmjs.com/package/@cogitator-ai/a2a)                       | A2A Protocol v0.3 - cross-agent interoperability             | [![npm](https://img.shields.io/npm/v/@cogitator-ai/a2a.svg)](https://www.npmjs.com/package/@cogitator-ai/a2a)                       |
| [@cogitator-ai/sandbox](https://www.npmjs.com/package/@cogitator-ai/sandbox)               | Docker/WASM sandboxed execution                              | [![npm](https://img.shields.io/npm/v/@cogitator-ai/sandbox.svg)](https://www.npmjs.com/package/@cogitator-ai/sandbox)               |
| [@cogitator-ai/redis](https://www.npmjs.com/package/@cogitator-ai/redis)                   | Redis client (standalone + cluster)                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/redis.svg)](https://www.npmjs.com/package/@cogitator-ai/redis)                   |
| [@cogitator-ai/worker](https://www.npmjs.com/package/@cogitator-ai/worker)                 | Distributed job queue (BullMQ)                               | [![npm](https://img.shields.io/npm/v/@cogitator-ai/worker.svg)](https://www.npmjs.com/package/@cogitator-ai/worker)                 |
| [@cogitator-ai/openai-compat](https://www.npmjs.com/package/@cogitator-ai/openai-compat)   | OpenAI Assistants API compatibility                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/openai-compat.svg)](https://www.npmjs.com/package/@cogitator-ai/openai-compat)   |
| [@cogitator-ai/wasm-tools](https://www.npmjs.com/package/@cogitator-ai/wasm-tools)         | WASM-based sandboxed tools (14 built-in)                     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/wasm-tools.svg)](https://www.npmjs.com/package/@cogitator-ai/wasm-tools)         |
| [@cogitator-ai/self-modifying](https://www.npmjs.com/package/@cogitator-ai/self-modifying) | Self-modifying agents with meta-reasoning                    | [![npm](https://img.shields.io/npm/v/@cogitator-ai/self-modifying.svg)](https://www.npmjs.com/package/@cogitator-ai/self-modifying) |
| [@cogitator-ai/neuro-symbolic](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) | Neuro-symbolic reasoning with SAT/SMT                        | [![npm](https://img.shields.io/npm/v/@cogitator-ai/neuro-symbolic.svg)](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) |
| [@cogitator-ai/rag](https://www.npmjs.com/package/@cogitator-ai/rag)                       | RAG pipeline with loaders, chunking, retrieval, reranking    | [![npm](https://img.shields.io/npm/v/@cogitator-ai/rag.svg)](https://www.npmjs.com/package/@cogitator-ai/rag)                       |
| [@cogitator-ai/evals](https://www.npmjs.com/package/@cogitator-ai/evals)                   | Evaluation framework with metrics, A/B testing, assertions   | [![npm](https://img.shields.io/npm/v/@cogitator-ai/evals.svg)](https://www.npmjs.com/package/@cogitator-ai/evals)                   |
| [@cogitator-ai/voice](https://www.npmjs.com/package/@cogitator-ai/voice)                   | Voice/Realtime agents (STT, TTS, VAD, realtime sessions)     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/voice.svg)](https://www.npmjs.com/package/@cogitator-ai/voice)                   |
| [@cogitator-ai/browser](https://www.npmjs.com/package/@cogitator-ai/browser)               | Browser automation (Playwright, stealth, vision, 32 tools)   | [![npm](https://img.shields.io/npm/v/@cogitator-ai/browser.svg)](https://www.npmjs.com/package/@cogitator-ai/browser)               |
| [@cogitator-ai/dashboard](https://www.npmjs.com/package/@cogitator-ai/dashboard)           | Real-time observability dashboard                            | [![npm](https://img.shields.io/npm/v/@cogitator-ai/dashboard.svg)](https://www.npmjs.com/package/@cogitator-ai/dashboard)           |
| [@cogitator-ai/next](https://www.npmjs.com/package/@cogitator-ai/next)                     | Next.js App Router integration                               | [![npm](https://img.shields.io/npm/v/@cogitator-ai/next.svg)](https://www.npmjs.com/package/@cogitator-ai/next)                     |
| [@cogitator-ai/ai-sdk](https://www.npmjs.com/package/@cogitator-ai/ai-sdk)                 | Vercel AI SDK adapter (bidirectional)                        | [![npm](https://img.shields.io/npm/v/@cogitator-ai/ai-sdk.svg)](https://www.npmjs.com/package/@cogitator-ai/ai-sdk)                 |
| [@cogitator-ai/express](https://www.npmjs.com/package/@cogitator-ai/express)               | Express.js REST API server                                   | [![npm](https://img.shields.io/npm/v/@cogitator-ai/express.svg)](https://www.npmjs.com/package/@cogitator-ai/express)               |
| [@cogitator-ai/fastify](https://www.npmjs.com/package/@cogitator-ai/fastify)               | Fastify REST API server                                      | [![npm](https://img.shields.io/npm/v/@cogitator-ai/fastify.svg)](https://www.npmjs.com/package/@cogitator-ai/fastify)               |
| [@cogitator-ai/hono](https://www.npmjs.com/package/@cogitator-ai/hono)                     | Hono multi-runtime server (Edge, Bun, Deno, Node.js)         | [![npm](https://img.shields.io/npm/v/@cogitator-ai/hono.svg)](https://www.npmjs.com/package/@cogitator-ai/hono)                     |
| [@cogitator-ai/koa](https://www.npmjs.com/package/@cogitator-ai/koa)                       | Koa middleware-based server                                  | [![npm](https://img.shields.io/npm/v/@cogitator-ai/koa.svg)](https://www.npmjs.com/package/@cogitator-ai/koa)                       |
| [@cogitator-ai/deploy](https://www.npmjs.com/package/@cogitator-ai/deploy)                 | Deployment engine (Docker, Fly.io)                           | [![npm](https://img.shields.io/npm/v/@cogitator-ai/deploy.svg)](https://www.npmjs.com/package/@cogitator-ai/deploy)                 |

</details>

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=cogitator-ai/Cogitator-AI&type=date&legend=top-left)](https://www.star-history.com/#cogitator-ai/Cogitator-AI&type=date&legend=top-left)

---

## License

MIT - see [LICENSE](./LICENSE).

---

<div align="center">

**Built for engineers who trust their agents to run while they sleep.**

[Star on GitHub](https://github.com/cogitator-ai/Cogitator-AI) · [Docs](https://cogitator.app/docs) · [Discord](https://discord.gg/SkmRsYvA)

</div>
