# Cogitator Architecture

> Deep technical dive into the system design

## Overview

Cogitator is designed as a **distributed agent runtime** with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                USER LAYER                                        │
│                                                                                 │
│   SDK (TypeScript)  │  REST API  │  gRPC  │  WebSocket  │  CLI                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CONTROL PLANE                                       │
│                                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Gateway   │  │ Orchestrator│  │  Scheduler  │  │    Registry Service     │ │
│  │             │  │             │  │             │  │                         │ │
│  │ • Auth      │  │ • Task Mgmt │  │ • Job Queue │  │ • Agent Registry        │ │
│  │ • Routing   │  │ • Lifecycle │  │ • Cron      │  │ • Tool Registry         │ │
│  │ • Protocol  │  │ • Events    │  │ • Triggers  │  │ • Workflow Registry     │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATA PLANE                                          │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         Agent Execution Engine                          │    │
│  │                                                                         │    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────────────────┐ │    │
│  │  │  Worker   │  │  Worker   │  │  Worker   │  │    Workflow Engine    │ │    │
│  │  │  Pool     │  │  Pool     │  │  Pool     │  │                       │ │    │
│  │  │ (Docker)  │  │  (WASM)   │  │  (Native) │  │  • DAG Execution      │ │    │
│  │  └───────────┘  └───────────┘  └───────────┘  │  • State Machine      │ │    │
│  │                                               │  • Compensation       │ │    │
│  │                                               └───────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              STORAGE LAYER                                       │
│                                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Redis     │  │  Postgres   │  │  pgvector   │  │     Object Storage      │ │
│  │             │  │             │  │             │  │                         │ │
│  │ • Sessions  │  │ • Agents    │  │ • Embeddings│  │ • Artifacts             │ │
│  │ • Cache     │  │ • Runs      │  │ • Semantic  │  │ • Files                 │ │
│  │ • Pub/Sub   │  │ • Memory    │  │   Search    │  │ • Snapshots             │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LLM BACKENDS                                        │
│                                                                                 │
│   Ollama  │  vLLM  │  llama.cpp  │  OpenAI  │  Anthropic  │  Google  │  Azure  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Deep Dives

### 1. Gateway

The Gateway is the single entry point for all client interactions.

#### Responsibilities

- **Authentication & Authorization** — JWT validation, API key management, RBAC enforcement
- **Protocol Translation** — Convert REST/gRPC/WebSocket to internal message format
- **Rate Limiting** — Token bucket algorithm per client/organization
- **Request Routing** — Route to appropriate orchestrator based on agent type

#### Technology Choices

| Component | Technology | Rationale |
|-----------|------------|-----------|
| HTTP Server | Fastify | Fastest Node.js framework, plugin ecosystem |
| Type Safety | tRPC | End-to-end type safety, auto-generated clients |
| WebSocket | uWebSockets.js | 10x faster than ws, C++ bindings |
| gRPC | @grpc/grpc-js | Official gRPC for high-performance RPC |

#### API Structure

```typescript
// tRPC router definition
export const appRouter = router({
  // Agent management
  agents: router({
    create: protectedProcedure
      .input(AgentCreateSchema)
      .mutation(({ input }) => agentService.create(input)),

    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input }) => agentService.get(input.id)),

    list: protectedProcedure
      .input(PaginationSchema)
      .query(({ input }) => agentService.list(input)),
  }),

  // Execution
  runs: router({
    create: protectedProcedure
      .input(RunCreateSchema)
      .mutation(({ input }) => orchestrator.execute(input)),

    stream: protectedProcedure
      .input(z.object({ runId: z.string() }))
      .subscription(({ input }) => orchestrator.stream(input.runId)),
  }),

  // OpenAI-compatible endpoints (for drop-in replacement)
  v1: router({
    chat: router({
      completions: openAICompatibleProcedure
        .input(OpenAIChatSchema)
        .mutation(({ input }) => openAIAdapter.chat(input)),
    }),
    assistants: openAIAssistantsRouter,
  }),
});
```

#### OpenAI Compatibility Layer

Full compatibility with OpenAI Assistants API for drop-in replacement:

```typescript
// OpenAI SDK works out of the box
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1', // Cogitator endpoint
  apiKey: 'cog_xxx', // Cogitator API key
});

const assistant = await client.beta.assistants.create({
  model: 'llama3.2:70b', // Use local model
  instructions: 'You are a helpful assistant.',
  tools: [{ type: 'code_interpreter' }],
});

const thread = await client.beta.threads.create();
const message = await client.beta.threads.messages.create(thread.id, {
  role: 'user',
  content: 'Write a Python script to calculate fibonacci numbers',
});

const run = await client.beta.threads.runs.create(thread.id, {
  assistant_id: assistant.id,
});
```

---

### 2. Orchestrator

The Orchestrator manages agent lifecycle and task execution.

#### State Machine

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐   │   ┌─────────┐
│ CREATED │───►│ QUEUED  │───►│ RUNNING │───►│ WAITING │───┘   │ FAILED  │
└─────────┘    └─────────┘    └────┬────┘    └─────────┘       └────▲────┘
                                   │              │                  │
                                   │              │ (tool call       │
                                   │              │  or human        │
                                   │              │  input)          │
                                   │              │                  │
                                   ▼              │                  │
                              ┌─────────┐        │                  │
                              │COMPLETED│◄───────┘                  │
                              └─────────┘                           │
                                   │                                │
                                   └────────────────────────────────┘
                                         (on error, max retries)
```

#### Task Queue Architecture

```typescript
interface TaskQueue {
  // Priority-based insertion
  enqueue(task: Task, priority: Priority): Promise<void>;

  // Worker pulls next task
  dequeue(workerCapabilities: Capabilities): Promise<Task | null>;

  // Heartbeat to prevent stuck tasks
  heartbeat(taskId: string): Promise<void>;

  // Task completion
  complete(taskId: string, result: TaskResult): Promise<void>;

  // Failure handling with retry
  fail(taskId: string, error: Error, shouldRetry: boolean): Promise<void>;
}

// Implementation uses BullMQ for reliability
class BullMQTaskQueue implements TaskQueue {
  private queue: Queue;
  private worker: Worker;

  constructor(redis: Redis) {
    this.queue = new Queue('agent-tasks', { connection: redis });

    this.worker = new Worker('agent-tasks', async (job) => {
      const executor = new AgentExecutor(job.data);
      return executor.run();
    }, {
      connection: redis,
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 1000, // 100 jobs/second
      },
    });
  }
}
```

#### Load Balancing Strategy

```typescript
interface LoadBalancer {
  selectWorker(task: Task): Promise<Worker>;
}

class SmartLoadBalancer implements LoadBalancer {
  async selectWorker(task: Task): Promise<Worker> {
    const workers = await this.getAvailableWorkers();

    // Score each worker
    const scored = workers.map(worker => ({
      worker,
      score: this.calculateScore(worker, task),
    }));

    // Select best match
    return scored.sort((a, b) => b.score - a.score)[0].worker;
  }

  private calculateScore(worker: Worker, task: Task): number {
    let score = 0;

    // 1. Capability match (required model available?)
    if (worker.capabilities.models.includes(task.model)) {
      score += 100;
    }

    // 2. Current load (prefer less busy)
    score -= worker.currentLoad * 10;

    // 3. Memory affinity (prefer workers with cached context)
    if (worker.cachedContexts.includes(task.contextId)) {
      score += 50;
    }

    // 4. Locality (prefer same region for latency)
    if (worker.region === task.preferredRegion) {
      score += 25;
    }

    // 5. Cost optimization
    score -= worker.costPerToken * task.estimatedTokens;

    return score;
  }
}
```

---

### 3. Memory Manager

The Memory Manager provides intelligent context management across multiple storage backends.

#### Memory Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Memory Manager                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    L1: Working Memory                       │    │
│  │                    (In-Process Cache)                       │    │
│  │                                                             │    │
│  │  • Current conversation context                             │    │
│  │  • Active tool results                                      │    │
│  │  • TTL: Session lifetime                                    │    │
│  │  • Size: ~32K tokens per agent                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    L2: Short-Term Memory                    │    │
│  │                    (Redis)                                  │    │
│  │                                                             │    │
│  │  • Recent conversations (last 24h)                          │    │
│  │  • Session state                                            │    │
│  │  • Cross-request context                                    │    │
│  │  • TTL: 24 hours (configurable)                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    L3: Long-Term Memory                     │    │
│  │                    (Postgres)                               │    │
│  │                                                             │    │
│  │  • Full conversation history                                │    │
│  │  • User preferences                                         │    │
│  │  • Learned facts                                            │    │
│  │  • TTL: Permanent                                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    L4: Semantic Memory                      │    │
│  │                    (pgvector)                               │    │
│  │                                                             │    │
│  │  • Embedded knowledge                                       │    │
│  │  • Similarity search                                        │    │
│  │  • RAG retrieval                                            │    │
│  │  • TTL: Permanent                                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Memory Interface

```typescript
interface MemoryManager {
  // Store a memory
  store(memory: Memory): Promise<void>;

  // Retrieve relevant memories for context
  retrieve(query: RetrievalQuery): Promise<Memory[]>;

  // Build context for LLM (with auto-truncation)
  buildContext(agentId: string, maxTokens: number): Promise<Context>;

  // Summarize old memories to save space
  summarize(agentId: string): Promise<void>;

  // Clear memories
  clear(agentId: string, options?: ClearOptions): Promise<void>;
}

interface Memory {
  id: string;
  agentId: string;
  type: 'message' | 'tool_result' | 'fact' | 'summary';
  content: string;
  embedding?: number[];  // For semantic search
  metadata: {
    timestamp: Date;
    importance: number;  // 0-1, affects retrieval priority
    source: string;
    tags: string[];
  };
}

interface RetrievalQuery {
  agentId: string;
  query: string;
  limit: number;
  strategies: RetrievalStrategy[];
  filters?: {
    types?: Memory['type'][];
    timeRange?: { start: Date; end: Date };
    tags?: string[];
  };
}

type RetrievalStrategy =
  | 'recency'      // Most recent first
  | 'semantic'     // Most similar to query
  | 'importance'   // Highest importance score
  | 'hybrid';      // Weighted combination
```

#### Automatic Summarization

When context exceeds limits, automatic summarization kicks in:

```typescript
class ContextBuilder {
  async buildContext(agentId: string, maxTokens: number): Promise<Context> {
    // 1. Get all relevant memories
    const memories = await this.memoryManager.retrieve({
      agentId,
      query: '', // Empty for full retrieval
      limit: 1000,
      strategies: ['recency', 'importance'],
    });

    // 2. Calculate token count
    let tokenCount = this.countTokens(memories);

    // 3. If over limit, apply compression strategies
    if (tokenCount > maxTokens) {
      // Strategy 1: Remove low-importance memories
      memories = memories.filter(m => m.metadata.importance > 0.3);
      tokenCount = this.countTokens(memories);

      // Strategy 2: Summarize old conversations
      if (tokenCount > maxTokens) {
        const oldMemories = memories.filter(m =>
          m.metadata.timestamp < Date.now() - 24 * 60 * 60 * 1000
        );
        const summary = await this.summarizer.summarize(oldMemories);
        memories = [
          { type: 'summary', content: summary, metadata: { importance: 0.8 } },
          ...memories.filter(m => !oldMemories.includes(m)),
        ];
      }

      // Strategy 3: Truncate remaining
      if (tokenCount > maxTokens) {
        memories = this.truncateToFit(memories, maxTokens);
      }
    }

    return this.formatContext(memories);
  }
}
```

---

### 4. Agent Execution Engine

The execution engine runs agents in isolated environments.

#### Sandbox Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Sandbox Manager                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Docker Sandbox                              │  │
│  │                                                                │  │
│  │  • Full OS isolation                                          │  │
│  │  • Custom images (Python, Node, etc.)                         │  │
│  │  • Resource limits (CPU, memory, disk)                        │  │
│  │  • Network policies                                           │  │
│  │  • Best for: Code execution, untrusted tools                  │  │
│  │  • Overhead: ~100ms startup                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    WASM Sandbox (Extism)                       │  │
│  │                                                                │  │
│  │  • Process-level isolation                                    │  │
│  │  • Near-native performance                                    │  │
│  │  • Limited capabilities (no filesystem, restricted network)   │  │
│  │  • Best for: Trusted plugins, high-frequency tools            │  │
│  │  • Overhead: ~1ms startup                                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Native Execution                            │  │
│  │                                                                │  │
│  │  • No isolation                                               │  │
│  │  • Direct Node.js execution                                   │  │
│  │  • Best for: Trusted internal tools                           │  │
│  │  • Overhead: 0ms                                              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Docker Sandbox Implementation

```typescript
class DockerSandbox implements Sandbox {
  private docker: Docker;
  private containerPool: ContainerPool;

  async execute(code: string, options: ExecutionOptions): Promise<ExecutionResult> {
    // 1. Get container from pool (or create new)
    const container = await this.containerPool.acquire({
      image: options.image || 'cogitator/sandbox:python',
      resources: {
        memory: options.memory || '256MB',
        cpuShares: options.cpu || 512,
      },
    });

    try {
      // 2. Write code to container
      await container.putArchive(this.createTarball(code), { path: '/workspace' });

      // 3. Execute with timeout
      const exec = await container.exec({
        Cmd: ['python', '/workspace/main.py'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const result = await this.runWithTimeout(exec, options.timeout || 30_000);

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTime: result.duration,
      };
    } finally {
      // 4. Return container to pool
      await this.containerPool.release(container);
    }
  }
}
```

#### Agent Loop

The core execution loop for a single agent:

```typescript
class AgentExecutor {
  async execute(agent: Agent, input: string): Promise<AgentResult> {
    const context = await this.memory.buildContext(agent.id, agent.contextWindow);
    const messages: Message[] = [...context.messages, { role: 'user', content: input }];

    let iterations = 0;
    const maxIterations = agent.maxIterations || 10;

    while (iterations < maxIterations) {
      iterations++;

      // 1. Call LLM
      const response = await this.llm.chat({
        model: agent.model,
        messages,
        tools: agent.tools.map(t => t.schema),
        temperature: agent.temperature,
      });

      // 2. Check if done
      if (response.finishReason === 'stop') {
        await this.memory.store({
          agentId: agent.id,
          type: 'message',
          content: response.content,
          metadata: { importance: 0.7 },
        });

        return {
          output: response.content,
          iterations,
          usage: response.usage,
        };
      }

      // 3. Execute tool calls
      if (response.toolCalls) {
        const toolResults = await Promise.all(
          response.toolCalls.map(async (call) => {
            const tool = agent.tools.find(t => t.name === call.name);
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);

            const result = await this.sandbox.execute(tool, call.arguments);

            await this.memory.store({
              agentId: agent.id,
              type: 'tool_result',
              content: JSON.stringify(result),
              metadata: { importance: 0.5, tool: call.name },
            });

            return { toolCallId: call.id, result };
          })
        );

        // Add tool results to messages
        messages.push({ role: 'assistant', toolCalls: response.toolCalls });
        messages.push({ role: 'tool', results: toolResults });
      }
    }

    throw new Error(`Agent exceeded max iterations (${maxIterations})`);
  }
}
```

---

### 5. LLM Backend Abstraction

Unified interface for all LLM providers:

```typescript
interface LLMBackend {
  // Basic chat completion
  chat(request: ChatRequest): Promise<ChatResponse>;

  // Streaming chat
  chatStream(request: ChatRequest): AsyncGenerator<ChatChunk>;

  // Get available models
  listModels(): Promise<Model[]>;

  // Health check
  health(): Promise<HealthStatus>;
}

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
}

interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}
```

#### Provider Implementations

```typescript
// Ollama
class OllamaBackend implements LLMBackend {
  constructor(private baseUrl: string = 'http://localhost:11434') {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: request.model,
        messages: this.convertMessages(request.messages),
        tools: request.tools,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
        },
      }),
    });
    return this.parseResponse(await response.json());
  }
}

// OpenAI
class OpenAIBackend implements LLMBackend {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      messages: request.messages,
      tools: request.tools?.map(this.convertTool),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    });
    return this.parseResponse(response);
  }
}

// Anthropic
class AnthropicBackend implements LLMBackend {
  private client: Anthropic;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens || 4096,
      messages: this.convertMessages(request.messages),
      tools: request.tools?.map(this.convertTool),
    });
    return this.parseResponse(response);
  }
}
```

#### Smart Router

Automatically routes requests to the best available backend:

```typescript
class SmartLLMRouter {
  private backends: Map<string, LLMBackend> = new Map();

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Parse model string: "provider/model" or just "model"
    const { provider, model } = this.parseModel(request.model);

    // Select backend
    const backend = provider
      ? this.backends.get(provider)
      : await this.selectBestBackend(model, request);

    if (!backend) {
      throw new Error(`No backend available for model: ${request.model}`);
    }

    // Execute with fallback
    try {
      return await backend.chat({ ...request, model });
    } catch (error) {
      if (this.shouldFallback(error)) {
        const fallback = await this.selectFallbackBackend(model);
        return fallback.chat({ ...request, model });
      }
      throw error;
    }
  }

  private async selectBestBackend(model: string, request: ChatRequest): Promise<LLMBackend> {
    // Score backends by:
    // 1. Model availability
    // 2. Current latency
    // 3. Cost
    // 4. Feature support (tools, streaming)

    const scores = await Promise.all(
      Array.from(this.backends.entries()).map(async ([name, backend]) => {
        const health = await backend.health();
        const models = await backend.listModels();
        const hasModel = models.some(m => m.name === model);

        return {
          name,
          backend,
          score: hasModel ? (100 - health.latency + (request.tools ? health.toolSupport * 20 : 0)) : 0,
        };
      })
    );

    return scores.sort((a, b) => b.score - a.score)[0].backend;
  }
}
```

---

### 6. Observability

Full observability stack with OpenTelemetry:

```typescript
// Trace structure
interface AgentTrace {
  traceId: string;
  spanId: string;
  agentId: string;
  startTime: Date;
  endTime: Date;
  status: 'success' | 'error';

  // Hierarchy
  spans: Span[];

  // Metrics
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };

  // Events
  events: TraceEvent[];
}

interface Span {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: Date;
  endTime: Date;
  attributes: Record<string, any>;
}

// Example trace for an agent run
const exampleTrace: AgentTrace = {
  traceId: 'abc123',
  spans: [
    { name: 'agent.run', duration: 2500 },
    { name: 'memory.retrieve', duration: 50, parent: 'agent.run' },
    { name: 'llm.chat', duration: 1800, parent: 'agent.run', attributes: { model: 'llama3.2', tokens: 1500 } },
    { name: 'tool.execute', duration: 200, parent: 'agent.run', attributes: { tool: 'search_web' } },
    { name: 'llm.chat', duration: 400, parent: 'agent.run', attributes: { model: 'llama3.2', tokens: 500 } },
  ],
  usage: {
    inputTokens: 1500,
    outputTokens: 500,
    cost: 0.002,
  },
};
```

#### Metrics Collection

```typescript
// Key metrics tracked
const metrics = {
  // Counters
  'cogitator.agent.runs.total': Counter,
  'cogitator.agent.runs.failed': Counter,
  'cogitator.llm.requests.total': Counter,
  'cogitator.tool.executions.total': Counter,

  // Histograms
  'cogitator.agent.run.duration': Histogram,
  'cogitator.llm.latency': Histogram,
  'cogitator.tool.execution.duration': Histogram,

  // Gauges
  'cogitator.workers.active': Gauge,
  'cogitator.queue.depth': Gauge,
  'cogitator.memory.usage.bytes': Gauge,
};
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
      - "3000:3000"
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
  name: cogitator-gateway
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: gateway
          image: cogitator/gateway:latest
          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"

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
              memory: "2Gi"
              cpu: "2"
            limits:
              nvidia.com/gpu: 1  # For local inference
```

---

## Security Model

### Authentication

```typescript
// Multiple auth methods supported
interface AuthConfig {
  methods: {
    // API key (simple)
    apiKey: {
      enabled: boolean;
      header: string;  // X-API-Key
    };

    // JWT (recommended)
    jwt: {
      enabled: boolean;
      issuer: string;
      audience: string;
      jwksUrl: string;
    };

    // OAuth2/OIDC (enterprise)
    oidc: {
      enabled: boolean;
      provider: string;
      clientId: string;
      clientSecret: string;
    };
  };
}
```

### RBAC

```typescript
// Role-based access control
interface RBACPolicy {
  roles: {
    admin: Permission[];
    developer: Permission[];
    viewer: Permission[];
  };
}

type Permission =
  | 'agents:create'
  | 'agents:read'
  | 'agents:update'
  | 'agents:delete'
  | 'runs:create'
  | 'runs:read'
  | 'runs:cancel'
  | 'tools:register'
  | 'tools:execute'
  | 'admin:*';
```

### Audit Logging

```typescript
// All sensitive operations are logged
interface AuditLog {
  timestamp: Date;
  actor: {
    type: 'user' | 'service' | 'agent';
    id: string;
  };
  action: string;
  resource: {
    type: string;
    id: string;
  };
  result: 'success' | 'failure';
  metadata: Record<string, any>;
}
```

---

## Performance Benchmarks (Target)

| Metric | Target | Notes |
|--------|--------|-------|
| Gateway latency (p50) | < 5ms | Excluding LLM time |
| Gateway latency (p99) | < 20ms | |
| Concurrent agents | 10,000+ | Per node |
| Memory retrieval | < 10ms | With proper indexing |
| Tool execution (WASM) | < 5ms | Excluding tool logic |
| Tool execution (Docker) | < 200ms | Cold start |
| Trace export | < 1ms | Async batching |

---

## References

- [OpenAI Assistants API](https://platform.openai.com/docs/assistants/overview)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [OpenTelemetry](https://opentelemetry.io/)
- [BullMQ](https://docs.bullmq.io/)
- [Extism (WASM)](https://extism.org/)
- [pgvector](https://github.com/pgvector/pgvector)
