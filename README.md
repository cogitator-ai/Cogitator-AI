<p align="center">
  <img src="logo.png" alt="Cogitator" width="200">
</p>

<div align="center">

# Cogitator

### Self-hosted agents, swarms and workflows in TypeScript.

Built for engineers who trust their agents to run while they sleep.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22.12+-green.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/@cogitator-ai/core.svg)](https://www.npmjs.com/package/@cogitator-ai/core)
[![npm downloads](https://img.shields.io/npm/dm/@cogitator-ai/core.svg)](https://www.npmjs.com/package/@cogitator-ai/core)
[![CI](https://github.com/cogitator-ai/Cogitator-AI/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/cogitator-ai/Cogitator-AI/actions/workflows/ci.yml)

[Quick Start](#quick-start) · [Examples](./examples) · [Docs](https://cogitator.app/docs) · [Cookbook](https://cogitator.app/cookbook) · [Discussions](https://github.com/cogitator-ai/Cogitator-AI/discussions)

Coding agents can read the docs as Markdown: [`cogitator.app/llms.txt`](https://cogitator.app/llms.txt) (index) and [`cogitator.app/llms-full.txt`](https://cogitator.app/llms-full.txt) (everything in one file).

</div>

---

---

## What is Cogitator?

Cogitator is a TypeScript runtime for LLM agents that runs on your own infrastructure. Start with one agent and a couple of tools, then grow into multi-agent swarms, durable workflows and agents served over HTTP, MCP or A2A, with the same `Agent`, `tool()` and `Cogitator` you started with.

It works with 12 providers, from OpenAI, Anthropic and Google to local models through Ollama, and `@cogitator-ai/core` has 7 dependencies.

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
  model: 'google/gemini-3.8-flash', // free tier, no credit card
  instructions: 'You help people with questions. Use tools when needed.',
  tools: [weather],
});

const cog = new Cogitator({
  llm: {
    providers: {
      google: { apiKey: process.env.GOOGLE_API_KEY! },
    },
  },
});
const result = await cog.run(agent, { input: 'What is the weather in Tokyo?' });
console.log(result.output);
```

Tools are typed with Zod: the model sees a JSON Schema, and `execute` gets validated arguments. Change the model string to switch providers, nothing else changes.

---

## Quick Start

**Option A - scaffold a project:**

```bash
npx create-cogitator-app my-agents
cd my-agents && npm run dev
npm run dev:studio     # Cogitator Studio: chat, traces and costs, approvals, workflows, forks
```

- **16 presets**: agent, personal assistant, memory, Express, Hono or Tetsu API, Next.js chat, messaging bot, RAG, MCP, swarm, workflow, durable workflow, A2A, realtime voice and evals. Or start from any example in this repository (`--example core/basic-agent`) or from a GitHub template.
- **Services handled**: with Docker running, it starts Postgres, Redis and the Ollama model the stack needs and waits until they are healthy. Without Docker, the first run tells you what is missing (`ollama pull`, or a key in `.env`).
- **Ready for coding agents**: every project has a registry of its agents, tests on a mocked model, an `AGENTS.md` and the docs bundled for Claude Code, Cursor and Codex.
- **Grows with you**: `npx cogitator add rag` (or MCP, workflows, evals, memory, deploy) adds a feature later and merges with your edits.

**Option B - add to an existing project:**

```bash
pnpm add @cogitator-ai/core zod
```

Set `GOOGLE_API_KEY` in your `.env` ([get one free here](https://aistudio.google.com/apikey)) and run any [example](./examples):

```bash
npx tsx examples/core/01-basic-agent.ts
```

> **Works with any LLM**: swap `google/gemini-3.8-flash` for `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5-5`, `ollama/llama3.3`, or any other of the [12 built-in providers](https://cogitator.app/docs/core/llm-backends).

---

## Highlights

- **A coding agent in one call.** `createHarnessAgent()` assembles a workspace with file tools and a shell, a todo list, `SKILL.md` skills, Markdown subagents and commands, `AGENTS.md`, the permission engine, compaction, long tool results saved as files, `tool_search` for many tools and parallel read-only calls. Presets `coding` and `assistant`, every piece overridable, the result plain values you can read.
- **Agents that work as a team.** Eight swarm strategies (hierarchy, round-robin, consensus, pipeline, debate, auction, negotiation, and agent teams with a shared task board and mailboxes), handoffs and agents as tools, plus DAG workflows with human approval, sagas and map-reduce.
- **Workflows and agent runs that outlive the process.** Checkpoints, approvals and timers live in Redis or Postgres, so a workflow resumes from its last checkpoint after a restart or on another machine. Durable agent runs keep a checkpoint after every step, and `recoverRuns()` continues them on another process without running a finished tool twice. Streams resume too: a client that loses the connection reconnects with `Last-Event-ID` and gets what it missed.
- **Rules you can read, decisions you can audit.** Claude Code compatible allow, ask and deny rules from `.claude/settings.json`, permission modes from plan to bypass, an `auto` mode with a classifier model, every decision in the thread's log, and session budgets that pause a run instead of failing it.
- **Subagents and commands, as your repository already has them.** `.claude/agents/*.md` subagents behind one `agent` tool, with tool lists, models, permission modes that only narrow, approvals that bubble up through nested checkpoints, background runs continued by id and git worktree isolation, and `.claude/commands/*.md` templates expanded from `/name args`.
- **Hooks and project instructions, as your repository already has them.** The `hooks` of Claude Code's `settings.json` (commands, HTTP endpoints, model prompts, MCP tools) run before and after tool calls, at session start and when the agent would stop, and `AGENTS.md` and `CLAUDE.md` load into the system prompt with their imports and path-scoped rules.
- **Untrusted code, contained.** Docker and WASM sandboxes with resource limits, and 18 pre-built WASM tools for hashing, parsing, conversions and more.
- **A debugger, not just logs.** Cogitator Studio shows the trace and cost of every run, lets you approve tool calls, rerun a workflow from a node and fork a run from any step. Traces also export to OpenTelemetry and Langfuse.
- **Memory that keeps its sources.** Six storage backends, BM25 plus vector hybrid search, knowledge graphs, and facts extracted from conversations, each tied to the quote it came from. Forget or redact a turn and what memory made of it goes too. With embeddings, every turn recalls the earlier turns and memory items it needs by default, chosen on [seven long-memory benchmarks](https://cogitator.app/docs/memory/benchmarks).
- **Speaks the protocols.** MCP as client and server, Google's A2A in both directions, an OpenAI-compatible API, and adapters for Express, Fastify, Hono, Koa, Next.js and Tetsu.
- **More than prompting.** Prolog-style logic and Z3/SAT solving for verifiable plans, tree-of-thought and causal reasoning.

---

## What Can You Build?

| Use Case                           | What happens                                                                                                                    | Try it                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Chatbot with memory**            | Agent remembers your name, preferences, past conversations                                                                      | [`examples/memory/01-basic-memory.ts`](./examples/memory/01-basic-memory.ts)                 |
| **Research assistant**             | Agent uses tools, reasons step by step, returns structured answers                                                              | [`examples/core/01-basic-agent.ts`](./examples/core/01-basic-agent.ts)                       |
| **Content pipeline**               | Researcher → Writer → Editor, each agent builds on the previous                                                                 | [`examples/swarms/02-pipeline-swarm.ts`](./examples/swarms/02-pipeline-swarm.ts)             |
| **Dev team simulation**            | Manager delegates frontend/backend to specialists, synthesizes results                                                          | [`examples/swarms/03-hierarchical-swarm.ts`](./examples/swarms/03-hierarchical-swarm.ts)     |
| **REST API server**                | Mount agents as HTTP endpoints with Swagger, SSE streaming, WebSocket                                                           | [`examples/integrations/01-express-server.ts`](./examples/integrations/01-express-server.ts) |
| **Multi-user support agent**       | One agent serves many users through your own MCP server, each with their own token and threads                                  | [`examples/mcp/03-per-user-mcp.ts`](./examples/mcp/03-per-user-mcp.ts)                       |
| **Data processing workflow**       | Analyze documents in parallel, aggregate with map-reduce                                                                        | [`examples/workflows/03-map-reduce.ts`](./examples/workflows/03-map-reduce.ts)               |
| **Knowledge graph**                | Extract entities from text, build a graph, traverse relationships                                                               | [`examples/memory/04-knowledge-graph.ts`](./examples/memory/04-knowledge-graph.ts)           |
| **Agent that keeps notes**         | Agent writes notes under `/memories` it reads in later conversations, searches old turns and cites them                         | [`examples/memory/05-memory-files.ts`](./examples/memory/05-memory-files.ts)                 |
| **Agent that learns between runs** | Memory tidies itself in the background: repeats go stale, lessons become playbook rules, facts become observations              | [`examples/memory/06-memory-upkeep.ts`](./examples/memory/06-memory-upkeep.ts)               |
| **Agent that forgets on request**  | Forget or redact a turn, a thread or a user, and the summaries, facts and notes memory made of them go with it                  | [`examples/memory/07-forget-and-redact.ts`](./examples/memory/07-forget-and-redact.ts)       |
| **Agent with skills**              | Agent finds `SKILL.md` skills, loads one when a task needs it, plans with a todo list and searches for tools it lacks           | [`examples/core/23-skills-and-todos.ts`](./examples/core/23-skills-and-todos.ts)             |
| **Agent you can steer mid-run**    | Steer or follow up a run going on, a tool that pauses to ask a person, a second message that interrupts the first               | [`examples/core/24-run-control.ts`](./examples/core/24-run-control.ts)                       |
| **Agent with fast, visible tools** | Safe tool calls run together, a write runs alone, tools report progress and rich results, calls stream as the model writes them | [`examples/core/25-tool-execution.ts`](./examples/core/25-tool-execution.ts)                 |
| **Agent with guard rails you set** | Claude Code compatible allow, ask and deny rules, plan mode before edits, an audit log, session budgets that pause the run      | [`examples/core/26-permissions.ts`](./examples/core/26-permissions.ts)                       |
| **Repository that guards itself**  | Claude Code hooks from `.claude/settings.json` refuse a push to main, `AGENTS.md` lands in the system prompt                    | [`examples/core/27-hooks.ts`](./examples/core/27-hooks.ts)                                   |
| **Lead with specialist subagents** | `.claude/agents` reviewers and releasers behind one `agent` tool, an approval that bubbles up, a `/review` command              | [`examples/core/28-subagents.ts`](./examples/core/28-subagents.ts)                           |
| **Coding agent in one call**       | `createHarnessAgent()` puts workspace tools, a shell, todos, skills, subagents, `AGENTS.md` and approvals together, fixes a bug | [`examples/core/29-harness-agent.ts`](./examples/core/29-harness-agent.ts)                   |
| **Agent that survives a crash**    | A run killed with `SIGKILL` mid-tool is recovered by another process from its last step, the lost call reported, not repeated   | [`examples/core/30-durable-runs.ts`](./examples/core/30-durable-runs.ts)                     |
| **Agent team on a task board**     | A lead plans tasks, members claim them, work concurrently and talk through mailboxes, live in Studio                            | [`examples/swarms/05-agent-team.ts`](./examples/swarms/05-agent-team.ts)                     |
| **RAG Q&A system**                 | Load docs, chunk, embed, retrieve relevant context, answer questions                                                            | [`examples/rag/01-basic-retrieval.ts`](./examples/rag/01-basic-retrieval.ts)                 |
| **Agent evaluation**               | Measure accuracy, compare models, run A/B tests with LLM judges                                                                 | [`examples/evals/01-basic-eval.ts`](./examples/evals/01-basic-eval.ts)                       |
| **Personal AI assistant**          | Your own AI running 24/7 on Telegram, Discord, Slack, Bluesky, Threads, GitHub, email, Teams - manage via chat commands         | [`cogitator.yml` config](#run-an-assistant-from-a-yaml-file)                                 |
| **Cross-framework agents**         | Expose your agent via Google's A2A protocol, consume external agents                                                            | [`examples/a2a/01-a2a-server.ts`](./examples/a2a/01-a2a-server.ts)                           |

---

---

## How It Compares

|                        | Cogitator                                                                                     | Mastra                                       | LangChain.js + LangGraph.js                     | Vercel AI SDK                      | OpenAI Agents SDK               |
| ---------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- | ---------------------------------- | ------------------------------- |
| **License**            | MIT                                                                                           | Apache-2.0, `ee/` parts need a license       | MIT                                             | Apache-2.0                         | MIT                             |
| **Core dependencies**  | 7                                                                                             | 30                                           | 7 (`@langchain/core`)                           | 3                                  | 4                               |
| **LLM providers**      | 12 built in, Ollama included                                                                  | 220 through a model router                   | 30+ provider packages                           | 45+ first-party packages           | OpenAI, others through adapters |
| **Multi-agent**        | 8 swarm strategies, agent teams, Markdown subagents, handoffs                                 | Supervisor, A2A subagents                    | Supervisor and swarm packages, handoffs         | Subagents as tools, recipes        | Handoffs, agents as tools       |
| **Durable workflows**  | DAG with Redis or Postgres checkpoints, approvals, sagas                                      | Graph workflows, snapshots, Inngest/Temporal | Graphs with checkpointers, human-in-the-loop    | `WorkflowAgent` on Workflow DevKit | Resumable run state, no graphs  |
| **Memory and RAG**     | 6 backends, hybrid search, knowledge graphs, RAG pipeline                                     | About 20 stores, semantic recall, RAG        | Checkpoint memory, long-term store, 40+ loaders | Embeddings, no memory store        | Sessions, hosted file search    |
| **MCP / A2A**          | Client and server / both ways                                                                 | Client and server / both ways                | Client / in hosted Agent Server                 | Client / community provider        | Client / no                     |
| **Code sandbox**       | Docker, WASM and native, built in                                                             | Local OS isolation, Docker via integrations  | Hosted sandboxes only                           | In-memory bash, hosted             | Docker, hosted                  |
| **Local debugger**     | Cogitator Studio, no account                                                                  | Mastra Studio                                | Studio, needs a LangSmith key                   | DevTools viewer                    | No, traces go to OpenAI         |
| **Evals**              | Built in                                                                                      | Built in                                     | `openevals`, the rest in LangSmith              | No                                 | Hosted on the OpenAI platform   |
| **Messaging channels** | Telegram, Discord, Slack, WhatsApp, WebChat, Bluesky, Threads, GitHub, email, Microsoft Teams | 8 through Vercel Chat SDK                    | No                                              | Separate Chat SDK                  | No                              |

Checked against each project's docs and npm on 2026-10-22. Something out of date? [Open an issue](https://github.com/cogitator-ai/Cogitator-AI/issues).

Every project here is good at something. Reach for LangChain for the widest integration catalog, the AI SDK for streaming UIs, the OpenAI Agents SDK for OpenAI's realtime voice, and Mastra for the broadest provider coverage and an optional hosted platform. Cogitator is for teams that want the whole stack in one self-hosted, MIT-licensed runtime with a small core, with swarm strategies, sandboxes and a debugger included.

---

## Packages

Install only what you need. Everything is a separate npm package.

| Package                                                                                      | What it does                                                                                                                         | Example                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [`@cogitator-ai/core`](https://www.npmjs.com/package/@cogitator-ai/core)                     | Agents, tools, LLM backends, streaming, everything you need to start                                                                 | [26 core examples](./examples/core/)                                 |
| [`@cogitator-ai/memory`](https://www.npmjs.com/package/@cogitator-ai/memory)                 | Your agents remember things. Redis, Postgres, SQLite, MongoDB, Qdrant, in-memory                                                     | [7 memory examples](./examples/memory/)                              |
| [`@cogitator-ai/models`](https://www.npmjs.com/package/@cogitator-ai/models)                 | Dynamic model registry with pricing, capabilities, provider metadata                                                                 | [model registry example](./examples/core/13-model-registry.ts)       |
| [`@cogitator-ai/swarms`](https://www.npmjs.com/package/@cogitator-ai/swarms)                 | 8 swarm strategies - hierarchy, round-robin, consensus, pipeline, debate, auction, negotiation, team                                 | [5 swarm examples](./examples/swarms/)                               |
| [`@cogitator-ai/workflows`](https://www.npmjs.com/package/@cogitator-ai/workflows)           | DAG workflows with branching, human approval gates, map-reduce                                                                       | [3 workflow examples](./examples/workflows/)                         |
| [`@cogitator-ai/a2a`](https://www.npmjs.com/package/@cogitator-ai/a2a)                       | Google's Agent-to-Agent protocol - expose agents as services, consume external ones                                                  | [2 a2a examples](./examples/a2a/)                                    |
| [`@cogitator-ai/mcp`](https://www.npmjs.com/package/@cogitator-ai/mcp)                       | Connect to any MCP server and use its tools                                                                                          | [4 mcp examples](./examples/mcp/)                                    |
| [`@cogitator-ai/sandbox`](https://www.npmjs.com/package/@cogitator-ai/sandbox)               | Run untrusted code in Docker or WASM, agent workspaces in Docker, E2B, Daytona or Vercel Sandbox                                     | [sandbox example](./examples/infrastructure/05-sandbox-execution.ts) |
| [`@cogitator-ai/wasm-tools`](https://www.npmjs.com/package/@cogitator-ai/wasm-tools)         | 18 pre-built tools running in WASM sandbox (calc, json, hash, csv, markdown...)                                                      | [wasm example](./examples/advanced/03-wasm-tools.ts)                 |
| [`@cogitator-ai/self-modifying`](https://www.npmjs.com/package/@cogitator-ai/self-modifying) | Agents that generate new tools at runtime and evolve their own architecture                                                          | [self-modifying example](./examples/advanced/01-self-modifying.ts)   |
| [`@cogitator-ai/neuro-symbolic`](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) | Prolog-style logic, constraint solving, knowledge graphs for agents                                                                  | [neuro-symbolic example](./examples/advanced/02-neuro-symbolic.ts)   |
| [`@cogitator-ai/rag`](https://www.npmjs.com/package/@cogitator-ai/rag)                       | RAG pipeline - document loaders, chunking, retrieval, reranking                                                                      | [3 rag examples](./examples/rag/)                                    |
| [`@cogitator-ai/evals`](https://www.npmjs.com/package/@cogitator-ai/evals)                   | Evaluation framework - metrics, LLM judges, A/B testing, assertions, agent tool calls, retrieval and experiment tracking             | [5 eval examples](./examples/evals/)                                 |
| [`@cogitator-ai/voice`](https://www.npmjs.com/package/@cogitator-ai/voice)                   | Voice/Realtime agent capabilities - STT, TTS, VAD, replies spoken while generated, realtime sessions, Twilio phone calls             | [5 voice examples](./examples/voice/)                                |
| [`@cogitator-ai/browser`](https://www.npmjs.com/package/@cogitator-ai/browser)               | Browser automation - Playwright, stealth, vision, network control                                                                    | [4 browser examples](./examples/browser/)                            |
| [`@cogitator-ai/deploy`](https://www.npmjs.com/package/@cogitator-ai/deploy)                 | Deploy your agents to Docker or Fly.io                                                                                               | [deploy example](./examples/infrastructure/04-deploy-docker.ts)      |
| [`@cogitator-ai/channels`](https://www.npmjs.com/package/@cogitator-ai/channels)             | Personal AI assistant on Telegram, Discord, Slack, WhatsApp, Bluesky, Threads, GitHub, email, Microsoft Teams, posts to social feeds | [8 channel examples](./examples/channels/)                           |
| [`@cogitator-ai/cli`](https://www.npmjs.com/package/@cogitator-ai/cli)                       | `cogitator init` / `add` / `dev` / `mcp` / `doctor` / `eval` / `up` / `deploy` from your terminal                                    | [CLI workflows](./examples/cli/README.md)                            |
| [`@cogitator-ai/studio`](https://www.npmjs.com/package/@cogitator-ai/studio)                 | Cogitator Studio: chat with agents, traces and costs, approvals, workflow reruns, forks                                              | [studio guide](https://cogitator.app/docs/getting-started/studio)    |
| [`@cogitator-ai/test-utils`](https://www.npmjs.com/package/@cogitator-ai/test-utils)         | Mock LLM backends, fixtures, helpers and a conformance kit for LLM backends                                                          | [testing docs](https://cogitator.app/docs/testing/test-utils)        |

**Server adapters** - mount agents as REST APIs with one line:

[`express`](https://www.npmjs.com/package/@cogitator-ai/express) ·
[`fastify`](https://www.npmjs.com/package/@cogitator-ai/fastify) ·
[`hono`](https://www.npmjs.com/package/@cogitator-ai/hono) ·
[`koa`](https://www.npmjs.com/package/@cogitator-ai/koa) ·
[`tetsu`](https://www.npmjs.com/package/@cogitator-ai/tetsu) ·
[`next`](https://www.npmjs.com/package/@cogitator-ai/next) ·
[`ai-sdk`](https://www.npmjs.com/package/@cogitator-ai/ai-sdk) ·
[`openai-compat`](https://www.npmjs.com/package/@cogitator-ai/openai-compat)

Every adapter comes with Swagger docs, SSE streaming and WebSockets, and shares one protocol from [`server-shared`](https://www.npmjs.com/package/@cogitator-ai/server-shared): the same request validation, response shape and stream events, held to one conformance suite. Clients cannot set system-prompt `context` or add `system` thread messages unless the server allows it (`acceptContext`, `threadMessageRoles`), and non-JSON bodies are refused with `415`. See the [integration examples](./examples/integrations/).

---

## Run an Assistant from a YAML File

Run an assistant around the clock on Telegram, Discord, Slack or WhatsApp from one `cogitator.yml`, then move to the TypeScript API when you outgrow it.

```bash
cogitator wizard
```

The interactive wizard walks you through everything: LLM provider, model, channels, capabilities, memory, MCP servers. It generates a `cogitator.yml`:

```yaml
name: Jarvis
personality: 'You are Jarvis, a sharp personal assistant.'
llm:
  provider: google
  model: gemini-3.8-flash
channels:
  telegram:
    ownerIds: ['YOUR_TG_ID']
capabilities:
  webSearch: true
  fileSystem:
    paths: [~/Documents, ~/Projects]
  scheduler: true
  browser: true
memory:
  adapter: sqlite
  path: ~/.cogitator/memory.db
  compaction:
    threshold: 50
stream:
  flushInterval: 600
  minChunkSize: 30
```

The wizard asks your name, picks channels, configures capabilities, and writes everything to `cogitator.yml` + `.env`. Then start it:

```bash
cogitator up                    # foreground with live dashboard
cogitator daemon start          # background process (logs in .cogitator/)
cogitator daemon install        # user service with restart on crash (systemd/launchd)
```

> You can also use `cogitator init` to scaffold a full project with `package.json`, TypeScript config, and source files if you prefer the programmatic API over YAML.

**Manage it from the chat**, no web dashboard needed:

| Command              | What it does                            |
| -------------------- | --------------------------------------- |
| `/status`            | Uptime, model, sessions, messages today |
| `/sessions`          | Recent conversations                    |
| `/model gpt-6.1-sol` | Switch model on the fly (or per user)   |
| `/pair ABC123`       | Approve a new user                      |
| `/users`             | Owners and approved users               |
| `/compact`           | Compress conversation history           |
| `/restart`           | Restart the assistant                   |
| `/help`              | All available commands                  |

**What you get out of the box:**

- **Multi-channel**: same assistant on Telegram + Discord + Slack + WhatsApp simultaneously
- **Streaming**: real-time typing with chunked message editing
- **Voice messages**: automatic STT via Deepgram, Groq, OpenAI, or local Whisper
- **Image understanding**: photos sent to the bot are analyzed via vision
- **Access control**: owner/authorized/public levels, pairing codes for new users
- **Scheduled tasks**: "remind me in 2 hours" with cron/interval/one-shot support
- **Memory**: persistent conversations with auto-compaction and knowledge graphs
- **Lifecycle hooks**: 12 event points for logging, analytics, custom behavior
- **Skills**: extend with tool bundles (`cogitator skill add`)
- **MCP servers**: connect any Model Context Protocol tool server

See [`@cogitator-ai/channels` README](./packages/channels/README.md) for the full programmatic API and [`@cogitator-ai/cli`](./packages/cli/) for all CLI commands.

---

## Features at a Glance

Click a category to expand it.

<details>
<summary><strong>LLM & Models</strong></summary>

| Feature                | What it means                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Any provider**       | OpenAI, Anthropic, Google, Ollama, vLLM, Azure, Bedrock, Mistral, Groq, Together, DeepSeek, OpenRouter |
| **Structured outputs** | JSON mode and JSON Schema validation across all providers                                              |
| **Vision & audio**     | Send images, transcribe audio, generate speech                                                         |
| **Cost-aware routing** | Auto-pick cheap models for easy tasks, expensive for hard ones                                         |
| **Cost prediction**    | Know how much a run will cost before you execute it                                                    |
| **Fallback models**    | When a provider fails, the turn moves to the next model behind a circuit breaker, the run goes on      |
| **Typed tool deps**    | Hand tools a DB client or the signed-in user per run, type-checked and never shown to the model        |

</details>

<details>
<summary><strong>Memory & Knowledge</strong></summary>

| Feature                 | What it means                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **6 storage backends**  | Redis, Postgres, SQLite, MongoDB, Qdrant, in-memory                                                              |
| **Semantic search**     | BM25 + vector hybrid search with Reciprocal Rank Fusion                                                          |
| **Knowledge graphs**    | Extract entities, build graphs, traverse multi-hop relationships                                                 |
| **Memory items**        | Facts extracted after each run, tied to the quote they came from and to when they held                           |
| **Memory files**        | Notes an agent keeps under `/memories` with the memory tool, native on Claude, every edit a version              |
| **Memory search tools** | The agent searches old turns and memory items itself and cites only what it opened                               |
| **Pre-turn brief**      | A cheap model reads what memory found and hands the turn a few cards, each quoting its source                    |
| **Consolidation**       | Between runs memory marks repeats stale, folds lessons into a playbook and writes observations of entities       |
| **Forget and redact**   | Delete or redact a turn, a thread or a user, and every summary, item, fact and file that stands on them goes too |
| **RAG pipeline**        | Document loaders, smart chunking, hybrid retrieval, reranking                                                    |
| **Context management**  | Auto-compress long conversations to fit model limits                                                             |

</details>

<details>
<summary><strong>Multi-Agent</strong></summary>

| Feature                | What it means                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------- |
| **8 swarm strategies** | Hierarchical, consensus, round-robin, auction, pipeline, debate, negotiation, team |
| **DAG workflows**      | Build pipelines with branching, retries, compensation, human approval              |
| **A2A Protocol**       | Google's standard for agents talking to agents across frameworks                   |
| **Agent-as-Tool**      | Use one agent as a tool for another - simple delegation                            |

</details>

<details>
<summary><strong>Messaging Channels</strong></summary>

| Feature               | What it means                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **10 platforms**      | Telegram, Discord, Slack, WhatsApp, WebChat, Bluesky, Threads, GitHub, email, Microsoft Teams: one agent everywhere |
| **YAML config + CLI** | `cogitator.yml` + `cogitator up` - personal assistant without writing code                                          |
| **Gateway routing**   | Sessions, streaming, middleware, media processing through one unified entry point                                   |
| **Owner commands**    | Manage your assistant from chat - `/status`, `/model`, `/pair`, `/compact`                                          |
| **Access control**    | DM policy with 4 modes (open, allowlist, pairing, disabled) + authorization levels                                  |
| **Media processing**  | Photos → vision, voice → STT (Deepgram, Groq, OpenAI, local Whisper)                                                |
| **Streaming**         | Real-time message editing with smart chunking and platform-aware splitting                                          |
| **Status reactions**  | Emoji progress indicators (queued → thinking → tool → done) on user messages                                        |
| **Lifecycle hooks**   | 12 event points for logging, analytics, and custom behavior                                                         |
| **Scheduler**         | Cron, interval, and one-shot jobs with error tracking and auto-backoff                                              |
| **Daemon mode**       | Run as system service with `cogitator daemon install` (systemd/launchd)                                             |

</details>

<details>
<summary><strong>Safety & Security</strong></summary>

| Feature                        | What it means                                                   |
| ------------------------------ | --------------------------------------------------------------- |
| **Constitutional AI**          | Auto-filter harmful inputs/outputs with critique-revision loops |
| **Prompt injection detection** | Catch jailbreaks, DAN attacks, encoding tricks                  |
| **PII masking**                | Emails, cards, keys and the like never reach the model provider |
| **Sandboxed execution**        | Docker and WASM isolation for untrusted code                    |
| **Workspaces**                 | Files and commands confined to one directory, local or Docker   |
| **Tool guards**                | Block dangerous commands, validate paths, require approval      |
| **Run middleware**             | Hooks around every model and tool call, tripwires stop a run    |

</details>

<details>
<summary><strong>Advanced</strong></summary>

| Feature                   | What it means                                                        |
| ------------------------- | -------------------------------------------------------------------- |
| **Self-modifying agents** | Agents detect missing capabilities and generate new tools at runtime |
| **Tree of Thoughts**      | Explore multiple reasoning paths with backtracking                   |
| **Causal reasoning**      | Pearl's Ladder - association, intervention, counterfactuals          |
| **Self-reflection**       | Agents learn from their actions and improve over time                |
| **Agent optimizer**       | DSPy-style instruction tuning from execution traces                  |
| **Time-travel debugging** | Checkpoint, replay, fork agent executions like `git bisect`          |
| **Neuro-symbolic**        | Prolog engine, Z3/SAT solving, graph queries, verified plans         |

</details>

<details>
<summary><strong>Developer Experience</strong></summary>

| Feature                  | What it means                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------- |
| **OpenTelemetry**        | Full tracing to Jaeger, Grafana, Datadog                                               |
| **Langfuse**             | LLM-native tracing of runs, generations and tools                                      |
| **Prompt versions**      | Deploy, roll back and A/B test agent instructions                                      |
| **Tool caching**         | Cache tool results (exact or semantic matching)                                        |
| **Agent serialization**  | Save agents to JSON, restore later                                                     |
| **Debug mode**           | Full request/response logging for LLM calls                                            |
| **Evals framework**      | Metrics, LLM judges, A/B testing, assertions                                           |
| **Plugin system**        | Register custom LLM backends                                                           |
| **Cogitator Studio**     | Local debugger: chat, traces with costs, approvals, workflow reruns, time-travel forks |
| **cogitator add**        | Add RAG, MCP, workflows, evals, memory or deploy to a project, merging your edits      |
| **Agent-ready projects** | AGENTS.md, bundled docs and an MCP server for Claude Code, Cursor and Codex            |

</details>

---

## 103 Runnable Examples

Every major feature has a working example you can run right now.

```bash
npx tsx examples/core/01-basic-agent.ts
```

<details>
<summary><strong>All example folders</strong></summary>

| Category                                                    | Count | What you'll learn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`core/`](./examples/core/)                                 | 30    | Agents, tools, streaming, caching, tree-of-thought, reflection, optimization, time-travel, cost routing, constitutional AI, prompt injection, causal reasoning, approvals, handoffs, decision models, provider errors and pricing, the tool contract, fallback models, tool deps, run middleware, workspaces, SKILL.md skills with todos and tool search, steering runs, tool interrupts and double-texting, tool execution, permissions and budgets, hooks and project instructions, subagents and commands, harness agents, durable runs |
| [`memory/`](./examples/memory/)                             | 7     | In-memory storage, context building, semantic search, knowledge graphs, memory files and memory search tools, memory between runs, forgetting and redacting                                                                                                                                                                                                                                                                                                                                                                                |
| [`swarms/`](./examples/swarms/)                             | 5     | Debate, pipeline, hierarchical coordination, negotiation, agent teams                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [`workflows/`](./examples/workflows/)                       | 3     | DAG workflows, human-in-the-loop, map-reduce                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`a2a/`](./examples/a2a/)                                   | 2     | A2A server and client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [`mcp/`](./examples/mcp/)                                   | 4     | MCP client and server integration, per-user tokens, agents as MCP servers                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [`rag/`](./examples/rag/)                                   | 3     | Basic retrieval, chunking strategies, agent with RAG                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [`evals/`](./examples/evals/)                               | 5     | Basic evaluation, LLM judge, A/B comparison, agent eval with tool calls, turns and pass@k, experiment tracking with run files and reports                                                                                                                                                                                                                                                                                                                                                                                                  |
| [`voice/`](./examples/voice/)                               | 5     | Voice pipeline, realtime sessions, voice agents, a phone agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`browser/`](./examples/browser/)                           | 4     | Web scraping, form automation, stealth agents, crypto price scraper                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [`integrations/`](./examples/integrations/)                 | 10    | Express, Fastify, Hono, Koa, Next.js, OpenAI compat, AI SDK, Tetsu on Bun, Deno, Cloudflare Workers                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [`infrastructure/`](./examples/infrastructure/)             | 7     | Redis, PostgreSQL, job queues, Docker deploy, sandbox execution, workspaces in E2B, Daytona and Vercel sandboxes                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`channels/`](./examples/channels/)                         | 8     | Telegram assistant, multi-channel super-assistant, WebChat bot, social feed publisher, Bluesky and Threads bot, GitHub issue and review bot, email bot that answers in the thread, Microsoft Teams bot                                                                                                                                                                                                                                                                                                                                     |
| [`device-tools/`](./examples/device-tools/)                 | 6     | Local screenshots, clipboard, notifications, URL opening, shell execution, device skill setup                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`create-cogitator-app/`](./examples/create-cogitator-app/) | 1     | Programmatic project scaffolding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`config/`](./examples/config/)                             | 1     | YAML configuration, environment variable overrides, runtime initialization                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [`advanced/`](./examples/advanced/)                         | 3     | Self-modifying agents, neuro-symbolic reasoning, WASM tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

</details>

The [`cli/`](./examples/cli/README.md) folder adds step-by-step `cogitator` CLI walkthroughs on top of these.

The examples run on **Google Gemini 3.5 Flash-Lite** (`google/gemini-3.5-flash-lite`), free tier, no credit card. They make many calls in a row, and Flash-Lite is cheaper and answers more reliably under load than Gemini 3.8 Flash. See [`examples/README.md`](./examples/README.md) for setup.

---

## Contributing

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/Cogitator-AI.git
cd Cogitator-AI && pnpm install && pnpm dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Contributors

Thanks to everyone who has contributed to Cogitator!

<a href="https://github.com/cogitator-ai/Cogitator-AI/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=cogitator-ai/Cogitator-AI" alt="Contributors" />
</a>

Want to join them? Pick an issue labeled [good first issue or help wanted](https://github.com/cogitator-ai/Cogitator-AI/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22%2C%22help%20wanted%22).

---

<details>
<summary><strong>All npm packages</strong></summary>

| Package                                                                                    | Description                                                                                    | Version                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [@cogitator-ai/core](https://www.npmjs.com/package/@cogitator-ai/core)                     | Core runtime (Agent, Tool, Cogitator)                                                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/core.svg)](https://www.npmjs.com/package/@cogitator-ai/core)                     |
| [create-cogitator-app](https://www.npmjs.com/package/create-cogitator-app)                 | Interactive project scaffolding (`npx create-cogitator-app`)                                   | [![npm](https://img.shields.io/npm/v/create-cogitator-app.svg)](https://www.npmjs.com/package/create-cogitator-app)                 |
| [@cogitator-ai/cli](https://www.npmjs.com/package/@cogitator-ai/cli)                       | CLI tool (`cogitator init/add/dev/mcp/doctor/eval/up/deploy`)                                  | [![npm](https://img.shields.io/npm/v/@cogitator-ai/cli.svg)](https://www.npmjs.com/package/@cogitator-ai/cli)                       |
| [@cogitator-ai/studio](https://www.npmjs.com/package/@cogitator-ai/studio)                 | Cogitator Studio, the local debugger (`cogitator dev`)                                         | [![npm](https://img.shields.io/npm/v/@cogitator-ai/studio.svg)](https://www.npmjs.com/package/@cogitator-ai/studio)                 |
| [@cogitator-ai/types](https://www.npmjs.com/package/@cogitator-ai/types)                   | Shared TypeScript interfaces                                                                   | [![npm](https://img.shields.io/npm/v/@cogitator-ai/types.svg)](https://www.npmjs.com/package/@cogitator-ai/types)                   |
| [@cogitator-ai/config](https://www.npmjs.com/package/@cogitator-ai/config)                 | Configuration management                                                                       | [![npm](https://img.shields.io/npm/v/@cogitator-ai/config.svg)](https://www.npmjs.com/package/@cogitator-ai/config)                 |
| [@cogitator-ai/memory](https://www.npmjs.com/package/@cogitator-ai/memory)                 | Memory adapters (Postgres, Redis, SQLite, MongoDB, Qdrant)                                     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/memory.svg)](https://www.npmjs.com/package/@cogitator-ai/memory)                 |
| [@cogitator-ai/models](https://www.npmjs.com/package/@cogitator-ai/models)                 | Dynamic model registry with pricing                                                            | [![npm](https://img.shields.io/npm/v/@cogitator-ai/models.svg)](https://www.npmjs.com/package/@cogitator-ai/models)                 |
| [@cogitator-ai/workflows](https://www.npmjs.com/package/@cogitator-ai/workflows)           | DAG-based workflow engine                                                                      | [![npm](https://img.shields.io/npm/v/@cogitator-ai/workflows.svg)](https://www.npmjs.com/package/@cogitator-ai/workflows)           |
| [@cogitator-ai/swarms](https://www.npmjs.com/package/@cogitator-ai/swarms)                 | Multi-agent swarm coordination                                                                 | [![npm](https://img.shields.io/npm/v/@cogitator-ai/swarms.svg)](https://www.npmjs.com/package/@cogitator-ai/swarms)                 |
| [@cogitator-ai/mcp](https://www.npmjs.com/package/@cogitator-ai/mcp)                       | MCP (Model Context Protocol) support                                                           | [![npm](https://img.shields.io/npm/v/@cogitator-ai/mcp.svg)](https://www.npmjs.com/package/@cogitator-ai/mcp)                       |
| [@cogitator-ai/a2a](https://www.npmjs.com/package/@cogitator-ai/a2a)                       | A2A Protocol v0.3 - cross-agent interoperability                                               | [![npm](https://img.shields.io/npm/v/@cogitator-ai/a2a.svg)](https://www.npmjs.com/package/@cogitator-ai/a2a)                       |
| [@cogitator-ai/sandbox](https://www.npmjs.com/package/@cogitator-ai/sandbox)               | Docker/WASM sandboxed execution                                                                | [![npm](https://img.shields.io/npm/v/@cogitator-ai/sandbox.svg)](https://www.npmjs.com/package/@cogitator-ai/sandbox)               |
| [@cogitator-ai/redis](https://www.npmjs.com/package/@cogitator-ai/redis)                   | Redis client (standalone + cluster)                                                            | [![npm](https://img.shields.io/npm/v/@cogitator-ai/redis.svg)](https://www.npmjs.com/package/@cogitator-ai/redis)                   |
| [@cogitator-ai/worker](https://www.npmjs.com/package/@cogitator-ai/worker)                 | Distributed job queue (BullMQ)                                                                 | [![npm](https://img.shields.io/npm/v/@cogitator-ai/worker.svg)](https://www.npmjs.com/package/@cogitator-ai/worker)                 |
| [@cogitator-ai/openai-compat](https://www.npmjs.com/package/@cogitator-ai/openai-compat)   | OpenAI-compatible server: Chat Completions, Responses                                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/openai-compat.svg)](https://www.npmjs.com/package/@cogitator-ai/openai-compat)   |
| [@cogitator-ai/wasm-tools](https://www.npmjs.com/package/@cogitator-ai/wasm-tools)         | WASM-based sandboxed tools (18 built-in)                                                       | [![npm](https://img.shields.io/npm/v/@cogitator-ai/wasm-tools.svg)](https://www.npmjs.com/package/@cogitator-ai/wasm-tools)         |
| [@cogitator-ai/self-modifying](https://www.npmjs.com/package/@cogitator-ai/self-modifying) | Self-modifying agents with meta-reasoning                                                      | [![npm](https://img.shields.io/npm/v/@cogitator-ai/self-modifying.svg)](https://www.npmjs.com/package/@cogitator-ai/self-modifying) |
| [@cogitator-ai/neuro-symbolic](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) | Neuro-symbolic reasoning with SAT/SMT                                                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/neuro-symbolic.svg)](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) |
| [@cogitator-ai/rag](https://www.npmjs.com/package/@cogitator-ai/rag)                       | RAG pipeline with loaders, chunking, retrieval, reranking                                      | [![npm](https://img.shields.io/npm/v/@cogitator-ai/rag.svg)](https://www.npmjs.com/package/@cogitator-ai/rag)                       |
| [@cogitator-ai/evals](https://www.npmjs.com/package/@cogitator-ai/evals)                   | Evaluation framework with metrics, A/B testing, assertions                                     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/evals.svg)](https://www.npmjs.com/package/@cogitator-ai/evals)                   |
| [@cogitator-ai/voice](https://www.npmjs.com/package/@cogitator-ai/voice)                   | Voice/Realtime agents (STT, TTS, VAD, realtime sessions)                                       | [![npm](https://img.shields.io/npm/v/@cogitator-ai/voice.svg)](https://www.npmjs.com/package/@cogitator-ai/voice)                   |
| [@cogitator-ai/browser](https://www.npmjs.com/package/@cogitator-ai/browser)               | Browser automation (Playwright, stealth, vision, 33 tools)                                     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/browser.svg)](https://www.npmjs.com/package/@cogitator-ai/browser)               |
| [@cogitator-ai/next](https://www.npmjs.com/package/@cogitator-ai/next)                     | Next.js App Router integration                                                                 | [![npm](https://img.shields.io/npm/v/@cogitator-ai/next.svg)](https://www.npmjs.com/package/@cogitator-ai/next)                     |
| [@cogitator-ai/ai-sdk](https://www.npmjs.com/package/@cogitator-ai/ai-sdk)                 | Vercel AI SDK adapter (bidirectional)                                                          | [![npm](https://img.shields.io/npm/v/@cogitator-ai/ai-sdk.svg)](https://www.npmjs.com/package/@cogitator-ai/ai-sdk)                 |
| [@cogitator-ai/express](https://www.npmjs.com/package/@cogitator-ai/express)               | Express.js REST API server                                                                     | [![npm](https://img.shields.io/npm/v/@cogitator-ai/express.svg)](https://www.npmjs.com/package/@cogitator-ai/express)               |
| [@cogitator-ai/fastify](https://www.npmjs.com/package/@cogitator-ai/fastify)               | Fastify REST API server                                                                        | [![npm](https://img.shields.io/npm/v/@cogitator-ai/fastify.svg)](https://www.npmjs.com/package/@cogitator-ai/fastify)               |
| [@cogitator-ai/hono](https://www.npmjs.com/package/@cogitator-ai/hono)                     | Hono multi-runtime server (Edge, Bun, Deno, Node.js)                                           | [![npm](https://img.shields.io/npm/v/@cogitator-ai/hono.svg)](https://www.npmjs.com/package/@cogitator-ai/hono)                     |
| [@cogitator-ai/koa](https://www.npmjs.com/package/@cogitator-ai/koa)                       | Koa middleware-based server                                                                    | [![npm](https://img.shields.io/npm/v/@cogitator-ai/koa.svg)](https://www.npmjs.com/package/@cogitator-ai/koa)                       |
| [@cogitator-ai/tetsu](https://www.npmjs.com/package/@cogitator-ai/tetsu)                   | Tetsu controller on Bun (SSE, WebSocket, OpenAPI)                                              | [![npm](https://img.shields.io/npm/v/@cogitator-ai/tetsu.svg)](https://www.npmjs.com/package/@cogitator-ai/tetsu)                   |
| [@cogitator-ai/deploy](https://www.npmjs.com/package/@cogitator-ai/deploy)                 | Deployment engine (Docker, Fly.io)                                                             | [![npm](https://img.shields.io/npm/v/@cogitator-ai/deploy.svg)](https://www.npmjs.com/package/@cogitator-ai/deploy)                 |
| [@cogitator-ai/channels](https://www.npmjs.com/package/@cogitator-ai/channels)             | Messaging channels (GitHub, email and Microsoft Teams too) and social feeds (Bluesky, Threads) | [![npm](https://img.shields.io/npm/v/@cogitator-ai/channels.svg)](https://www.npmjs.com/package/@cogitator-ai/channels)             |
| [@cogitator-ai/server-shared](https://www.npmjs.com/package/@cogitator-ai/server-shared)   | Shared protocol, validation, conformance for server adapters                                   | [![npm](https://img.shields.io/npm/v/@cogitator-ai/server-shared.svg)](https://www.npmjs.com/package/@cogitator-ai/server-shared)   |
| [@cogitator-ai/test-utils](https://www.npmjs.com/package/@cogitator-ai/test-utils)         | Testing utilities: mocks, fixtures, backend conformance kit                                    | [![npm](https://img.shields.io/npm/v/@cogitator-ai/test-utils.svg)](https://www.npmjs.com/package/@cogitator-ai/test-utils)         |

Not published to npm: [`packages/dashboard`](./packages/dashboard) (the [cogitator.app](https://cogitator.app) website: landing, docs, cookbook), [`packages/e2e`](./packages/e2e) (end-to-end test suite) and [`packages/gauntlet`](./packages/gauntlet) (integration proving ground that runs every package together on real models).

</details>

---

## Security

Found a vulnerability? **Please don't open a public issue**, report it privately so it can be fixed before it is disclosed.

<a href="https://github.com/cogitator-ai/Cogitator-AI/security/advisories/new"><img alt="Report a vulnerability" src="https://img.shields.io/badge/Report_a_vulnerability-privately-c9a45c?style=for-the-badge&logo=github&logoColor=white&labelColor=07080a"></a>

See [SECURITY.md](./.github/SECURITY.md) for what to include and how reports are handled.

---

## License

MIT - see [LICENSE](./LICENSE).

---

<div align="center">

**Built for engineers who trust their agents to run while they sleep.**

[Star on GitHub](https://github.com/cogitator-ai/Cogitator-AI) · [Docs](https://cogitator.app/docs) · [Discussions](https://github.com/cogitator-ai/Cogitator-AI/discussions)

</div>
