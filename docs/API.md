# API Reference

> Complete API documentation for Cogitator

## Core Classes

### Cogitator

The main entry point for running agents.

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator(config?: CogitatorConfig);
```

#### CogitatorConfig

```typescript
interface CogitatorConfig {
  llm?: {
    defaultProvider?:
      | 'ollama'
      | 'openai'
      | 'anthropic'
      | 'google'
      | 'azure'
      | 'bedrock'
      | 'vllm'
      | 'mistral'
      | 'groq'
      | 'together'
      | 'deepseek';
    defaultModel?: string;
    providers?: {
      ollama?: { baseUrl: string; apiKey?: string };
      openai?: { apiKey: string; baseUrl?: string };
      anthropic?: { apiKey: string };
      google?: { apiKey: string };
      azure?: { endpoint: string; apiKey: string; apiVersion?: string; deployment?: string };
      bedrock?: { region?: string; accessKeyId?: string; secretAccessKey?: string };
      vllm?: { baseUrl: string };
      mistral?: { apiKey: string };
      groq?: { apiKey: string };
      together?: { apiKey: string };
      deepseek?: { apiKey: string };
    };
  };

  // Memory configuration
  memory?: {
    adapter?: 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant';
    redis?: {
      url?: string;
      host?: string;
      port?: number;
      keyPrefix?: string;
      ttl?: number;
      password?: string;
    };
    postgres?: { connectionString: string; schema?: string; poolSize?: number };
    sqlite?: { path: string; walMode?: boolean };
    mongodb?: { uri: string; database?: string; collectionPrefix?: string };
    qdrant?: { url?: string; apiKey?: string; collection?: string; dimensions: number };
    embedding?:
      | { provider: 'openai'; apiKey: string; model?: string; baseUrl?: string }
      | { provider: 'ollama'; model?: string; baseUrl?: string }
      | { provider: 'google'; apiKey: string; model?: string; dimensions?: number };
    contextBuilder?: {
      maxTokens: number;
      strategy: 'recent' | 'relevant' | 'hybrid';
      reserveTokens?: number;
      includeFacts?: boolean;
      includeSemanticContext?: boolean;
    };
  };

  // Sandbox configuration (from @cogitator-ai/sandbox)
  sandbox?: SandboxManagerConfig;

  // Resource limits
  limits?: {
    maxConcurrentRuns?: number;
    defaultTimeout?: number;
    maxTokensPerRun?: number;
  };

  // Reflection — self-analyzing agents
  reflection?: ReflectionConfig;

  // Constitutional AI guardrails
  guardrails?: GuardrailConfig;

  // Cost-aware model routing
  costRouting?: CostRoutingConfig;

  // Prompt injection detection
  security?: { promptInjection?: PromptInjectionConfig };

  // Context management for long conversations
  context?: ContextManagerConfig;

  // Logging
  logging?: LoggingConfig;
}
```

#### Methods

```typescript
class Cogitator {
  // Run an agent
  run(agent: Agent, options: RunOptions): Promise<RunResult>;

  // Global tool registry shared across all runs
  tools: ToolRegistry;

  // Memory adapter (undefined if memory not configured)
  memory: MemoryAdapter | undefined;

  // Estimate cost before executing
  estimateCost(params: {
    agent: Agent;
    input: string;
    options?: EstimateOptions;
  }): Promise<CostEstimate>;

  // Reflection insights for an agent
  getInsights(agentId: string): Promise<Insight[]>;
  getReflectionSummary(agentId: string): Promise<ReflectionSummary | null>;

  // Constitutional AI guardrails
  getGuardrails(): ConstitutionalAI | undefined;
  setConstitution(constitution: Constitution): void;

  // Cost tracking
  getCostSummary(): CostSummary | undefined;
  getCostRouter(): CostAwareRouter | undefined;

  // Access a specific LLM backend
  getLLMBackend(modelString: string, explicitProvider?: string): LLMBackend;

  // Shutdown
  close(): Promise<void>;
}
```

Note: Cogitator has no event emitter. For observability, use `RunOptions` callbacks (`onToken`, `onToolCall`, `onToolResult`, `onSpan`, `onRunStart`, `onRunComplete`, `onRunError`).

#### RunOptions

```typescript
interface RunOptions {
  // Input to the agent
  input: string;

  // Images to include (URLs or base64 data)
  images?: (
    | string
    | { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  )[];

  // Audio to transcribe and include
  audio?: (
    | string
    | {
        data: string;
        format: 'mp3' | 'mp4' | 'mpeg' | 'mpga' | 'm4a' | 'wav' | 'webm' | 'ogg' | 'flac';
      }
  )[];

  // Additional context injected into system prompt
  context?: Record<string, unknown>;

  // Thread ID for memory persistence
  threadId?: string;

  // Override agent timeout
  timeout?: number;

  // Stream responses
  stream?: boolean;

  // Memory control
  useMemory?: boolean; // default: true if adapter configured
  loadHistory?: boolean; // default: true
  saveHistory?: boolean; // default: true

  // Execute tool calls in parallel (default: false)
  parallelToolCalls?: boolean;

  // Callbacks
  onToken?: (token: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  onRunStart?: (data: { runId: string; agentId: string; input: string; threadId: string }) => void;
  onRunComplete?: (result: RunResult) => void;
  onRunError?: (error: Error, runId: string) => void;
  onSpan?: (span: Span) => void;
  onMemoryError?: (error: Error, operation: 'save' | 'load') => void;
}
```

#### RunResult

```typescript
interface RunResult {
  readonly output: string;
  readonly structured?: unknown;

  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;

  // Actual model used (set when cost routing is enabled)
  readonly modelUsed?: string;

  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly duration: number;
  };

  readonly trace: {
    readonly traceId: string;
    readonly spans: readonly Span[];
  };

  readonly toolCalls: readonly ToolCall[];
  readonly messages: readonly Message[];

  // Reflection data (if reflection is enabled)
  readonly reflections?: readonly Reflection[];
  readonly reflectionSummary?: ReflectionSummary;
}
```

---

### Agent

Represents a configured LLM agent.

```typescript
import { Agent } from '@cogitator-ai/core';

const agent = new Agent(config: AgentConfig);
```

#### AgentConfig

```typescript
interface AgentConfig {
  // Optional stable ID (auto-generated if omitted)
  id?: string;

  // Identity
  name: string;
  description?: string;

  // Model: use 'provider/model' format
  model: string; // e.g., 'ollama/llama3.3:70b', 'openai/gpt-4o', 'anthropic/claude-sonnet-4-5'

  // Explicit provider override (useful for OpenRouter and similar proxies)
  provider?: string;

  temperature?: number; // default: 0.7
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];

  // Behavior
  instructions: string;
  tools?: Tool[];
  responseFormat?: ResponseFormat;

  // Execution limits
  maxIterations?: number; // default: 10
  timeout?: number; // default: 120000 (ms)
}
```

#### ResponseFormat

```typescript
type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; schema: ZodType };
```

Note: `json_schema` only accepts Zod schemas, not raw JSON Schema objects.

#### Methods

```typescript
class Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;
  readonly model: string;
  readonly instructions: string;
  readonly tools: Tool[];

  // Clone with config overrides
  clone(overrides: Partial<AgentConfig>): Agent;

  // Serialize to a JSON-compatible snapshot
  serialize(): AgentSnapshot;

  // Restore from a snapshot
  static deserialize(snapshot: AgentSnapshot, options?: DeserializeOptions): Agent;

  // Validate a snapshot object
  static validateSnapshot(snapshot: unknown): snapshot is AgentSnapshot;
}
```

```typescript
interface DeserializeOptions {
  toolRegistry?: { get(name: string): Tool | undefined };
  tools?: Tool[];
  overrides?: Partial<AgentConfig>;
}
```

---

### Tool

Represents a capability an agent can use.

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const myTool = tool(config: ToolConfig);
```

#### ToolConfig

```typescript
interface ToolConfig<TParams = unknown, TResult = unknown> {
  // Identity
  name: string;
  description: string;

  // Optional categorization
  category?:
    | 'math'
    | 'text'
    | 'file'
    | 'network'
    | 'system'
    | 'utility'
    | 'web'
    | 'database'
    | 'communication'
    | 'development';
  tags?: string[];

  // Parameters (Zod schema)
  parameters: ZodType<TParams>;

  // Execution
  execute: (params: TParams, context: ToolContext) => Promise<TResult>;

  // Optional metadata
  sideEffects?: ('filesystem' | 'network' | 'database' | 'process' | 'external')[];
  requiresApproval?: boolean | ((params: TParams) => boolean);

  timeout?: number;

  // Sandbox configuration (from @cogitator-ai/sandbox)
  sandbox?: SandboxConfig;
}
```

#### ToolContext

```typescript
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal;
}
```

#### Built-in Tools

All built-in tools are exported from `@cogitator-ai/core`:

```typescript
import {
  // Filesystem
  fileRead,
  fileWrite,
  fileDelete,
  fileList,
  fileExists,

  // HTTP
  httpRequest,
  webSearch,
  webScrape,

  // Code execution
  exec,

  // Database
  sqlQuery,
  vectorSearch,

  // Math & utilities
  calculator,
  datetime,
  uuid,
  randomNumber,
  randomString,
  hash,
  base64Encode,
  base64Decode,
  sleep,
  jsonParse,
  jsonStringify,
  regexMatch,
  regexReplace,

  // External services
  sendEmail,
  githubApi,

  // All built-ins as an array
  builtinTools,
} from '@cogitator-ai/core';
```

---

### Workflow

Workflows are DAG-based pipelines built with `WorkflowBuilder` from `@cogitator-ai/workflows`.

```typescript
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  functionNode,
} from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('my-workflow')
  .initialState({ result: '' })
  .addNode(
    'fetch',
    functionNode(async (ctx) => {
      const data = await fetch('...');
      return { state: { result: await data.text() } };
    })
  )
  .addNode('process', agentNode({ agent, input: (ctx) => ctx.state.result }), {
    after: ['fetch'],
  })
  .build();

const executor = new WorkflowExecutor(cog);
const result = await executor.execute(
  workflow,
  {},
  {
    onNodeStart: (node) => console.log('Starting:', node),
    onNodeComplete: (node, output, duration) => console.log('Done:', node),
  }
);
```

#### WorkflowBuilder

```typescript
class WorkflowBuilder<S extends WorkflowState> {
  constructor(name: string);

  // Set initial state
  initialState(state: S): this;

  // Set explicit entry point
  entryPoint(nodeName: string): this;

  // Add a computation node
  addNode(name: string, fn: NodeFn<S>, options?: { after?: string[]; config?: NodeConfig }): this;

  // Add a conditional routing node (returns next node name(s))
  addConditional(
    name: string,
    condition: (state: S) => string | string[],
    options?: { after?: string[] }
  ): this;

  // Add a loop
  addLoop(
    name: string,
    options: {
      condition: (state: S) => boolean;
      back: string;
      exit: string;
      after?: string[];
    }
  ): this;

  // Add a parallel fan-out
  addParallel(name: string, targets: string[], options?: { after?: string[] }): this;

  // Build and validate the workflow
  build(): Workflow<S>;
}
```

#### Node helpers

```typescript
import { agentNode, toolNode, functionNode } from '@cogitator-ai/workflows';

// Run an agent as a node
agentNode(options: { agent: Agent; input?: (ctx: NodeContext) => string }): NodeFn

// Run a tool as a node
toolNode(options: { tool: Tool; params?: (ctx: NodeContext) => unknown }): NodeFn

// Run a plain function as a node
functionNode(fn: (ctx: NodeContext) => Promise<NodeResult>): NodeFn
```

#### WorkflowExecutor

```typescript
class WorkflowExecutor {
  constructor(cogitator: Cogitator, checkpointStore?: CheckpointStore);

  execute<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>>;
}
```

#### WorkflowExecuteOptions

```typescript
interface WorkflowExecuteOptions {
  maxConcurrency?: number;
  maxIterations?: number;
  checkpoint?: boolean;
  checkpointStrategy?: 'per-iteration' | 'per-node';
  onNodeStart?: (node: string) => void;
  onNodeComplete?: (node: string, result: unknown, duration: number) => void;
  onNodeError?: (node: string, error: Error) => void;
  onNodeProgress?: (node: string, progress: number) => void;
}
```

#### NodeContext

```typescript
interface NodeContext<S = WorkflowState> {
  state: S;
  input?: unknown;
  nodeId: string;
  workflowId: string;
  step: number;
  reportProgress?: (progress: number) => void;
}
```

#### WorkflowResult

```typescript
interface WorkflowResult<S = WorkflowState> {
  workflowId: string;
  workflowName: string;
  state: S;
  nodeResults: Map<string, { output: unknown; duration: number }>;
  duration: number;
  checkpointId?: string;
  error?: Error;
}
```

---

### Swarm

Multi-agent coordination.

```typescript
import { Swarm, swarm } from '@cogitator-ai/swarms';

// Using SwarmBuilder (recommended)
const s = swarm('my-swarm')
  .strategy('hierarchical')
  .supervisor(supervisorAgent)
  .workers([worker1, worker2])
  .build(cog);

// Or directly
const s = new Swarm(cog, config: SwarmConfig);
```

Note: `Swarm` constructor takes `Cogitator` as first argument.

#### SwarmConfig

```typescript
interface SwarmConfig {
  name: string;

  // Strategy
  strategy:
    | 'hierarchical'
    | 'round-robin'
    | 'consensus'
    | 'auction'
    | 'pipeline'
    | 'debate'
    | 'negotiation';

  // Agents (varies by strategy)
  supervisor?: Agent; // hierarchical
  workers?: Agent[]; // hierarchical
  agents?: Agent[]; // round-robin, consensus, auction, debate
  moderator?: Agent; // debate
  router?: Agent; // custom routing

  // Strategy-specific config
  hierarchical?: {
    maxDelegationDepth?: number;
    workerCommunication?: boolean;
    routeThrough?: 'supervisor' | 'direct';
  };

  roundRobin?: {
    sticky?: boolean;
    rotation?: 'sequential' | 'random';
  };

  consensus?: {
    threshold: number;
    maxRounds: number;
    resolution: 'majority' | 'unanimous' | 'weighted';
    onNoConsensus: 'escalate' | 'supervisor-decides' | 'fail';
    weights?: Record<string, number>;
  };

  auction?: {
    bidding: 'capability-match' | 'custom';
    bidFunction?: (agent: SwarmAgent, task: string) => Promise<number> | number;
    selection: 'highest-bid' | 'weighted-random';
    minBid?: number;
  };

  pipeline?: {
    stages: { name: string; agent: Agent; gate?: boolean }[];
  };

  debate?: {
    rounds: number;
    turnDuration?: number;
    format?: 'structured' | 'freeform';
  };

  // Agent communication
  messaging?: {
    enabled: boolean;
    protocol: 'direct' | 'broadcast' | 'pub-sub';
    maxMessageLength?: number;
    maxMessagesPerTurn?: number;
  };

  blackboard?: {
    enabled: boolean;
    sections: Record<string, unknown>;
    locking?: boolean;
    trackHistory?: boolean;
  };

  // Resources
  resources?: {
    maxConcurrency?: number;
    tokenBudget?: number;
    costLimit?: number;
    timeout?: number;
  };

  // Error handling
  errorHandling?: {
    onAgentFailure: 'retry' | 'skip' | 'failover' | 'abort';
    retry?: {
      maxRetries: number;
      backoff: 'constant' | 'linear' | 'exponential';
      initialDelay?: number;
      maxDelay?: number;
    };
    failover?: Record<string, string>;
    circuitBreaker?: {
      enabled: boolean;
      threshold: number;
      resetTimeout: number;
    };
  };

  // Observability
  observability?: {
    tracing?: boolean;
    messageLogging?: boolean;
    blackboardLogging?: boolean;
  };
}
```

#### Swarm methods

```typescript
class Swarm {
  run(options: SwarmRunOptions): Promise<StrategyResult>;
  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  getAgents(): SwarmAgent[];
  getAgent(name: string): SwarmAgent | undefined;
  getResourceUsage(): SwarmResourceUsage;
  pause(): void;
  resume(): void;
  abort(): void;
  reset(): void;
  close(): Promise<void>;

  // Accessors
  readonly name: string;
  readonly id: string;
  readonly messageBus: MessageBus;
  readonly blackboard: Blackboard;
  readonly events: SwarmEventEmitter;
}
```

---

## Memory API

### MemoryAdapter

The core memory interface implemented by all adapters.

```typescript
interface MemoryAdapter {
  readonly provider: 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant';

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

  // Lifecycle
  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}
```

### MemoryEntry

```typescript
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
```

### MemoryQueryOptions

```typescript
interface MemoryQueryOptions {
  threadId: string;
  limit?: number;
  before?: Date;
  after?: Date;
  includeToolCalls?: boolean;
}
```

---

## REST API

When running as a server, Cogitator exposes these HTTP endpoints.

### Authentication

```http
# API Key
GET /api/agents HTTP/1.1
Authorization: Bearer cog_xxx

# JWT
GET /api/agents HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### Agents

```http
# List agents
GET /api/agents

# Create agent
POST /api/agents
Content-Type: application/json

{
  "name": "my-agent",
  "model": "ollama/llama3.3:latest",
  "instructions": "You are a helpful assistant."
}

# Get agent
GET /api/agents/:id

# Update agent
PATCH /api/agents/:id
Content-Type: application/json

{
  "temperature": 0.5
}

# Delete agent
DELETE /api/agents/:id
```

### Runs

```http
# Create run
POST /api/runs
Content-Type: application/json

{
  "agentId": "agent_xxx",
  "input": "Hello, world!"
}

# Stream run
POST /api/runs
Content-Type: application/json
Accept: text/event-stream

{
  "agentId": "agent_xxx",
  "input": "Hello, world!",
  "stream": true
}

# Get run
GET /api/runs/:id

# List runs
GET /api/runs?agentId=agent_xxx&limit=10

# Cancel run
POST /api/runs/:id/cancel
```

### Threads

```http
# Create thread
POST /api/threads

# Get thread
GET /api/threads/:id

# List messages in thread
GET /api/threads/:id/messages

# Add message to thread
POST /api/threads/:id/messages
Content-Type: application/json

{
  "role": "user",
  "content": "Hello!"
}

# Delete thread
DELETE /api/threads/:id
```

### OpenAI-Compatible Endpoints

```http
# Chat completions
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "ollama/llama3.3:latest",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ]
}

# Assistants (OpenAI Assistants API compatible)
POST /v1/assistants
GET /v1/assistants/:id
POST /v1/threads
POST /v1/threads/:id/messages
POST /v1/threads/:id/runs
```

---

## Events

### Run Observability

Cogitator has no event emitter. Subscribe via `RunOptions` callbacks:

```typescript
const result = await cog.run(agent, {
  input: 'hello',
  onRunStart: ({ runId, agentId, input, threadId }) => {},
  onToken: (token) => process.stdout.write(token),
  onToolCall: (call: ToolCall) => console.log('Tool:', call.name),
  onToolResult: (result: ToolResult) => {},
  onSpan: (span: Span) => {},
  onRunComplete: (result: RunResult) => {},
  onRunError: (error: Error, runId: string) => {},
  onMemoryError: (error: Error, operation: 'save' | 'load') => {},
});
```

### Workflow Events

Subscribe via `WorkflowExecuteOptions`:

```typescript
const result = await executor.execute(
  workflow,
  {},
  {
    onNodeStart: (node: string) => {},
    onNodeComplete: (node: string, result: unknown, duration: number) => {},
    onNodeError: (node: string, error: Error) => {},
    onNodeProgress: (node: string, progress: number) => {},
  }
);
```

### Swarm Events

```typescript
const unsubscribe = swarm.on('agent:start', (event: SwarmEvent) => {});
swarm.on('agent:complete', (event: SwarmEvent) => {});
swarm.on('agent:error', (event: SwarmEvent) => {});

swarm.on('message:sent', (event: SwarmEvent) => {});
swarm.on('message:received', (event: SwarmEvent) => {});

swarm.on('swarm:start', (event: SwarmEvent) => {});
swarm.on('swarm:complete', (event: SwarmEvent) => {});
swarm.on('swarm:error', (event: SwarmEvent) => {});
swarm.on('swarm:paused', (event: SwarmEvent) => {});
swarm.on('swarm:aborted', (event: SwarmEvent) => {});

// Subscribe to all events
swarm.on('*', (event: SwarmEvent) => {});

// Returns an unsubscribe function
unsubscribe();
```

---

## Error Types

Cogitator uses a single `CogitatorError` class with typed error codes:

```typescript
import { CogitatorError, ErrorCode } from '@cogitator-ai/core';

try {
  await cog.run(agent, { input: '...' });
} catch (error) {
  if (error instanceof CogitatorError) {
    switch (error.code) {
      case ErrorCode.TOOL_EXECUTION_FAILED:
        console.log('Tool failed:', error.message, error.details);
        break;
      case ErrorCode.LLM_UNAVAILABLE:
        console.log('LLM unavailable:', error.message);
        if (error.retryable) console.log('Retry after:', error.retryAfter, 'ms');
        break;
      case ErrorCode.LLM_RATE_LIMITED:
        console.log('Rate limited');
        break;
      case ErrorCode.LLM_TIMEOUT:
        console.log('LLM timed out');
        break;
      case ErrorCode.MEMORY_UNAVAILABLE:
        console.log('Memory error:', error.message);
        break;
    }
  }
}
```

#### ErrorCode

```typescript
enum ErrorCode {
  // LLM errors
  LLM_UNAVAILABLE,
  LLM_RATE_LIMITED,
  LLM_TIMEOUT,
  LLM_INVALID_RESPONSE,
  LLM_CONTEXT_LENGTH_EXCEEDED,
  LLM_CONTENT_FILTERED,

  // Tool errors
  TOOL_NOT_FOUND,
  TOOL_INVALID_ARGS,
  TOOL_EXECUTION_FAILED,
  TOOL_TIMEOUT,

  // Memory errors
  MEMORY_UNAVAILABLE,
  MEMORY_WRITE_FAILED,
  MEMORY_READ_FAILED,

  // Agent errors
  AGENT_NOT_FOUND,
  AGENT_ALREADY_RUNNING,
  AGENT_MAX_ITERATIONS,

  // Workflow errors
  WORKFLOW_NOT_FOUND,
  WORKFLOW_STEP_FAILED,
  WORKFLOW_CYCLE_DETECTED,

  // Swarm errors
  SWARM_NO_WORKERS,
  SWARM_CONSENSUS_FAILED,

  // Security
  PROMPT_INJECTION_DETECTED,

  // General
  VALIDATION_ERROR,
  CONFIGURATION_ERROR,
  INTERNAL_ERROR,
  NOT_IMPLEMENTED,
  CIRCUIT_OPEN,
}
```

#### CogitatorError

```typescript
class CogitatorError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number; // HTTP status code
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly retryAfter?: number; // ms to wait before retrying
  readonly cause?: Error;

  toJSON(): Record<string, unknown>;
  static isCogitatorError(error: unknown): error is CogitatorError;
  static wrap(error: unknown, code?: ErrorCode): CogitatorError;
}
```

---

## TypeScript Types

Key types re-exported from `@cogitator-ai/types`:

```typescript
// Re-exported from @cogitator-ai/types

export type {
  // Core
  AgentConfig,
  ResponseFormat,
  Tool,
  ToolConfig,
  ToolContext,
  ToolSchema,

  // Execution
  RunOptions,
  RunResult,
  Span,

  // Workflow
  Workflow,
  WorkflowState,
  WorkflowNode,
  WorkflowResult,
  WorkflowExecuteOptions,
  NodeContext,
  NodeResult,
  NodeFn,
  Edge,
  RetryConfig,

  // Swarm
  SwarmConfig,
  SwarmRunOptions,
  SwarmResult,
  SwarmStrategy,
  SwarmEvent,
  SwarmEventType,

  // Memory
  MemoryConfig,
  MemoryEntry,
  MemoryQueryOptions,
  Thread,

  // Messages
  Message,
  ToolCall,
  ToolResult,

  // LLM
  LLMProvider,
  LLMBackend,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,

  // Config
  CogitatorConfig,
};
```
