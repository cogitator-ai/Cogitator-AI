# Cogitator Examples

Runnable examples covering every major package and feature.

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Set up environment
cp .env.example .env
# Edit .env — add at minimum GOOGLE_API_KEY

# 3. Build packages
pnpm build

# 4. Run any example
npx tsx examples/core/01-basic-agent.ts
```

## Default Provider

All examples use **Google Gemini 2.5 Flash** by default — it has a free tier (no credit card required).

To switch providers, edit `_shared/setup.ts` or set env variables:

| Provider         | Env Variable        | Model Example                 |
| ---------------- | ------------------- | ----------------------------- |
| Google (default) | `GOOGLE_API_KEY`    | `google/gemini-2.5-flash`     |
| OpenAI           | `OPENAI_API_KEY`    | `openai/gpt-5.2`              |
| Anthropic        | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-6` |
| Ollama (local)   | `OLLAMA_URL`        | `ollama/qwen2.5:7b`           |

## Examples by Category

### [`create-cogitator-app/`](./create-cogitator-app/) — Project Scaffolding

Programmatically scaffold new Cogitator projects using the `create-cogitator-app` API.

### [`cli/`](./cli/) — CLI Tool

Scaffold projects, manage Docker services, run agents from the terminal.

### [`core/`](./core/) — Core Runtime Features

Agent creation, tools, streaming, caching, reasoning, reflection, optimization, security, and more.

### [`memory/`](./memory/) — Memory & Knowledge

In-memory storage, context building, semantic search, knowledge graphs.

### [`swarms/`](./swarms/) — Multi-Agent Coordination

Debate, pipeline, and hierarchical swarm strategies.

### [`workflows/`](./workflows/) — DAG Workflows

Workflow builder, human-in-the-loop, map/reduce patterns.

### [`a2a/`](./a2a/) — Agent-to-Agent Protocol

Expose and consume agents as A2A services.

### [`mcp/`](./mcp/) — Model Context Protocol

Connect to external MCP servers and use their tools.

### [`integrations/`](./integrations/) — Framework Integrations

Express, Fastify, Hono, Koa, Next.js, OpenAI compatibility, Vercel AI SDK.

### [`infrastructure/`](./infrastructure/) — Infrastructure

Redis memory, PostgreSQL with pgvector, BullMQ workers, Docker deployment.
Requires `docker-compose up -d`.

### [`rag/`](./rag/) — RAG Pipeline

Document loading, chunking strategies, retrieval-augmented generation with agents.

### [`evals/`](./evals/) — Evaluation Framework

Basic evals, LLM-as-judge scoring, A/B comparison testing.

### [`voice/`](./voice/) — Voice & Realtime Agents

STT/TTS pipeline, realtime speech-to-speech, WebSocket voice agent server.

### [`advanced/`](./advanced/) — Advanced Features

Self-modifying agents, neuro-symbolic reasoning, WASM-sandboxed tools.
