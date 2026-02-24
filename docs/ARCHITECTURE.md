# Cogitator Architecture

> Deep technical dive into the system design

## Package Ecosystem

Cogitator is a monorepo with 31 packages covering the full stack of agent infrastructure:

| Layer              | Package                        | Description                                                          |
| ------------------ | ------------------------------ | -------------------------------------------------------------------- |
| **Core**           | `@cogitator-ai/types`          | Shared TypeScript interfaces                                         |
|                    | `@cogitator-ai/core`           | Main runtime — Agent, Cogitator, tools, LLM backends                 |
|                    | `@cogitator-ai/models`         | Dynamic model registry with pricing                                  |
|                    | `@cogitator-ai/config`         | Configuration management with YAML/env support                       |
| **Memory**         | `@cogitator-ai/memory`         | Memory adapters: Redis, Postgres, SQLite, MongoDB, Qdrant, in-memory |
| **Execution**      | `@cogitator-ai/sandbox`        | Docker + WASM + native execution isolation                           |
|                    | `@cogitator-ai/wasm-tools`     | 14 pre-built WASM tools (calc, hash, regex, CSV, XML, …)             |
|                    | `@cogitator-ai/worker`         | BullMQ distributed job queue for agent execution                     |
| **Orchestration**  | `@cogitator-ai/workflows`      | DAG engine with sagas, map-reduce, scheduling                        |
|                    | `@cogitator-ai/swarms`         | 7 swarm strategies (sequential, parallel, roundrobin, …)             |
| **Protocols**      | `@cogitator-ai/a2a`            | Agent-to-Agent Protocol v0.3                                         |
|                    | `@cogitator-ai/mcp`            | Model Context Protocol client                                        |
|                    | `@cogitator-ai/openai-compat`  | OpenAI Assistants API compatibility layer                            |
| **Integrations**   | `@cogitator-ai/ai-sdk`         | Vercel AI SDK adapter                                                |
|                    | `@cogitator-ai/express`        | Express.js middleware                                                |
|                    | `@cogitator-ai/fastify`        | Fastify plugin                                                       |
|                    | `@cogitator-ai/hono`           | Hono middleware                                                      |
|                    | `@cogitator-ai/koa`            | Koa middleware                                                       |
|                    | `@cogitator-ai/next`           | Next.js App Router                                                   |
|                    | `@cogitator-ai/server-shared`  | Shared REST/SSE/WebSocket utilities                                  |
| **Advanced**       | `@cogitator-ai/self-modifying` | Runtime tool generation                                              |
|                    | `@cogitator-ai/neuro-symbolic` | Prolog-style logic, SAT/SMT                                          |
|                    | `@cogitator-ai/rag`            | RAG pipeline (loaders, chunkers, retrieval, reranking)               |
|                    | `@cogitator-ai/evals`          | Eval framework (metrics, A/B testing, assertions)                    |
|                    | `@cogitator-ai/voice`          | Voice/Realtime agents (STT, TTS, VAD)                                |
| **Infrastructure** | `@cogitator-ai/redis`          | Redis client (standalone + cluster)                                  |
|                    | `@cogitator-ai/deploy`         | Docker & Fly.io deployment utilities                                 |
|                    | `@cogitator-ai/cli`            | CLI (init/up/run/deploy)                                             |
| **Support**        | `@cogitator-ai/dashboard`      | Next.js landing + docs (Fumadocs) + dashboard                        |
|                    | `@cogitator-ai/test-utils`     | Testing utilities                                                    |
|                    | `@cogitator-ai/e2e`            | End-to-end test suite                                                |
|                    | `create-cogitator-app`         | Interactive project scaffolder                                       |

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                USER LAYER                                        │
│                                                                                 │
│  TypeScript SDK  │  REST/SSE (Express/Fastify/Hono/Koa/Next)  │  CLI           │
│  OpenAI-compat   │  Vercel AI SDK adapter   │  A2A Protocol                    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME CORE (@cogitator-ai/core)                   │
│                                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Agent     │  │  Cogitator  │  │ CostRouter  │  │   ConstitutionalAI      │ │
│  │             │  │  (Runtime)  │  │             │  │   (Guardrails)          │ │
│  │ • Tools     │  │ • Runs      │  │ • Routing   │  │ • Input/output filter   │ │
│  │ • Prompt    │  │ • Memory    │  │ • Budget    │  │ • Critique-revise       │ │
│  │ • Model     │  │ • Sandbox   │  │ • Tracking  │  │ • Tool guard            │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
┌──────────────────────────────┐   ┌───────────────────────────────────────────────┐
│  DISTRIBUTED EXECUTION        │   │               MEMORY LAYER                    │
│  (@cogitator-ai/worker)       │   │           (@cogitator-ai/memory)              │
│                               │   │                                               │
│  ┌────────────┐  ┌──────────┐ │   │ ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  JobQueue  │  │WorkerPool│ │   │ │ InMemory │  │  Redis   │  │  Postgres   │  │
│  │  (BullMQ)  │  │          │ │   │ │ Adapter  │  │ Adapter  │  │  Adapter    │  │
│  │            │  │ • agent  │ │   │ └──────────┘  └──────────┘  └─────────────┘  │
│  │ addAgent   │  │ • workflow│ │   │ ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ addWorkflow│  │ • swarm  │ │   │ │  SQLite  │  │ MongoDB  │  │   Qdrant    │  │
│  │ addSwarm   │  └──────────┘ │   │ │ Adapter  │  │ Adapter  │  │  Adapter    │  │
│  └────────────┘               │   │ └──────────┘  └──────────┘  └─────────────┘  │
└──────────────────────────────┘   └───────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LLM BACKENDS                                        │
│                                                                                 │
│  Ollama │ vLLM │ OpenAI │ Anthropic │ Google │ Azure │ Bedrock │ Mistral │ Groq │
│                          Together │ DeepSeek                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Deep Dives

### 1. HTTP Adapters

Cogitator integrates with any Node.js HTTP framework via thin adapters. Each adapter exposes the same REST/SSE API surface:

```typescript
// Express
import { createCogitatorRouter } from '@cogitator-ai/express';

const app = express();
app.use('/api', createCogitatorRouter(cogitator));

// Fastify
import { cogitatorPlugin } from '@cogitator-ai/fastify';

await fastify.register(cogitatorPlugin, { cogitator, prefix: '/api' });

// Hono
import { createCogitatorMiddleware } from '@cogitator-ai/hono';

app.use('/api/*', createCogitatorMiddleware(cogitator));
```

For OpenAI-compatible endpoints (drop-in replacement):

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1', // Cogitator endpoint
  apiKey: 'cog_xxx',
});

const assistant = await client.beta.assistants.create({
  model: 'ollama/llama3.3:latest',
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

---

### 2. Distributed Job Queue

The `@cogitator-ai/worker` package provides BullMQ-based job processing for distributing agent/workflow/swarm execution across worker processes.

#### Architecture

```typescript
import { JobQueue, WorkerPool } from '@cogitator-ai/worker';

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

// Add an agent job
const job = await queue.addAgentJob(agent.serialize(), 'Analyze this data', {
  threadId: 'thread-123',
  priority: 10,
  metadata: { userId: 'user-abc' },
});

// Add a workflow job
await queue.addWorkflowJob(workflowConfig, { input: 'Start workflow' });

// Add a swarm job
await queue.addSwarmJob(swarmConfig, 'Process batch');

// Consumer side: process jobs
const pool = new WorkerPool({
  queue: { name: 'cogitator-jobs', redis: { host: 'localhost', port: 6379 } },
  cogitator: cogitatorInstance,
  concurrency: 10,
  limiter: { max: 100, duration: 1000 },
});
```

#### Queue Metrics (for HPA)

```typescript
const metrics = await queue.getMetrics();
// { waiting, active, completed, failed, delayed, depth, workerCount }

// Prometheus exposition format for autoscaling
import { formatPrometheusMetrics } from '@cogitator-ai/worker';
const prometheusText = formatPrometheusMetrics(metrics, 'cogitator-jobs');
```

#### Run State Machine

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  QUEUED │───►│ ACTIVE  │───►│COMPLETED│    │ FAILED  │
└─────────┘    └────┬────┘    └─────────┘    └────▲────┘
                    │                              │
                    │ (retryable error)            │
                    └──────────────────────────────┘
                         (on maxRetries exceeded)
```

---

### 3. Memory Architecture

The `@cogitator-ai/memory` package provides pluggable storage adapters for conversation history, facts, and embeddings.

#### Memory Hierarchy (Conceptual)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Memory System                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  In-Memory / Redis: short-lived conversation context                │
│  Postgres / MongoDB / SQLite: persistent conversation history       │
│  Qdrant: semantic (vector) search over past conversations           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### MemoryAdapter Interface

All adapters implement this interface:

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

#### Extended Adapters

Postgres adapter also implements `FactAdapter` (long-term facts) and `EmbeddingAdapter` (semantic search via pgvector):

```typescript
// FactAdapter — long-term memory (Postgres)
interface FactAdapter {
  addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>>;
  getFacts(agentId: string, category?: string): Promise<MemoryResult<Fact[]>>;
  updateFact(factId: string, updates: Partial<Fact>): Promise<MemoryResult<Fact>>;
  deleteFact(factId: string): Promise<MemoryResult<void>>;
  searchFacts(agentId: string, query: string): Promise<MemoryResult<Fact[]>>;
}

// EmbeddingAdapter — semantic search (pgvector / Qdrant)
interface EmbeddingAdapter {
  addEmbedding(embedding: Omit<Embedding, 'id' | 'createdAt'>): Promise<MemoryResult<Embedding>>;
  search(options: SemanticSearchOptions): Promise<MemoryResult<(Embedding & { score: number })[]>>;
  deleteEmbedding(embeddingId: string): Promise<MemoryResult<void>>;
  deleteBySource(sourceId: string): Promise<MemoryResult<void>>;
}
```

#### ContextBuilder

Automatically builds LLM-ready context from stored entries, respecting token limits:

```typescript
import { ContextBuilder } from '@cogitator-ai/memory';

const builder = new ContextBuilder({
  adapter,
  embeddingAdapter, // optional
  embeddingService, // optional
  config: {
    maxTokens: 8192,
    strategy: 'hybrid', // 'recent' | 'relevant' | 'hybrid'
    includeFacts: true,
    includeSemanticContext: true,
  },
});

const context = await builder.buildContext(threadId, query);
// context.messages, context.facts, context.semanticResults, context.truncated
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

// Execute in Docker sandbox
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

// result: { stdout, stderr, exitCode, timedOut, duration }
```

#### Three Execution Modes

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SandboxManager                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  DockerSandboxExecutor  — full OS isolation, ~100ms startup         │
│  • Custom images (Python, Node, etc.)                               │
│  • Resource limits (CPU, memory, PIDs)                              │
│  • Network policies (none / bridge / host)                          │
│  • ContainerPool for warm container reuse                           │
│                                                                     │
│  WASM Sandbox (Extism)  — process-level isolation, ~1ms startup     │
│  • Memory-safe execution                                            │
│  • No filesystem / restricted network by default                   │
│  • 14 pre-built tools in @cogitator-ai/wasm-tools                  │
│                                                                     │
│  NativeSandboxExecutor  — direct Node.js, 0ms overhead             │
│  • For trusted internal tools                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

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
import { createCalcTool, createHashTool, defineWasmTool } from '@cogitator-ai/wasm-tools';

const calc = createCalcTool();
const hash = createHashTool();

// Custom WASM tool
const myTool = defineWasmTool({
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
}

interface ChatResponse {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}
```

#### Provider Implementations

All backends live in `@cogitator-ai/core`:

```typescript
// Ollama (local models)
import { OllamaBackend } from '@cogitator-ai/core';

const ollama = new OllamaBackend({
  baseUrl: 'http://localhost:11434',
  apiKey: undefined, // optional
});

// OpenAI
import { OpenAIBackend } from '@cogitator-ai/core';

const openai = new OpenAIBackend({ apiKey: process.env.OPENAI_API_KEY! });

// Anthropic
import { AnthropicBackend } from '@cogitator-ai/core';

const anthropic = new AnthropicBackend({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Google
import { GoogleBackend } from '@cogitator-ai/core';

const google = new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! });

// Azure OpenAI
import { AzureOpenAIBackend } from '@cogitator-ai/core';

const azure = new AzureOpenAIBackend({
  endpoint: 'https://my-resource.openai.azure.com',
  apiKey: process.env.AZURE_API_KEY!,
  apiVersion: '2024-05-01-preview',
  deployment: 'gpt-4o',
});

// AWS Bedrock
import { BedrockBackend } from '@cogitator-ai/core';

const bedrock = new BedrockBackend({
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
```

#### Supported Providers

| Provider    | Type  | Package              |
| ----------- | ----- | -------------------- |
| `ollama`    | Local | `@cogitator-ai/core` |
| `vllm`      | Local | `@cogitator-ai/core` |
| `openai`    | Cloud | `@cogitator-ai/core` |
| `anthropic` | Cloud | `@cogitator-ai/core` |
| `google`    | Cloud | `@cogitator-ai/core` |
| `azure`     | Cloud | `@cogitator-ai/core` |
| `bedrock`   | Cloud | `@cogitator-ai/core` |
| `mistral`   | Cloud | `@cogitator-ai/core` |
| `groq`      | Cloud | `@cogitator-ai/core` |
| `together`  | Cloud | `@cogitator-ai/core` |
| `deepseek`  | Cloud | `@cogitator-ai/core` |

#### Cost-Aware Routing

The `CostRouter` in `@cogitator-ai/core` automatically selects the cheapest model that meets task requirements:

```typescript
const cog = new Cogitator({
  llm: {
    defaultModel: 'anthropic/claude-sonnet-4-5',
    providers: {
      /* ... */
    },
  },
  costRouting: {
    enabled: true,
    budget: {
      dailyLimit: 10.0, // USD
      runLimit: 0.1,
    },
    routing: {
      simple: 'openai/gpt-4o-mini',
      complex: 'anthropic/claude-sonnet-4-5',
    },
  },
});
```

---

### 6. Observability

Full observability with OpenTelemetry export via `OTLPExporter`:

```typescript
import { OTLPExporter } from '@cogitator-ai/core';

const exporter = new OTLPExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-service',
  serviceVersion: '1.0.0',
  enabled: true,
});

exporter.start();

// Wire up via RunOptions
const result = await cog.run(agent, {
  input: 'Hello',
  onRunStart: (data) => exporter.onRunStart({ ...data, agentName: agent.name }),
  onRunComplete: (result) => exporter.onRunComplete(result),
  onSpan: (span) => exporter.exportSpan(result.runId, span),
});
```

#### Span Type

Every meaningful operation in a run emits a `Span`:

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

Spans are collected in `RunResult.trace`:

```typescript
const result = await cog.run(agent, { input: 'Hello' });

console.log(result.trace.traceId);
for (const span of result.trace.spans) {
  console.log(`${span.name} — ${span.duration}ms (${span.status})`);
}
// agent.run — 2500ms (ok)
// memory.load — 50ms (ok)
// llm.chat — 1800ms (ok) [attributes: { model, inputTokens, outputTokens }]
// tool.execute — 200ms (ok) [attributes: { tool }]
// llm.chat — 400ms (ok)
```

#### Metrics

Key metrics to track via Prometheus or OpenTelemetry:

```
cogitator_agent_runs_total          counter
cogitator_agent_runs_failed_total   counter
cogitator_llm_requests_total        counter
cogitator_tool_executions_total     counter
cogitator_agent_run_duration_ms     histogram
cogitator_llm_latency_ms            histogram
cogitator_queue_depth               gauge  (from JobQueue.getMetrics())
cogitator_queue_active              gauge
```

---

## Deployment Architectures

### Single Node (Development)

```yaml
# docker-compose.yml
services:
  cogitator:
    image: cogitator/runtime:latest
    ports:
      - '3000:3000'
    environment:
      - DATABASE_URL=postgres://localhost/cogitator
      - REDIS_URL=redis://localhost:6379
      - OLLAMA_URL=http://host.docker.internal:11434

  postgres:
    image: pgvector/pgvector:pg16

  redis:
    image: redis:7-alpine

  ollama:
    image: ollama/ollama
    volumes:
      - ollama_data:/root/.ollama
```

### Kubernetes (Production)

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
          image: cogitator/api:latest
          resources:
            requests:
              memory: '512Mi'
              cpu: '500m'

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cogitator-workers
spec:
  replicas: 10
  template:
    spec:
      containers:
        - name: worker
          image: cogitator/worker:latest
          resources:
            requests:
              memory: '2Gi'
              cpu: '2'
            limits:
              nvidia.com/gpu: 1 # for local inference
```

Workers scale independently via HPA using the `cogitator_queue_depth` metric from `JobQueue.getMetrics()`.

---

## Security Model

### Sandbox Isolation

Tool execution isolation is enforced at the sandbox level:

```typescript
// Tools can declare their sandbox requirements
const tool = tool({
  name: 'run_python',
  description: 'Execute Python code',
  parameters: z.object({ code: z.string() }),
  sandbox: {
    type: 'docker',
    image: 'python:3.12-slim',
    resources: { memory: '256MB', cpuShares: 512 },
    network: { mode: 'none' }, // no internet access
    timeout: 30_000,
  },
  execute: async ({ code }) => {
    /* ... */
  },
});
```

### Constitutional AI Guardrails

Input/output filtering via `@cogitator-ai/core`:

```typescript
const cog = new Cogitator({
  guardrails: {
    constitution: 'Be helpful. Do not assist with harmful requests.',
    onToolApproval: async (tool, args) => {
      if (tool.name === 'delete_file') {
        return confirm(`Allow delete: ${args.path}?`);
      }
      return true;
    },
  },
});
```

### Prompt Injection Detection

```typescript
const cog = new Cogitator({
  security: {
    promptInjection: {
      enabled: true,
      action: 'block', // 'block' | 'warn' | 'sanitize'
      threshold: 0.8,
    },
  },
});
```

---

## Performance Benchmarks (Target)

| Metric                     | Target  | Notes                           |
| -------------------------- | ------- | ------------------------------- |
| HTTP adapter latency (p50) | < 5ms   | Excluding LLM time              |
| HTTP adapter latency (p99) | < 20ms  |                                 |
| Concurrent agent runs      | 10,000+ | Per node, via queue             |
| Memory retrieval           | < 10ms  | With proper indexing            |
| Tool execution (WASM)      | < 5ms   | Excluding tool logic            |
| Tool execution (Docker)    | < 200ms | Cold start; ~1ms with pool      |
| Span export                | < 1ms   | Async batching via OTLPExporter |

---

## References

- [OpenAI Assistants API](https://platform.openai.com/docs/assistants/overview)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [Agent-to-Agent Protocol (A2A)](https://google.github.io/A2A/)
- [OpenTelemetry](https://opentelemetry.io/)
- [BullMQ](https://docs.bullmq.io/)
- [Extism (WASM)](https://extism.org/)
- [pgvector](https://github.com/pgvector/pgvector)
- [Vercel AI SDK](https://sdk.vercel.ai/)
