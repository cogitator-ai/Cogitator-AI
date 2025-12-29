# API Reference

> Complete API documentation for Cogitator

## Core Classes

### Cogitator

The main entry point for running agents.

```typescript
import { Cogitator } from '@cogitator/core';

const cog = new Cogitator(config?: CogitatorConfig);
```

#### CogitatorConfig

```typescript
interface CogitatorConfig {
  // LLM configuration
  llm?: {
    defaultProvider?: 'ollama' | 'openai' | 'anthropic' | 'google' | 'vllm';
    defaultModel?: string;
    providers?: {
      ollama?: { baseUrl: string };
      openai?: { apiKey: string; baseUrl?: string };
      anthropic?: { apiKey: string };
      google?: { apiKey: string };
      vllm?: { baseUrl: string };
    };
  };

  // Memory configuration
  memory?: {
    redis?: { url: string; prefix?: string };
    postgres?: { connectionString: string; poolSize?: number };
    embeddings?: {
      provider: 'openai' | 'local';
      model?: string;
      dimensions?: number;
    };
  };

  // Sandbox configuration
  sandbox?: {
    type: 'docker' | 'wasm' | 'none';
    docker?: { socketPath?: string };
    wasm?: { runtime?: 'extism' };
  };

  // Observability
  telemetry?: {
    enabled?: boolean;
    exporter?: 'console' | 'otlp' | 'jaeger';
    endpoint?: string;
  };

  // Resource limits
  limits?: {
    maxConcurrentRuns?: number;
    defaultTimeout?: number;
    maxTokensPerRun?: number;
  };
}
```

#### Methods

```typescript
class Cogitator {
  // Run an agent
  run(agent: Agent, options: RunOptions): Promise<RunResult>;

  // Run a workflow
  workflow(workflow: Workflow): WorkflowRunner;

  // Run a swarm
  swarm(swarm: Swarm): SwarmRunner;

  // Tool registry
  tools: ToolRegistry;

  // Memory manager
  memory: MemoryManager;

  // Event emitter
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;

  // Shutdown
  close(): Promise<void>;
}
```

#### RunOptions

```typescript
interface RunOptions {
  // Input to the agent
  input: string;

  // Additional context
  context?: Record<string, any>;

  // Thread/conversation ID (for memory)
  threadId?: string;

  // Override agent timeout
  timeout?: number;

  // Stream responses
  stream?: boolean;

  // Callbacks
  onToken?: (token: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
}
```

#### RunResult

```typescript
interface RunResult {
  // Final output
  output: string;

  // Structured output (if responseFormat specified)
  structured?: any;

  // Run metadata
  runId: string;
  agentId: string;
  threadId: string;

  // Usage statistics
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };

  // Execution trace
  trace: {
    traceId: string;
    spans: Span[];
  };

  // Tool calls made
  toolCalls: ToolCall[];

  // Messages in conversation
  messages: Message[];
}
```

---

### Agent

Represents a configured LLM agent.

```typescript
import { Agent } from '@cogitator/core';

const agent = new Agent(config: AgentConfig);
```

#### AgentConfig

```typescript
interface AgentConfig {
  // Identity
  name: string;
  description?: string;

  // Model
  model: string; // e.g., 'ollama/llama3.2:70b', 'openai/gpt-4o'
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];

  // Behavior
  instructions: string;
  tools?: Tool[];
  responseFormat?: ResponseFormat;

  // Memory
  memory?: MemoryConfig | boolean;

  // Execution
  maxIterations?: number;
  timeout?: number;

  // Sandbox
  sandbox?: SandboxConfig;

  // Hooks
  hooks?: AgentHooks;
}
```

#### ResponseFormat

```typescript
type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; schema: ZodSchema | JSONSchema };
```

#### AgentHooks

```typescript
interface AgentHooks {
  onStart?: (context: HookContext) => Promise<void>;
  beforeLLM?: (messages: Message[]) => Promise<Message[]>;
  afterLLM?: (response: LLMResponse) => Promise<LLMResponse>;
  beforeTool?: (call: ToolCall) => Promise<ToolCall>;
  afterTool?: (result: ToolResult) => Promise<ToolResult>;
  onComplete?: (result: RunResult) => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}
```

#### Methods

```typescript
class Agent {
  // Get agent ID
  readonly id: string;

  // Get configuration
  readonly config: AgentConfig;

  // Clone with modifications
  clone(overrides: Partial<AgentConfig>): Agent;

  // Serialize to YAML
  toYAML(): string;

  // Load from YAML
  static fromYAML(yaml: string): Agent;
}
```

---

### Tool

Represents a capability an agent can use.

```typescript
import { tool } from '@cogitator/core';
import { z } from 'zod';

const myTool = tool(config: ToolConfig);
```

#### ToolConfig

```typescript
interface ToolConfig<TParams = any, TResult = any> {
  // Identity
  name: string;
  description: string;

  // Parameters (Zod schema)
  parameters: ZodSchema<TParams>;

  // Execution
  execute: (params: TParams, context: ToolContext) => Promise<TResult>;

  // Optional metadata
  sideEffects?: ('filesystem' | 'network' | 'database' | 'process')[];
  requiresApproval?: boolean | ((params: TParams) => boolean);

  // Error handling
  retry?: RetryConfig;
  timeout?: number;

  // Sandbox
  sandbox?: SandboxConfig;
}
```

#### ToolContext

```typescript
interface ToolContext {
  // Agent that called this tool
  agentId: string;
  runId: string;

  // Access to other tools
  tools: ToolRegistry;

  // Access to memory
  memory: MemoryManager;

  // Swarm context (if in a swarm)
  swarm?: SwarmContext;

  // Report progress
  progress: {
    report(update: ProgressUpdate): void;
  };

  // Abort signal
  signal: AbortSignal;
}
```

#### Built-in Tools

```typescript
import {
  // Filesystem
  fileRead,
  fileWrite,
  fileDelete,
  fileList,
  fileSearch,

  // Web
  webFetch,
  webSearch,
  webScreenshot,

  // Code execution
  codeInterpreter,

  // Database
  sqlQuery,
  sqlExecute,

  // Utilities
  calculator,
  datetime,
} from '@cogitator/tools';
```

---

### Workflow

Define multi-step agent orchestration.

```typescript
import { Workflow, step } from '@cogitator/workflows';

const workflow = new Workflow(config: WorkflowConfig);
```

#### WorkflowConfig

```typescript
interface WorkflowConfig {
  name: string;
  description?: string;

  // Steps
  steps: Step[];

  // Triggers
  triggers?: Trigger[];

  // Persistence
  persistence?: {
    store: 'memory' | 'redis' | 'postgres';
    checkpointInterval?: 'after-each-step' | 'on-completion';
  };

  // Error handling
  onError?: 'abort' | 'compensate' | ErrorHandler;

  // Observability
  dashboard?: {
    enabled: boolean;
    tags?: string[];
  };
}
```

#### Step

```typescript
function step(name: string, config: StepConfig): Step;

interface StepConfig {
  // Step type
  type?: 'agent' | 'tool' | 'function' | 'human' | 'delay' | 'subworkflow' | 'map' | 'goto';

  // For agent steps
  agent?: Agent;
  input?: (ctx: WorkflowContext) => any;

  // For tool steps
  tool?: Tool;

  // For function steps
  execute?: (ctx: WorkflowContext) => Promise<any>;

  // For human steps
  prompt?: (ctx: WorkflowContext) => string;
  options?: string[];
  assignee?: (ctx: WorkflowContext) => string;

  // For delay steps
  duration?: number;

  // For subworkflow steps
  workflow?: Workflow;

  // For map steps
  items?: (ctx: WorkflowContext) => any[];
  maxConcurrency?: number;

  // For goto steps
  target?: string;

  // Dependencies
  dependsOn?: string[];
  dependencyMode?: 'all' | 'any' | 'completed';

  // Conditions
  condition?: (ctx: WorkflowContext) => boolean;

  // Error handling
  retry?: RetryConfig;
  fallback?: { step: string; condition?: (error: Error) => boolean };
  compensate?: (ctx: WorkflowContext) => Promise<void>;

  // Timeouts
  timeout?: number;

  // Hooks
  onStart?: (ctx: WorkflowContext) => void;
  onComplete?: (result: any, ctx: WorkflowContext) => void;
  onError?: (error: Error, ctx: WorkflowContext) => void;
}
```

#### WorkflowContext

```typescript
interface WorkflowContext<TInput = any> {
  // Original input
  input: TInput;

  // Step results
  steps: Record<string, StepResult>;

  // Shared mutable state
  state: Record<string, any>;

  // Metadata
  meta: {
    workflowId: string;
    runId: string;
    startedAt: Date;
    currentStep: string;
  };
}
```

#### WorkflowRunner

```typescript
interface WorkflowRunner {
  // Execute workflow
  run(input: any): Promise<WorkflowResult>;

  // Schedule for later
  schedule(options: ScheduleOptions): Promise<ScheduledRun>;

  // Resume paused workflow
  resume(runId: string): Promise<WorkflowResult>;

  // Cancel running workflow
  cancel(runId: string): Promise<void>;

  // Get status
  getStatus(runId: string): Promise<RunStatus>;

  // Events
  on(event: string, handler: Function): void;
}
```

---

### Swarm

Multi-agent coordination.

```typescript
import { Swarm } from '@cogitator/swarms';

const swarm = new Swarm(config: SwarmConfig);
```

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
    | 'collaborative';

  // Agents (varies by strategy)
  supervisor?: Agent;
  workers?: Agent[];
  agents?: Agent[];
  stages?: { name: string; agent: Agent }[];
  router?: Agent;
  moderator?: Agent;
  specialists?: Record<string, Agent>;

  // Strategy config
  consensus?: {
    threshold: number;
    maxRounds: number;
    resolution: 'majority' | 'unanimous' | 'weighted';
    onNoConsensus: 'escalate' | 'supervisor-decides' | 'fail';
  };

  auction?: {
    bidding: 'capability-match' | 'custom';
    bidFunction?: (agent: Agent, task: any) => Promise<number>;
    selection: 'highest-bid' | 'weighted-random';
  };

  debate?: {
    rounds: number;
    turnDuration: number;
  };

  // Communication
  messaging?: {
    enabled: boolean;
    protocol: 'direct' | 'broadcast' | 'pub-sub';
    maxMessageLength?: number;
    maxMessagesPerTurn?: number;
  };

  blackboard?: {
    enabled: boolean;
    sections: Record<string, any>;
  };

  // Resources
  resources?: {
    maxConcurrency: number;
    tokenBudget: number;
    costLimit: number;
    timeout: number;
  };

  // Error handling
  errorHandling?: {
    onAgentFailure: 'retry' | 'skip' | 'failover' | 'abort';
    retry?: RetryConfig;
    failover?: Record<string, string>;
    circuitBreaker?: {
      enabled: boolean;
      threshold: number;
      resetTimeout: number;
    };
  };

  // Observability
  observability?: {
    tracing: boolean;
    messageLogging: boolean;
    metrics?: { exporter: string };
  };
}
```

---

## Memory API

### MemoryManager

```typescript
interface MemoryManager {
  // Store a memory
  store(memory: Memory): Promise<void>;

  // Retrieve memories
  retrieve(query: RetrievalQuery): Promise<Memory[]>;

  // Build context for LLM
  buildContext(agentId: string, maxTokens: number): Promise<Context>;

  // Summarize old memories
  summarize(agentId: string): Promise<void>;

  // Clear memories
  clear(agentId: string, options?: ClearOptions): Promise<void>;
}
```

### Memory

```typescript
interface Memory {
  id: string;
  agentId: string;
  threadId?: string;
  type: 'message' | 'tool_result' | 'fact' | 'summary';
  content: string;
  embedding?: number[];
  metadata: {
    timestamp: Date;
    importance: number;
    source: string;
    tags: string[];
  };
}
```

### RetrievalQuery

```typescript
interface RetrievalQuery {
  agentId: string;
  query?: string;
  limit: number;
  strategies: ('recency' | 'semantic' | 'importance' | 'hybrid')[];
  filters?: {
    types?: Memory['type'][];
    timeRange?: { start: Date; end: Date };
    tags?: string[];
  };
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
  "model": "llama3.2:latest",
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
  "model": "llama3.2:latest",
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

### Cogitator Events

```typescript
cog.on('run:start', (event: RunStartEvent) => {});
cog.on('run:complete', (event: RunCompleteEvent) => {});
cog.on('run:error', (event: RunErrorEvent) => {});

cog.on('tool:start', (event: ToolStartEvent) => {});
cog.on('tool:complete', (event: ToolCompleteEvent) => {});
cog.on('tool:error', (event: ToolErrorEvent) => {});

cog.on('memory:store', (event: MemoryStoreEvent) => {});
cog.on('memory:retrieve', (event: MemoryRetrieveEvent) => {});
```

### Workflow Events

```typescript
workflow.on('step:start', (event: StepStartEvent) => {});
workflow.on('step:complete', (event: StepCompleteEvent) => {});
workflow.on('step:error', (event: StepErrorEvent) => {});
workflow.on('step:retry', (event: StepRetryEvent) => {});

workflow.on('workflow:start', (event: WorkflowStartEvent) => {});
workflow.on('workflow:complete', (event: WorkflowCompleteEvent) => {});
workflow.on('workflow:error', (event: WorkflowErrorEvent) => {});
```

### Swarm Events

```typescript
swarm.on('agent:start', (event: AgentStartEvent) => {});
swarm.on('agent:complete', (event: AgentCompleteEvent) => {});
swarm.on('agent:error', (event: AgentErrorEvent) => {});

swarm.on('message:sent', (event: MessageSentEvent) => {});
swarm.on('message:received', (event: MessageReceivedEvent) => {});

swarm.on('swarm:start', (event: SwarmStartEvent) => {});
swarm.on('swarm:complete', (event: SwarmCompleteEvent) => {});
```

---

## Error Types

```typescript
import {
  CogitatorError, // Base error class
  AgentError, // Agent execution errors
  ToolError, // Tool execution errors
  MemoryError, // Memory operations errors
  LLMError, // LLM provider errors
  TimeoutError, // Timeout errors
  ValidationError, // Input validation errors
  RateLimitError, // Rate limiting errors
  AuthenticationError, // Auth errors
} from '@cogitator/core';

// Error handling
try {
  await cog.run(agent, { input: '...' });
} catch (error) {
  if (error instanceof ToolError) {
    console.log('Tool failed:', error.toolName, error.message);
  } else if (error instanceof LLMError) {
    console.log('LLM failed:', error.provider, error.message);
  } else if (error instanceof TimeoutError) {
    console.log('Timed out after:', error.timeout, 'ms');
  }
}
```

---

## TypeScript Types

```typescript
// Re-exported from @cogitator/types

export type {
  // Core
  Agent,
  AgentConfig,
  Tool,
  ToolConfig,
  Workflow,
  WorkflowConfig,
  Swarm,
  SwarmConfig,

  // Execution
  RunOptions,
  RunResult,
  StepResult,
  WorkflowResult,
  SwarmResult,

  // Memory
  Memory,
  MemoryConfig,
  RetrievalQuery,
  Context,

  // Messages
  Message,
  ToolCall,
  ToolResult,

  // LLM
  LLMProvider,
  LLMBackend,
  ChatRequest,
  ChatResponse,

  // Observability
  Trace,
  Span,
  Metrics,

  // Events
  CogitatorEvent,
  RunStartEvent,
  RunCompleteEvent,
  // ... etc
};
```
