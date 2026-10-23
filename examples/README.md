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

All examples use **Google Gemini 3.8 Flash** by default — it has a free tier (no credit card required).

To switch providers, edit `_shared/setup.ts` or set env variables:

| Provider         | Env Variable        | Model Example                  |
| ---------------- | ------------------- | ------------------------------ |
| Google (default) | `GOOGLE_API_KEY`    | `google/gemini-3.5-flash-lite` |
| OpenAI           | `OPENAI_API_KEY`    | `openai/gpt-5.2`               |
| Anthropic        | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5-5`  |
| Ollama (local)   | `OLLAMA_URL`        | `ollama/qwen3:8b`              |

## Examples by Category

### [`create-cogitator-app/`](./create-cogitator-app/) — Project Scaffolding

Programmatically scaffold new Cogitator projects using the `create-cogitator-app` API.

### [`cli/`](./cli/) — CLI Tool

Scaffold projects, manage Docker services, run agents from the terminal.

### [`config/`](./config/) — Configuration

YAML configuration loading, environment variable overrides, and Cogitator runtime initialization.

### [`core/`](./core/) — Core Runtime Features

Agent creation, tools, streaming, caching, reasoning, reflection, optimization, security, workspaces with long tool results saved to files, and more.

### [`memory/`](./memory/) — Memory & Knowledge

In-memory storage, context building, semantic search, knowledge graphs, memory files, agent memory search, and memory between runs (pre-turn brief, observations, consolidation with a playbook), and forgetting or redacting a turn or a user with everything memory made of them.

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

Redis memory, PostgreSQL with pgvector, BullMQ workers, Docker deployment, and agent workspaces
in E2B, Daytona and Vercel sandboxes.
Requires `docker-compose up -d`, the remote workspace example a provider account instead.

### [`rag/`](./rag/) — RAG Pipeline

Document loading, chunking strategies, retrieval-augmented generation with agents.

### [`evals/`](./evals/) — Evaluation Framework

Basic evals, LLM-as-judge scoring, A/B comparison testing.

### [`channels/`](./channels/) — Messaging Channels

Telegram assistant with owner commands, YAML-style super assistant built with `RuntimeBuilder` (terminal + Telegram, scheduler, memory), WebChat bot with a browser client (`webchat-client.html`), one post published to Bluesky and Threads with a scheduled follow-up (a dry run unless `PUBLISH=1`), an agent that answers mentions, replies and DMs there, a GitHub bot that answers mentions in issues, pull requests and review threads, an email bot that answers mail in its thread over IMAP and SMTP, and a Microsoft Teams bot that answers personal chats and @mentions in channel threads.

### [`voice/`](./voice/) — Voice & Realtime Agents

STT/TTS pipeline, realtime speech-to-speech, WebSocket voice agent server, a phone agent on Twilio Media Streams.

### [`advanced/`](./advanced/) — Advanced Features

Self-modifying agents, neuro-symbolic reasoning, WASM-sandboxed tools.
