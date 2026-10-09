# Cogitator Architecture

> Deep technical dive into the system design. The website has the overview and the step-by-step agent execution flow: [cogitator.app/docs/architecture](https://cogitator.app/docs/architecture).

Cogitator is a library-first runtime: everything runs inside your Node.js (or Bun) process, or in worker processes you start yourself. There is no hosted control plane or admin dashboard — every capability is a package you add when you need it.

## Package Ecosystem

The monorepo has 35 packages: 32 published `@cogitator-ai/*` packages, the `create-cogitator-app` scaffolder, and two private ones (the website and the end-to-end suite):

| Layer              | Package                        | Description                                                                                         |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Core**           | `@cogitator-ai/types`          | Shared TypeScript interfaces, error codes and defaults                                              |
|                    | `@cogitator-ai/core`           | Main runtime - `Cogitator`, `Agent`, `tool()`, LLM backends, built-in tools                         |
|                    | `@cogitator-ai/models`         | Dynamic model registry with pricing                                                                 |
|                    | `@cogitator-ai/config`         | `cogitator.yml` and environment loading with Zod validation                                         |
| **Memory**         | `@cogitator-ai/memory`         | Memory adapters (in-memory, Redis, Postgres, SQLite, MongoDB), Qdrant vectors                       |
| **Execution**      | `@cogitator-ai/sandbox`        | Docker, WASM and native execution                                                                   |
|                    | `@cogitator-ai/wasm-tools`     | 14 pre-built WASM tools (calc, hash, regex, CSV, XML, …)                                            |
|                    | `@cogitator-ai/worker`         | BullMQ distributed job queue for agent execution                                                    |
|                    | `@cogitator-ai/browser`        | Browser automation (Playwright, stealth, vision)                                                    |
| **Orchestration**  | `@cogitator-ai/workflows`      | DAG engine with sagas, map-reduce, human-in-the-loop, timers, scheduling                            |
|                    | `@cogitator-ai/swarms`         | 7 swarm strategies (hierarchical, round-robin, consensus, auction, pipeline, …)                     |
| **Protocols**      | `@cogitator-ai/a2a`            | Agent-to-Agent Protocol v0.3                                                                        |
|                    | `@cogitator-ai/mcp`            | Model Context Protocol client and server                                                            |
|                    | `@cogitator-ai/openai-compat`  | OpenAI Assistants API compatibility layer                                                           |
| **Integrations**   | `@cogitator-ai/ai-sdk`         | Vercel AI SDK adapter                                                                               |
|                    | `@cogitator-ai/express`        | Express.js server adapter                                                                           |
|                    | `@cogitator-ai/fastify`        | Fastify plugin                                                                                      |
|                    | `@cogitator-ai/hono`           | Hono app (Node.js, Bun, Deno, Cloudflare Workers)                                                   |
|                    | `@cogitator-ai/koa`            | Koa router                                                                                          |
|                    | `@cogitator-ai/tetsu`          | Tetsu controller on Bun (SSE, WebSocket, OpenAPI)                                                   |
|                    | `@cogitator-ai/next`           | Next.js App Router handlers                                                                         |
|                    | `@cogitator-ai/server-shared`  | Shared REST/SSE/WebSocket protocol and OpenAPI generation                                           |
|                    | `@cogitator-ai/channels`       | Messaging channels (Telegram, Discord, Slack, WhatsApp, WebChat, Bluesky, Threads) and social feeds |
| **Advanced**       | `@cogitator-ai/self-modifying` | Runtime tool generation                                                                             |
|                    | `@cogitator-ai/neuro-symbolic` | Prolog-style logic, SAT/SMT                                                                         |
|                    | `@cogitator-ai/rag`            | RAG pipeline (loaders, chunkers, retrieval, reranking)                                              |
|                    | `@cogitator-ai/evals`          | Eval framework (metrics, A/B testing, assertions)                                                   |
|                    | `@cogitator-ai/voice`          | Voice/Realtime agents (STT, TTS, VAD)                                                               |
| **Infrastructure** | `@cogitator-ai/redis`          | Redis client (standalone + cluster)                                                                 |
|                    | `@cogitator-ai/deploy`         | Docker & Fly.io deployment                                                                          |
|                    | `@cogitator-ai/cli`            | The `cogitator` command (init, up, run, deploy, …)                                                  |
| **Support**        | `@cogitator-ai/test-utils`     | Testing utilities                                                                                   |
|                    | `create-cogitator-app`         | Interactive project scaffolder                                                                      |
|                    | `@cogitator-ai/dashboard`      | Private: the website - landing page, docs (Fumadocs) and cookbook                                   |
|                    | `@cogitator-ai/e2e`            | Private: end-to-end test suite                                                                      |

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                 ENTRY POINTS                                     │
│                                                                                 │
│  TypeScript SDK  │  Server adapters (Express/Fastify/Hono/Koa/Tetsu/Next)  │ CLI │
│  Channels gateway │ OpenAI-compat server │ Vercel AI SDK │ MCP server │ A2A     │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          RUNTIME CORE (@cogitator-ai/core)                       │
│                                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │   Agent     │  │  Cogitator   │  │ CostAwareRouter│  │  ConstitutionalAI  │  │
│  │             │  │  (Runtime)   │  │                │  │  (guardrails)      │  │
│  │ • Tools     │  │ • Runs       │  │ • Model pick   │  │ • Input/output     │  │
│  │ • Prompt    │  │ • Memory     │  │ • Budgets      │  │ • Critique-revise  │  │
│  │ • Model     │  │ • Sandbox    │  │ • Cost summary │  │ • Tool guard       │  │
│  └─────────────┘  │ • Approvals  │  └────────────────┘  └────────────────────┘  │
│                   └──────────────┘                                              │
│  Prompt-injection detection · PII masking · LLM retries · tracing               │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
┌──────────────────────────────┐   ┌───────────────────────────────────────────────┐
│  DISTRIBUTED EXECUTION        │   │               MEMORY LAYER                    │
│  (@cogitator-ai/worker)       │   │           (@cogitator-ai/memory)              │
│                               │   │                                               │
│  ┌────────────┐  ┌──────────┐ │   │  MemoryAdapter:                               │
│  │  JobQueue  │  │WorkerPool│ │   │    InMemory │ Redis │ Postgres │ SQLite │     │
│  │  (BullMQ)  │  │          │ │   │    MongoDB                                    │
│  │            │  │ • agent  │ │   │  FactAdapter: Postgres                        │
│  │ addAgentJob│  │ • workflow│ │   │  EmbeddingAdapter: Postgres (pgvector),      │
│  │ addWorkflow│  │ • swarm  │ │   │    Qdrant, InMemoryEmbeddingAdapter           │
│  │ addSwarmJob│  └──────────┘ │   │                                               │
│  └────────────┘               │   │                                               │
└──────────────────────────────┘   └───────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                LLM BACKENDS                                      │
│                                                                                 │
│  Ollama │ vLLM │ OpenAI │ Anthropic │ Google │ Azure │ Bedrock │ Mistral │ Groq │
│               Together │ DeepSeek │ custom backends & plugins                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

What happens inside a single `cog.run()` — run slots, model resolution, prompt versions, input checks, the tool loop with approvals and handoffs, structured-output repair, memory saves — is laid out step by step in [Agent Execution Flow](https://cogitator.app/docs/architecture#agent-execution-flow).

---

## Component Deep Dives

### 1. HTTP Adapters

Every server adapter registers the same REST routes, request bodies and SSE streaming protocol from `@cogitator-ai/server-shared`. An adapter serves only the agents, workflows and swarms you pass to it:

```typescript
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import { cogitatorPlugin } from '@cogitator-ai/fastify';
import { cogitatorApp } from '@cogitator-ai/hono';

const cogitator = new Cogitator();
const assistant = new Agent({
  name: 'assistant',
  model: 'ollama/llama3.2',
  instructions: 'You are a helpful assistant.',
});

// Express: routes under config.basePath (default '/cogitator')
const app = express();
await new CogitatorServer({
  app,
  cogitator,
  agents: { assistant },
  config: { basePath: '/api' },
}).init();

// Fastify: routes under prefix (default '/cogitator')
const fastify = Fastify();
await fastify.register(cogitatorPlugin, { cogitator, agents: { assistant }, prefix: '/api' });

// Hono: routes where you mount the app
const hono = new Hono();
hono.route('/api', cogitatorApp({ cogitator, agents: { assistant } }));
```

Koa (`cogitatorApp` returning a `@koa/router`), Tetsu (`cogitatorController`) and Next.js (`createChatHandler`, `createAgentHandler`, `createResumeHandler`) follow the same pattern. Routes, error format, WebSocket support per adapter and authentication: [Server Adapters](https://cogitator.app/docs/server-adapters).

For OpenAI-compatible endpoints, `@cogitator-ai/openai-compat` runs its own Fastify server (default port 8080) that implements the Assistants API, so the official `openai` SDK works as a client:

```typescript
import OpenAI from 'openai';
import { Cogitator } from '@cogitator-ai/core';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';

const server = createOpenAIServer(new Cogitator(), {
  port: 8080,
  apiKeys: ['sk-my-secret-key'], // empty or omitted: no auth
});
await server.start();

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'sk-my-secret-key',
});

const assistant = await client.beta.assistants.create({
  model: 'ollama/llama3.2', // any Cogitator model string
  instructions: 'You are a helpful assistant.',
});

const thread = await client.beta.threads.create();
await client.beta.threads.messages.create(thread.id, {
  role: 'user',
  content: 'Hello!',
});

const run = await client.beta.threads.runs.createAndPoll(thread.id, {
  assistant_id: assistant.id,
});
```

See [OpenAI Compatibility](https://cogitator.app/docs/integrations/openai-compat).

---

### 2. Distributed Job Queue

The `@cogitator-ai/worker` package provides BullMQ-based job processing for distributing agent, workflow and swarm execution across worker processes.

#### Architecture

```typescript
import { JobQueue, WorkerPool, type SerializedAgent } from '@cogitator-ai/worker';

// Producer side: enqueue jobs
const queue = new JobQueue({
  name: 'cogitator-jobs',
  redis: { host: 'localhost', port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

const serializedAgent: SerializedAgent = {
  name: 'analyst',
  model: 'llama3.2',
  provider: 'ollama',
  instructions: 'You analyze data.',
  tools: [webSearch.toJSON()], // tool schemas only
};

const job = await queue.addAgentJob(serializedAgent, 'Analyze this data', {
  threadId: 'thread-123',
  userId: 'user-abc',
  priority: 10,
  metadata: { source: 'api' },
});

await queue.addWorkflowJob(serializedWorkflow, { topic: 'quarterly report' });
await queue.addSwarmJob(serializedSwarm, 'Process batch');

// Consumer side: process jobs
const pool = new WorkerPool({
  name: 'cogitator-jobs',
  redis: { host: 'localhost', port: 6379 },
  cogitator, // optional; a runtime is created when left out
  tools: [webSearch], // implementations for tools referenced by serialized agents
  workerCount: 2,
  concurrency: 10,
});
await pool.start();
```

Serialized agents carry tool schemas only; a job whose agent references a tool missing from the worker's `tools` fails instead of running with a stub. `SerializedWorkflow` (agent, transform, condition and parallel nodes) and `SerializedSwarm` (`sequential`, `hierarchical`, `collaborative`, `debate`, `voting`) are the worker's own JSON formats, not `@cogitator-ai/workflows` or `@cogitator-ai/swarms` objects. Swarms can also run one agent per job with `DistributedSwarmWorker` — see [Worker Queues](https://cogitator.app/docs/deployment/worker-queues) and [Distributed Swarms](https://cogitator.app/docs/swarms/distributed).

#### Queue Metrics (for HPA)

```typescript
import { formatPrometheusMetrics } from '@cogitator-ai/worker';

const metrics = await queue.getMetrics();
// { waiting, active, completed, failed, delayed, depth, workerCount }

// Prometheus exposition format: queue gauges only
const queueText = formatPrometheusMetrics(metrics, { queue: 'cogitator-jobs' });

// Queue gauges plus the pool's job-duration histogram and per-type counts
const fullText = pool.metrics.format(metrics, { queue: 'cogitator-jobs' });
```

#### Job Lifecycle

Jobs follow BullMQ's states. A failed attempt goes back to the queue after its backoff until `attempts` is used up:

```
┌─────────┐    ┌─────────┐    ┌───────────┐
│ WAITING │───►│ ACTIVE  │───►│ COMPLETED │
└────▲────┘    └────┬────┘    └───────────┘
     │              │ error
     │              ▼
┌────┴────┐  attempts left   ┌─────────┐
│ DELAYED │◄─────────────────┤  retry? │
└─────────┘                  └────┬────┘
                                  │ attempts exhausted
                                  ▼
                             ┌─────────┐
                             │ FAILED  │
                             └─────────┘
```

---

### 3. Memory Architecture

The `@cogitator-ai/memory` package provides pluggable storage for conversation history, long-term facts and embeddings.

| Interface          | Implementations                                                                         |
| ------------------ | --------------------------------------------------------------------------------------- |
| `MemoryAdapter`    | `InMemoryAdapter`, `RedisAdapter`, `PostgresAdapter`, `SQLiteAdapter`, `MongoDBAdapter` |
| `FactAdapter`      | `PostgresAdapter`                                                                       |
| `EmbeddingAdapter` | `PostgresAdapter` (pgvector), `QdrantAdapter`, `InMemoryEmbeddingAdapter`               |

Qdrant is a vector store only — it does not store threads or messages. Note the known issue on [Memory Adapters](https://cogitator.app/docs/memory/adapters#qdrant): `QdrantAdapter.addEmbedding` uses `emb_…` ids as point ids, which a real Qdrant server rejects; use pgvector for vectors until it is fixed.

#### Runtime Memory

The `Cogitator` runtime creates its memory adapter from `memory.adapter`, and only for `'memory'`, `'redis'` and `'postgres'` (any other value logs `Unknown memory provider` and runs without memory). SQLite, MongoDB and Qdrant adapters are constructed and used directly from your own code.

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
    contextBuilder: {
      maxTokens: 8000, // default 4000
      strategy: 'hybrid', // 'recent' (default) | 'relevant' | 'hybrid'
      includeFacts: true,
      includeSemanticContext: true,
    },
  },
});

const memory = await cog.getMemory(); // the connected MemoryAdapter, or undefined
```

#### MemoryAdapter Interface

```typescript
interface MemoryAdapter {
  readonly provider: MemoryProvider; // 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant'

  // Thread management
  createThread(
    agentId: string,
    metadata?: Record<string, unknown>,
    threadId?: string
  ): Promise<MemoryResult<Thread>>;
  getThread(threadId: string): Promise<MemoryResult<Thread | null>>;
  updateThread(threadId: string, metadata: Record<string, unknown>): Promise<MemoryResult<Thread>>;
  deleteThread(threadId: string): Promise<MemoryResult<void>>;

  // Entry management
  addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;

  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}

interface MemoryEntry {
  id: string;
  threadId: string;
  message: Message;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  tokenCount: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

interface MemoryQueryOptions {
  threadId: string;
  limit?: number;
  before?: Date;
  after?: Date;
  includeToolCalls?: boolean;
}
```

Every method returns a `MemoryResult` — `{ success: true, data }` or `{ success: false, error }`. Use `unwrap(result)` from `@cogitator-ai/memory` to get the data or throw.

#### Extended Adapters

```typescript
// FactAdapter — long-term memory (Postgres)
interface FactAdapter {
  addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>>;
  getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>>;
  updateFact(
    factId: string,
    updates: Partial<Pick<Fact, 'content' | 'category' | 'confidence' | 'metadata' | 'expiresAt'>>
  ): Promise<MemoryResult<Fact>>;
  deleteFact(factId: string): Promise<MemoryResult<void>>;
  searchFacts(agentId: string, query: string): Promise<MemoryResult<Fact[]>>;
}

// EmbeddingAdapter — semantic search (pgvector / Qdrant / in-memory)
interface EmbeddingAdapter {
  addEmbedding(embedding: Omit<Embedding, 'id' | 'createdAt'>): Promise<MemoryResult<Embedding>>;
  search(options: SemanticSearchOptions): Promise<MemoryResult<(Embedding & { score: number })[]>>;
  deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>>;
  deleteBySource(sourceId: string): Promise<MemoryResult<void>>;
}
```

On top of these, the package ships `HybridSearch` (BM25 + vectors with reciprocal rank fusion), knowledge graphs, `CoreFactsStore`, `SessionManager` and `CompactionService` — see [Memory](https://cogitator.app/docs/memory), [Hybrid Search](https://cogitator.app/docs/memory/hybrid-search) and [Knowledge Graphs](https://cogitator.app/docs/memory/knowledge-graphs).

#### ContextBuilder

Builds LLM-ready context from stored entries within a token budget. The runtime creates one from `memory.contextBuilder`; you can also use it directly:

```typescript
import { ContextBuilder, PostgresAdapter, createEmbeddingService } from '@cogitator-ai/memory';

const postgres = new PostgresAdapter({
  provider: 'postgres',
  connectionString: process.env.DATABASE_URL!,
});
await postgres.connect();

const builder = new ContextBuilder(
  {
    maxTokens: 8192,
    strategy: 'hybrid', // 'recent' | 'relevant' | 'hybrid'
    includeFacts: true,
    includeSemanticContext: true,
  },
  {
    memoryAdapter: postgres,
    factAdapter: postgres, // optional
    embeddingAdapter: postgres, // optional
    embeddingService: createEmbeddingService({ provider: 'ollama' }), // optional
  }
);

const context = await builder.build({
  threadId: 'thread-123',
  agentId: 'assistant',
  userId: 'user-abc', // facts and embeddings of other users are left out
  systemPrompt: 'You are a helpful assistant.',
  currentInput: 'What did we decide about the launch?',
});
// context.messages, context.facts, context.semanticResults, context.tokenCount, context.truncated
```

---

### 4. Agent Execution Engine

#### Sandbox Types

```typescript
import { SandboxManager } from '@cogitator-ai/sandbox';

const manager = new SandboxManager({
  defaults: {
    timeout: 30_000,
    resources: { memory: '256MB', cpus: 0.5 },
  },
  pool: { maxSize: 10, idleTimeoutMs: 60_000 },
  docker: { socketPath: '/var/run/docker.sock' },
  wasm: { cacheSize: 20, memoryPages: 256 },
});

// Execute in a Docker sandbox
const result = await manager.execute(
  {
    command: ['python', 'script.py'],
    stdin: 'input data',
    timeout: 10_000,
  },
  {
    type: 'docker',
    image: 'python:3.12-slim',
    resources: { memory: '512MB' },
    network: { mode: 'none' },
  }
);

if (result.success) {
  const { stdout, stderr, exitCode, timedOut, duration } = result.data;
} else {
  console.error(result.error);
}
```

#### Three Execution Modes

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SandboxManager                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  DockerSandboxExecutor  — container isolation                       │
│  • Custom images (Python, Node, etc.; default alpine:3.19)          │
│  • Resource limits (memory, CPUs, CPU shares, PIDs)                 │
│  • Network modes (none by default / bridge / host)                  │
│  • All capabilities dropped, no-new-privileges                      │
│  • ContainerPool keeps fresh containers warm (opt-in reuse)         │
│                                                                     │
│  WasmSandboxExecutor (Extism)  — memory-safe WASM modules           │
│  • No host network unless allowedHosts; WASI off by default         │
│  • Capped memory pages, compiled-module cache                       │
│  • 14 pre-built tools in @cogitator-ai/wasm-tools                   │
│                                                                     │
│  NativeSandboxExecutor  — host child process, no isolation          │
│  • Minimal inherited environment, process-group kill on timeout     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

When Docker is unavailable, `SandboxManager` runs Docker-sandboxed commands natively on the host with a warning, unless `sandbox.allowNativeFallback: false` makes them fail instead. WASM never falls back: without Extism a WASM execution returns an error. Check `isDockerAvailable()` / `isWasmAvailable()` first, or set `allowNativeFallback: false`, when untrusted code must never run on the host. Details: [Sandbox](https://cogitator.app/docs/deployment/sandbox).

#### WASM Tools

The `@cogitator-ai/wasm-tools` package ships 14 pre-built WASM tools:

| Tool           | Function                                      |
| -------------- | --------------------------------------------- |
| `calculate`    | Safe math expression evaluator                |
| `process_json` | JSON parsing + JSONPath queries               |
| `hash_text`    | SHA-256 / SHA-1 / MD5 hashing                 |
| `base64`       | Base64 encode/decode (standard + URL-safe)    |
| `slug`         | URL-safe slug generation with transliteration |
| `validate`     | Email / URL / UUID / IPv4 / IPv6 validation   |
| `diff`         | Text diff with Myers algorithm                |
| `regex`        | Regex operations with ReDoS protection        |
| `csv`          | RFC 4180 compliant CSV parser/generator       |
| `markdown`     | Markdown → HTML (GFM subset)                  |
| `xml`          | XML parse + XPath-like query                  |
| `datetime`     | Date parse / format / arithmetic / diff       |
| `compression`  | gzip compress/decompress                      |
| `signing`      | Ed25519 keypair generation, sign, verify      |

```typescript
import { z } from 'zod';
import { createCalcTool, createHashTool, defineWasmTool } from '@cogitator-ai/wasm-tools';

const calc = createCalcTool();
const hash = createHashTool();

// Custom WASM tool
const resize = defineWasmTool({
  name: 'image_resize',
  description: 'Resize images in WASM sandbox',
  wasmModule: './resize.wasm',
  wasmFunction: 'resize',
  parameters: z.object({
    imageData: z.string(),
    width: z.number(),
    height: z.number(),
  }),
});
```

See [WASM Tools](https://cogitator.app/docs/tools/wasm-tools).

---

### 5. LLM Backend Abstraction

Unified interface for all LLM providers, defined in `@cogitator-ai/types`:

```typescript
interface LLMBackend {
  readonly provider: LLMProvider;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;
  complete?(request: Omit<ChatRequest, 'model'> & { model?: string }): Promise<ChatResponse>;
}

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  stream?: boolean;
  responseFormat?: LLMResponseFormat;
  reasoning?: ReasoningConfig;
  cache?: PromptCacheConfig | false;
  signal?: AbortSignal;
}

interface ChatResponse {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: ChatUsage;
  reasoning?: string; // readable reasoning summary, when the provider returns one
}

interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number; // already counted in inputTokens
  cacheWriteTokens?: number; // already counted in inputTokens
  reasoningTokens?: number; // already counted in outputTokens
}
```

#### Provider Implementations

All backends live in `@cogitator-ai/core`. Usually you configure them through `llm.providers` and let the runtime create them; you can also construct them directly:

```typescript
import {
  AnthropicBackend,
  AzureOpenAIBackend,
  BedrockBackend,
  GoogleBackend,
  OllamaBackend,
  OpenAIBackend,
} from '@cogitator-ai/core';

const ollama = new OllamaBackend({ baseUrl: 'http://localhost:11434' }); // apiKey optional

const openai = new OpenAIBackend({ apiKey: process.env.OPENAI_API_KEY! });
// Responses API on api.openai.com; Chat Completions for other base URLs and for
// requests with stop sequences. Force one with api: 'responses' | 'chat-completions'.

const anthropic = new AnthropicBackend({ apiKey: process.env.ANTHROPIC_API_KEY! });

const google = new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! });

const azure = new AzureOpenAIBackend({
  endpoint: 'https://my-resource.openai.azure.com',
  apiKey: process.env.AZURE_API_KEY!,
  apiVersion: '2024-08-01-preview', // the default
  deployment: 'gpt-6.1-sol',
});

const bedrock = new BedrockBackend({
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
```

Every backend the runtime uses is wrapped with retries for rate limits, 5xx, timeouts and dropped connections (`llm.retry`, 2 retries by default; `false` turns them off).

#### Supported Providers

| Provider    | Type  | Backend                                      |
| ----------- | ----- | -------------------------------------------- |
| `ollama`    | Local | `OllamaBackend`                              |
| `vllm`      | Local | `OpenAIBackend` against your vLLM `baseUrl`  |
| `openai`    | Cloud | `OpenAIBackend`                              |
| `anthropic` | Cloud | `AnthropicBackend`                           |
| `google`    | Cloud | `GoogleBackend`                              |
| `azure`     | Cloud | `AzureOpenAIBackend`                         |
| `bedrock`   | Cloud | `BedrockBackend`                             |
| `mistral`   | Cloud | `OpenAIBackend` (OpenAI-compatible endpoint) |
| `groq`      | Cloud | `OpenAIBackend` (OpenAI-compatible endpoint) |
| `together`  | Cloud | `OpenAIBackend` (OpenAI-compatible endpoint) |
| `deepseek`  | Cloud | `OpenAIBackend` (OpenAI-compatible endpoint) |

Your own backends go into `llm.backends` (by provider name) or are registered as plugins with `registerLLMBackend()` — see [LLM Backends](https://cogitator.app/docs/core/llm-backends#custom-backends).

#### Cost-Aware Routing

`CostAwareRouter` in `@cogitator-ai/core` analyzes a task, recommends the cheapest capable model and tracks spending. In the runtime, `costRouting.enabled` turns on cost tracking (`cog.getCostSummary()`); with `autoSelectModel: true` each run's model is picked from its input and checked against the budget first:

```typescript
const cog = new Cogitator({
  llm: {
    defaultModel: 'anthropic/claude-sonnet-5-5',
    providers: {
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
  costRouting: {
    enabled: true,
    autoSelectModel: true,
    preferLocal: false,
    budget: {
      maxCostPerRun: 0.1, // USD
      maxCostPerDay: 10,
      warningThreshold: 0.8,
    },
  },
});
```

See [Cost-Aware Routing](https://cogitator.app/docs/advanced/cost-routing).

---

### 6. Observability

Every run returns its spans in `RunResult.trace` and streams them to `onSpan` as they finish. Export them with `OTLPExporter` (or the Langfuse exporter):

```typescript
import { OTLPExporter } from '@cogitator-ai/core';

const exporter = new OTLPExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-service',
  serviceVersion: '1.0.0',
  enabled: true, // off unless set
});

exporter.start(); // flushes every 5 seconds

let runId = '';
await cog.run(agent, {
  input: 'Hello',
  onRunStart: (data) => {
    runId = data.runId;
  },
  onSpan: (span) => exporter.exportSpan(runId, span),
});
```

#### Span Type

```typescript
interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  status: 'ok' | 'error' | 'unset';
  startTime: number; // Unix ms
  endTime: number;
  duration: number; // ms
  attributes: Record<string, unknown>;
  events?: { name: string; timestamp: number; attributes?: Record<string, unknown> }[];
}
```

The runtime emits `llm.chat` (per LLM call), `tool.<name>` (per tool call), `agent.handoff` and, last, the root `agent.run` span:

```typescript
const result = await cog.run(agent, { input: 'What is the weather in Paris?' });

console.log(result.trace.traceId);
for (const span of result.trace.spans) {
  console.log(`${span.name} — ${span.duration}ms (${span.status})`);
}
// llm.chat — 1800ms (ok)       attributes: llm.model, llm.input_tokens, llm.output_tokens, …
// tool.get_weather — 200ms (ok) attributes: tool.name, tool.call_id, tool.success, …
// llm.chat — 400ms (ok)
// agent.run — 2450ms (ok)      attributes: agent.name, run.iterations, run.tool_calls, …
```

Full attribute list, Langfuse wiring and cost tracking: [Observability](https://cogitator.app/docs/deployment/observability).

#### Metrics

The runtime does not export Prometheus metrics for agent runs; use spans for those. Prometheus text comes from two places:

| Source                                                                      | Metrics                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cogitator-ai/worker` (`formatPrometheusMetrics`, `pool.metrics.format`)   | `cogitator_queue_depth`, `cogitator_queue_waiting`, `cogitator_queue_active`, `cogitator_queue_delayed`, `cogitator_queue_completed`, `cogitator_queue_failed` (gauges of jobs BullMQ still retains), `cogitator_workers_total`, `cogitator_jobs_by_type_total`, `cogitator_jobs_failed_total` (counter of jobs that failed their last attempt), `cogitator_job_duration_seconds` |
| `@cogitator-ai/workflows` (`WorkflowMetricsCollector.toPrometheusFormat()`) | Workflow and node counters, latencies, token and cost histograms, prefixed `cogitator_workflow_`                                                                                                                                                                                                                                                                                  |

---

## Deployment Architectures

### Single Node (Development)

The repository's `docker-compose.yml` starts the infrastructure; your app (which embeds the runtime) runs on the host:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16 # memory + pgvector embeddings
  redis:
    image: redis:7-alpine # memory, BullMQ queues, workflow stores
  ollama:
    image: ollama/ollama:latest # local models
```

```bash
docker compose up -d   # or: cogitator up
```

See [Docker](https://cogitator.app/docs/deployment/docker) for the full Compose file, environment variables and a production Dockerfile, and [Deploy Package](https://cogitator.app/docs/deployment/deploy-package) for `cogitator deploy` (Docker and Fly.io).

### Kubernetes (Production)

There are no prebuilt Cogitator images: you build your own API image (a server adapter around the runtime) and worker image (a `WorkerPool` process), and scale them separately:

```yaml
# Horizontal scaling with dedicated worker pools
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cogitator-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/my-agents-api:1.0.0
          resources:
            requests:
              memory: '512Mi'
              cpu: '500m'

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cogitator-worker
spec:
  replicas: 10
  template:
    spec:
      containers:
        - name: worker
          image: registry.example.com/my-agents-worker:1.0.0
          resources:
            requests:
              memory: '2Gi'
              cpu: '2'
```

Workers scale via an HPA on `cogitator_queue_depth`, exposed from `queue.getMetrics()` through a custom-metrics adapter (prometheus-adapter or KEDA) — see [HPA Autoscaling](https://cogitator.app/docs/deployment/worker-queues#hpa-autoscaling).

---

## Security Model

See [Security](https://cogitator.app/docs/advanced/security) for the full picture.

### Sandbox Isolation

A tool declares its sandbox with `sandbox`. For a `docker` tool the runtime does **not** call `execute`: it runs `sh -c <args.command>` in the container (with `args.cwd` and `args.env` when present). For a `wasm` tool the arguments go to the module as JSON on stdin:

```typescript
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';

const runShell = tool({
  name: 'run_shell',
  description: 'Run a shell command in an isolated container',
  parameters: z.object({ command: z.string() }),
  sandbox: {
    type: 'docker',
    image: 'python:3.12-slim',
    resources: { memory: '256MB', cpuShares: 512 },
    network: { mode: 'none' }, // no internet access
  },
  timeout: 30_000,
  execute: async ({ command }) => ({ command }), // not called for docker tools
});
```

If the sandbox cannot be initialized at all, a Docker-sandboxed tool runs its command natively with a warning (or fails with `sandbox.allowNativeFallback: false`) and a WASM tool runs its own `execute`; `SandboxManager` itself falls back from Docker to native execution under the same setting when Docker is unavailable (see [Three Execution Modes](#three-execution-modes)).

### Tool Approvals

A tool with `requiresApproval` (a boolean or a function of the arguments) never runs without a decision: the run asks `onApproval`, else `guardrails.onToolApproval`, else pauses with `status: 'paused'` and continues with `cog.resume()` — see [Approvals](https://cogitator.app/docs/tools/approvals).

```typescript
const result = await cog.run(agent, {
  input: 'Clean up the temp directory',
  onApproval: async (call) =>
    call.toolName === 'delete_file' && String(call.arguments.path).startsWith('/tmp/')
      ? { approved: true }
      : { approved: false, reason: 'only /tmp may be deleted' },
});
```

### Constitutional AI Guardrails

`guardrails` turns on input, output, tool-call and (with `filterToolResults`) tool-result filtering with a critique-revise loop; fields left out take `DEFAULT_GUARDRAIL_CONFIG`, and without a `guardrails` section (or with `enabled: false`) nothing is filtered. Its tool guard also refuses dangerous shell commands and system paths:

```typescript
const cog = new Cogitator({
  guardrails: {
    model: 'openai/gpt-6-luna', // defaults to the running agent's model
    filterToolResults: true,
    onViolation: (result, layer) => console.warn(layer, result.blockedReason),
  },
});
```

See [Constitutional AI](https://cogitator.app/docs/advanced/constitutional-ai).

### Prompt Injection Detection and PII Masking

```typescript
const cog = new Cogitator({
  security: {
    promptInjection: {
      action: 'block', // 'block' | 'warn' | 'log'
      threshold: 0.8,
    },
    pii: {
      mode: 'mask', // 'mask' | 'redact' | 'block'
    },
  },
});
```

With `pii`, emails, phone numbers, card numbers, IBANs, SSNs, IP addresses and API keys are replaced with placeholders before every LLM request; memory keeps the real values.

---

## References

- [OpenAI Assistants API](https://platform.openai.com/docs/assistants/overview)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [Agent-to-Agent Protocol (A2A)](https://a2a-protocol.org/)
- [OpenTelemetry](https://opentelemetry.io/)
- [BullMQ](https://docs.bullmq.io/)
- [Extism (WASM)](https://extism.org/)
- [pgvector](https://github.com/pgvector/pgvector)
- [Vercel AI SDK](https://ai-sdk.dev/)
