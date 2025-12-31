# @cogitator-ai/types

[![npm version](https://img.shields.io/npm/v/@cogitator-ai/types.svg)](https://www.npmjs.com/package/@cogitator-ai/types)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Shared TypeScript types for the Cogitator AI agent runtime.

## Installation

```bash
pnpm add @cogitator-ai/types
```

## Quick Start

```typescript
import type {
  Agent,
  AgentConfig,
  Tool,
  ToolConfig,
  Message,
  RunResult,
  CogitatorConfig,
} from '@cogitator-ai/types';
```

## Type Categories

| Category                          | Description                             |
| --------------------------------- | --------------------------------------- |
| [Message](#message-types)         | Chat messages, tool calls, tool results |
| [Tool](#tool-types)               | Tool definitions with Zod schemas       |
| [Agent](#agent-types)             | Agent configuration and interface       |
| [LLM](#llm-types)                 | LLM backend and provider types          |
| [Runtime](#runtime-types)         | Cogitator config, run options, results  |
| [Errors](#error-types)            | Structured error handling               |
| [Reflection](#reflection-types)   | Self-analyzing agent types              |
| [Reasoning](#reasoning-types)     | Tree-of-Thought reasoning               |
| [Learning](#learning-types)       | DSPy-style optimization                 |
| [Time Travel](#time-travel-types) | Execution debugging                     |

---

## Message Types

Types for LLM conversations and tool interactions.

```typescript
import type {
  Message,
  MessageRole,
  ToolCall,
  ToolResult,
  ToolCallMessage,
  ToolResultMessage,
} from '@cogitator-ai/types';

// Basic message
const userMessage: Message = {
  role: 'user',
  content: 'What is 2 + 2?',
};

// Assistant message with tool calls
const assistantMessage: ToolCallMessage = {
  role: 'assistant',
  content: '',
  toolCalls: [
    {
      id: 'call_123',
      name: 'calculator',
      arguments: { expression: '2 + 2' },
    },
  ],
};

// Tool result message
const toolResult: ToolResultMessage = {
  role: 'tool',
  content: '4',
  toolCallId: 'call_123',
  name: 'calculator',
};
```

### Message Interfaces

| Type                | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `MessageRole`       | `'system' \| 'user' \| 'assistant' \| 'tool'`             |
| `Message`           | Base message with role, content, optional name/toolCallId |
| `ToolCallMessage`   | Assistant message containing tool calls                   |
| `ToolResultMessage` | Tool execution result                                     |
| `ToolCall`          | Tool invocation with id, name, arguments                  |
| `ToolResult`        | Tool execution result with callId, name, result, error    |

---

## Tool Types

Types for defining agent tools with Zod schemas.

```typescript
import type { Tool, ToolConfig, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { z } from 'zod';

// Tool configuration
const calculatorConfig: ToolConfig<{ expression: string }, number> = {
  name: 'calculator',
  description: 'Evaluate mathematical expressions',
  category: 'math',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async (params, context) => {
    console.log(`Run ${context.runId} executing calculator`);
    return eval(params.expression);
  },
  timeout: 5000,
  sideEffects: [],
};

// Tool context available during execution
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal;
}
```

### Tool Interfaces

| Type                           | Description                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| `ToolConfig<TParams, TResult>` | Tool definition with execute function                              |
| `Tool<TParams, TResult>`       | Full tool with toJSON() method                                     |
| `ToolContext`                  | Execution context with agentId, runId, signal                      |
| `ToolSchema`                   | JSON Schema representation for LLM                                 |
| `ToolCategory`                 | `'math' \| 'text' \| 'file' \| 'network' \| 'system' \| 'utility'` |

### Tool Options

```typescript
const advancedTool: ToolConfig = {
  name: 'file_write',
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async (params) => {
    /* ... */
  },

  // Optional configuration
  category: 'file',
  tags: ['io', 'filesystem'],
  sideEffects: ['filesystem'],
  requiresApproval: true, // or (params) => params.path.includes('/etc')
  timeout: 10000,
  sandbox: { type: 'docker', image: 'node:20' },
};
```

---

## Agent Types

Types for agent configuration.

```typescript
import type { Agent, AgentConfig, ResponseFormat } from '@cogitator-ai/types';

const config: AgentConfig = {
  name: 'research-agent',
  model: 'openai/gpt-4o',
  instructions: 'You are a research assistant...',

  // Optional settings
  description: 'Helps with research tasks',
  tools: [calculatorTool],
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  stopSequences: ['END'],
  maxIterations: 10,
  timeout: 60000,

  // Response format
  responseFormat: { type: 'json' },
};

// Response format options
const textFormat: ResponseFormat = { type: 'text' };
const jsonFormat: ResponseFormat = { type: 'json' };
const schemaFormat: ResponseFormat = {
  type: 'json_schema',
  schema: z.object({ answer: z.string() }),
};
```

---

## LLM Types

Types for LLM backends and providers.

```typescript
import type {
  LLMProvider,
  LLMConfig,
  LLMBackend,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator-ai/types';

// Supported providers
type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'google' | 'vllm';

// LLM configuration
const llmConfig: LLMConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 0.7,
  maxTokens: 4096,
};

// Chat request
const request: ChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [{ name: 'calc', description: '...', parameters: { type: 'object', properties: {} } }],
  stream: true,
};

// Chat response
const response: ChatResponse = {
  id: 'chatcmpl-123',
  content: 'Hello! How can I help?',
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
};
```

---

## Runtime Types

Types for Cogitator runtime configuration and execution.

```typescript
import type { CogitatorConfig, RunOptions, RunResult, Span } from '@cogitator-ai/types';

// Cogitator configuration
const config: CogitatorConfig = {
  llm: {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4o',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
      ollama: { baseUrl: 'http://localhost:11434' },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    },
  },
  limits: {
    maxConcurrentRuns: 10,
    defaultTimeout: 30000,
    maxTokensPerRun: 100000,
  },
  memory: { type: 'redis', redis: { host: 'localhost' } },
  sandbox: { type: 'docker', image: 'node:20-alpine' },
  reflection: { enabled: true, reflectAfterError: true },
};

// Run options with callbacks
const runOptions: RunOptions = {
  input: 'Calculate 2 + 2',
  context: { userId: '123' },
  threadId: 'thread_abc',
  timeout: 30000,
  stream: true,

  // Callbacks
  onToken: (token) => process.stdout.write(token),
  onToolCall: (call) => console.log('Tool called:', call.name),
  onToolResult: (result) => console.log('Tool result:', result.result),
  onRunStart: ({ runId }) => console.log('Started:', runId),
  onRunComplete: (result) => console.log('Done:', result.output),
  onRunError: (error) => console.error('Error:', error),
  onSpan: (span) => console.log('Span:', span.name),

  // Memory options
  useMemory: true,
  loadHistory: true,
  saveHistory: true,
};
```

### RunResult

```typescript
const result: RunResult = {
  output: 'The answer is 4',
  structured: { answer: 4 }, // if responseFormat was json_schema
  runId: 'run_123',
  agentId: 'agent_456',
  threadId: 'thread_789',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cost: 0.0023,
    duration: 1500,
  },
  toolCalls: [{ id: 'call_1', name: 'calculator', arguments: { expression: '2+2' } }],
  messages: [
    /* conversation history */
  ],
  trace: {
    traceId: 'trace_abc',
    spans: [
      /* execution spans */
    ],
  },
  reflections: [
    /* if reflection enabled */
  ],
  reflectionSummary: {
    /* summary stats */
  },
};
```

---

## Error Types

Structured error handling with typed error codes.

```typescript
import {
  CogitatorError,
  ErrorCode,
  ERROR_STATUS_CODES,
  isRetryableError,
  getRetryDelay,
} from '@cogitator-ai/types';

// Create a structured error
const error = new CogitatorError({
  message: 'LLM backend unavailable',
  code: ErrorCode.LLM_UNAVAILABLE,
  details: { provider: 'openai', endpoint: 'https://api.openai.com' },
  retryable: true,
  retryAfter: 5000,
});

// Check error type
if (CogitatorError.isCogitatorError(error)) {
  console.log(error.code); // 'LLM_UNAVAILABLE'
  console.log(error.statusCode); // 503
  console.log(error.retryable); // true
}

// Wrap any error
const wrapped = CogitatorError.wrap(new Error('timeout'), ErrorCode.LLM_TIMEOUT);

// Check if retryable
if (isRetryableError(error)) {
  const delay = getRetryDelay(error, 1000);
  await sleep(delay);
}
```

### Error Codes

| Domain   | Codes                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| LLM      | `LLM_UNAVAILABLE`, `LLM_RATE_LIMITED`, `LLM_TIMEOUT`, `LLM_INVALID_RESPONSE`, `LLM_CONTEXT_LENGTH_EXCEEDED`, `LLM_CONTENT_FILTERED` |
| Sandbox  | `SANDBOX_UNAVAILABLE`, `SANDBOX_TIMEOUT`, `SANDBOX_OOM`, `SANDBOX_EXECUTION_FAILED`, `SANDBOX_INVALID_MODULE`                       |
| Tool     | `TOOL_NOT_FOUND`, `TOOL_INVALID_ARGS`, `TOOL_EXECUTION_FAILED`, `TOOL_TIMEOUT`                                                      |
| Memory   | `MEMORY_UNAVAILABLE`, `MEMORY_WRITE_FAILED`, `MEMORY_READ_FAILED`                                                                   |
| Agent    | `AGENT_NOT_FOUND`, `AGENT_ALREADY_RUNNING`, `AGENT_MAX_ITERATIONS`                                                                  |
| Workflow | `WORKFLOW_NOT_FOUND`, `WORKFLOW_STEP_FAILED`, `WORKFLOW_CYCLE_DETECTED`                                                             |
| Swarm    | `SWARM_NO_WORKERS`, `SWARM_CONSENSUS_FAILED`                                                                                        |
| General  | `VALIDATION_ERROR`, `CONFIGURATION_ERROR`, `INTERNAL_ERROR`, `NOT_IMPLEMENTED`, `CIRCUIT_OPEN`                                      |

---

## Reflection Types

Types for self-analyzing agents that learn from their actions.

```typescript
import type {
  Reflection,
  ReflectionConfig,
  ReflectionAction,
  Insight,
  InsightStore,
  ReflectionSummary,
} from '@cogitator-ai/types';

// Reflection configuration
const reflectionConfig: ReflectionConfig = {
  enabled: true,
  reflectAfterToolCall: true,
  reflectAfterError: true,
  reflectAtEnd: true,
  storeInsights: true,
  maxInsightsPerAgent: 100,
  minConfidenceToStore: 0.7,
  useSmallModelForReflection: true,
  reflectionModel: 'gpt-4o-mini',
};

// Insight types
type InsightType = 'pattern' | 'mistake' | 'success' | 'tip' | 'warning';

// Reflection result
const reflection: Reflection = {
  id: 'ref_123',
  runId: 'run_456',
  agentId: 'agent_789',
  timestamp: new Date(),
  action: {
    type: 'tool_call',
    toolName: 'search',
    input: { query: 'AI news' },
    output: { results: [] },
    duration: 500,
  },
  analysis: {
    wasSuccessful: false,
    confidence: 0.8,
    reasoning: 'Search returned no results, should try broader query',
    whatCouldImprove: 'Use more general search terms',
  },
  insights: [
    {
      id: 'ins_1',
      type: 'tip',
      content: 'Broaden search queries when results are empty',
      context: 'search operations',
      confidence: 0.85,
      /* ... */
    },
  ],
  goal: 'Find recent AI news',
  iterationIndex: 2,
};
```

---

## Reasoning Types

Tree-of-Thought (ToT) reasoning types for branching exploration.

```typescript
import type {
  ToTConfig,
  ThoughtTree,
  ThoughtNode,
  ThoughtBranch,
  ToTResult,
  ExplorationStrategy,
} from '@cogitator-ai/types';

// ToT configuration
const totConfig: ToTConfig = {
  branchFactor: 3, // Generate 3 candidate thoughts per step
  beamWidth: 2, // Keep top 2 branches
  maxDepth: 5, // Max reasoning depth
  explorationStrategy: 'beam', // 'beam' | 'best-first' | 'dfs'

  confidenceThreshold: 0.3,
  terminationConfidence: 0.8,
  maxTotalNodes: 50,
  maxIterationsPerBranch: 3,

  // Callbacks
  onBranchGenerated: (node, branches) => console.log('Generated:', branches.length),
  onBranchEvaluated: (branch, score) => console.log('Score:', score.composite),
  onNodeExplored: (node) => console.log('Explored:', node.id),
  onBacktrack: (from, to) => console.log('Backtracking...'),
};

// Thought branch with proposed action
const branch: ThoughtBranch = {
  id: 'branch_1',
  parentId: 'node_0',
  thought: 'I should search for the latest information first',
  proposedAction: { type: 'tool_call', toolName: 'search', arguments: { query: 'AI news 2024' } },
  score: { confidence: 0.8, progress: 0.3, novelty: 0.6, composite: 0.57, reasoning: '...' },
  messagesSnapshot: [
    /* ... */
  ],
};
```

---

## Learning Types

DSPy-inspired agent optimization types.

```typescript
import type {
  ExecutionTrace,
  TraceStore,
  Demo,
  OptimizerConfig,
  OptimizationResult,
  LearningConfig,
} from '@cogitator-ai/types';

// Learning configuration
const learningConfig: LearningConfig = {
  enabled: true,
  captureTraces: true,
  autoOptimize: true,
  optimizeAfterRuns: 10,
  maxDemosPerAgent: 5,
  minScoreForDemo: 0.8,
  defaultMetrics: ['success', 'tool_accuracy', 'efficiency'],
};

// Optimizer configuration
const optimizerConfig: OptimizerConfig = {
  type: 'full', // 'bootstrap-few-shot' | 'instruction' | 'full'
  maxBootstrappedDemos: 5,
  maxRounds: 3,
  instructionCandidates: 3,
  metricThreshold: 0.7,
  teacherModel: 'gpt-4o',
};

// Execution trace
const trace: ExecutionTrace = {
  id: 'trace_123',
  runId: 'run_456',
  agentId: 'agent_789',
  input: 'Calculate compound interest',
  output: 'The compound interest is $1,628.89',
  steps: [
    /* execution steps */
  ],
  metrics: {
    success: true,
    toolAccuracy: 0.95,
    efficiency: 0.8,
    completeness: 1.0,
  },
  score: 0.92,
  isDemo: true,
  /* ... */
};
```

---

## Time Travel Types

Execution debugging with checkpoints, replay, and forking.

```typescript
import type {
  ExecutionCheckpoint,
  TimeTravelCheckpointStore,
  ReplayOptions,
  ReplayResult,
  ForkOptions,
  TraceDiff,
} from '@cogitator-ai/types';

// Checkpoint
const checkpoint: ExecutionCheckpoint = {
  id: 'cp_123',
  traceId: 'trace_456',
  runId: 'run_789',
  agentId: 'agent_abc',
  stepIndex: 5,
  messages: [
    /* conversation at this point */
  ],
  toolResults: { call_1: 42, call_2: 'result' },
  pendingToolCalls: [],
  label: 'before-critical-decision',
  createdAt: new Date(),
};

// Replay options
const replayOptions: ReplayOptions = {
  fromCheckpoint: 'cp_123',
  mode: 'live', // 'deterministic' | 'live'
  modifiedToolResults: { call_3: 'different_result' },
  skipTools: ['expensive_api'],
  onStep: (step, index) => console.log(`Step ${index}:`, step.type),
  pauseAt: 8,
};

// Fork options (branch execution with modifications)
const forkOptions: ForkOptions = {
  checkpointId: 'cp_123',
  input: 'Try a different approach',
  additionalContext: 'Focus on efficiency',
  mockToolResults: { api_call: { mocked: true } },
  label: 'efficiency-experiment',
};

// Compare two execution traces
const diff: TraceDiff = {
  trace1Id: 'trace_a',
  trace2Id: 'trace_b',
  stepDiffs: [
    { index: 0, status: 'identical' },
    { index: 1, status: 'similar', differences: ['different tool args'] },
    {
      index: 2,
      status: 'different',
      step1: {
        /* ... */
      },
      step2: {
        /* ... */
      },
    },
  ],
  divergencePoint: 2,
  metricsDiff: {
    success: { trace1: true, trace2: false },
    score: { trace1: 0.9, trace2: 0.6, delta: -0.3 },
    /* ... */
  },
};
```

---

## Memory Types

See [@cogitator-ai/memory](../memory) for detailed memory adapter types.

## Sandbox Types

See [@cogitator-ai/sandbox](../sandbox) for detailed sandbox execution types.

## Workflow Types

See [@cogitator-ai/workflows](../workflows) for detailed workflow types.

## Swarm Types

See [@cogitator-ai/swarms](../swarms) for detailed swarm coordination types.

---

## License

MIT
