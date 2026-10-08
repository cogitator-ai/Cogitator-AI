# @cogitator-ai/types

[![npm version](https://img.shields.io/npm/v/@cogitator-ai/types.svg)](https://www.npmjs.com/package/@cogitator-ai/types)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Shared TypeScript types for the Cogitator AI agent runtime.

## Installation

```bash
pnpm add @cogitator-ai/types
```

Types only, plus a few runtime values (`CogitatorError`, `ErrorCode`, `DEFAULT_*` configs). `zod` is a dependency because tool parameters and structured output schemas are Zod types. Most applications get these types re-exported from `@cogitator-ai/core`; install this package directly to implement adapters or stores without the runtime.

Reference on the website: [Types API](https://cogitator.app/docs/api-reference/types).

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

| Category                                          | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| [Message](#message-types)                         | Chat messages, tool calls, tool results  |
| [Tool](#tool-types)                               | Tool definitions with Zod schemas        |
| [Agent](#agent-types)                             | Agent configuration and interface        |
| [LLM](#llm-types)                                 | LLM backend and provider types           |
| [Runtime](#runtime-types)                         | Cogitator config, run options, results   |
| [Errors](#error-types)                            | Structured error handling                |
| [Reflection](#reflection-types)                   | Self-analyzing agent types               |
| [Reasoning](#reasoning-types)                     | Tree-of-Thought reasoning                |
| [Learning](#learning-types)                       | DSPy-style optimization                  |
| [Time Travel](#time-travel-types)                 | Execution debugging                      |
| [Knowledge Graph](#knowledge-graph-types)         | Entity-relationship memory               |
| [Prompt Optimization](#prompt-optimization-types) | A/B testing, monitoring, rollback        |
| [Other Modules](#other-modules)                   | Workflows, swarms, security, RAG, voice… |

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

| Type                | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `MessageRole`       | `'system' \| 'user' \| 'assistant' \| 'tool'`                      |
| `Message`           | Base message with role, content, optional name/toolCallId          |
| `MessageContent`    | `string` or `ContentPart[]` (text, `image_url`, `image_base64`)    |
| `ToolCallMessage`   | Assistant message containing tool calls                            |
| `ToolResultMessage` | Tool execution result                                              |
| `ToolCall`          | Tool invocation with id, name, arguments, thoughtSignature, replay |
| `ToolResult`        | Tool execution result with callId, name, result, error             |

---

## Tool Types

Types for defining agent tools with Zod schemas.

```typescript
import type { ToolConfig } from '@cogitator-ai/types';
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
    return Number(params.expression);
  },
  timeout: 5000,
  sideEffects: [],
};

// Tool context available during execution
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal; // aborted on run cancel or tool timeout
  threadId?: string;
  userId?: string;
  channelType?: string;
  channelId?: string;
}
```

### Tool Interfaces

| Type                           | Description                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `ToolConfig<TParams, TResult>` | Tool definition with execute function                                                                                         |
| `Tool<TParams, TResult>`       | Full tool with toJSON() method                                                                                                |
| `ToolContext`                  | Execution context with agentId, runId, signal, threadId, userId, channel                                                      |
| `SideEffectType`               | `'filesystem' \| 'network' \| 'database' \| 'process' \| 'external'`                                                          |
| `ApprovalCheck`                | `(params) => boolean` form of `requiresApproval`                                                                              |
| `ToolSchema`                   | JSON Schema representation for LLM                                                                                            |
| `ToolCategory`                 | `'math' \| 'text' \| 'file' \| 'network' \| 'system' \| 'utility' \| 'web' \| 'database' \| 'communication' \| 'development'` |

### Tool Options

```typescript
import type { ToolConfig } from '@cogitator-ai/types';
import { z } from 'zod';

const advancedTool: ToolConfig<{ path: string; content: string }, void> = {
  name: 'file_write',
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async ({ path, content }) => {
    console.log(`Writing ${content.length} chars to ${path}`);
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
import type { Agent, AgentConfig, ResponseFormat, Tool } from '@cogitator-ai/types';
import { z } from 'zod';

declare const calculatorTool: Tool;
declare const billingAgent: Agent;

const config: AgentConfig = {
  name: 'research-agent',
  model: 'openai/gpt-6.1-sol',
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

  // Reasoning effort for reasoning models, in one vocabulary for every provider
  reasoning: { effort: 'medium', summary: true },

  // Agents this one can hand the conversation to (transfer_to_<name> tools)
  handoffs: [
    billingAgent,
    { agent: billingAgent, toolName: 'to_billing', description: 'Invoices' },
  ],
};

// Response format options
const textFormat: ResponseFormat = { type: 'text' };
const jsonFormat: ResponseFormat = { type: 'json' };
const schemaFormat: ResponseFormat = {
  type: 'json_schema',
  schema: z.object({ answer: z.string() }),
};
```

`AgentConfig` also takes `id`, `provider` (an explicit backend name) and `skills` (`Skill` bundles of tools and instructions). `AgentSnapshot` / `SerializedAgentConfig` describe the JSON form of `agent.serialize()`.

---

## LLM Types

Types for LLM backends and providers.

```typescript
import type {
  LLMProvider,
  LLMBackendProvider,
  LLMConfig,
  LLMBackend,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  OpenAIProviderConfig,
  ReasoningConfig,
  PromptCacheConfig,
} from '@cogitator-ai/types';

// Supported providers
type LLMProvider =
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

// What LLMBackend.provider reports: a built-in provider, or the name of your
// own backend (llm.backends) or of a registered plugin
type LLMBackendProvider = LLMProvider | (string & {});

// LLM configuration
const llmConfig: LLMConfig = {
  provider: 'openai',
  model: 'gpt-6.1-sol',
  temperature: 0.7,
  maxTokens: 4096,
};

// Chat request
const request: ChatRequest = {
  model: 'gpt-6.1-sol',
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

// Token usage; cached and reasoning tokens are already included in the totals
const usage: ChatUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  totalTokens: 1500,
  cachedInputTokens: 1024,
  reasoningTokens: 120,
};

// OpenAI provider: Responses API for api.openai.com, Chat Completions for other base URLs
const openaiConfig: OpenAIProviderConfig = {
  apiKey: process.env.OPENAI_API_KEY!,
  api: 'chat-completions', // force a wire API: 'responses' | 'chat-completions'
};

// Reasoning effort, mapped per provider (Anthropic effort / thinking, OpenAI reasoning.effort, Gemini thinking, Ollama think)
const reasoning: ReasoningConfig = { effort: 'high', budgetTokens: 8000, summary: true };
// effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Prompt caching for agent runs (CogitatorConfig.llm.promptCache)
const promptCache: PromptCacheConfig = { ttl: '1h' }; // '5m' (default) | '1h'
```

`LLMRetryConfig` (`maxRetries`, `baseDelay`, `maxDelay`, `maxRetryAfter`, `requestTimeout`, `onRetry`) types `CogitatorConfig.llm.retry`; `ModelRoute` is what `cog.route()` resolves a model string to.

`ToolCall.argumentsError` says why the arguments of a call could not be read, such as JSON the provider broke: the call has empty `arguments`, never runs, and the model is told why.

`ToolCall.replay` (`ToolCallReplayState`) carries opaque provider output that must be sent back with the call on the next turn, such as OpenAI Responses reasoning items. It is JSON-serializable, so it survives memory persistence; backends that did not produce it ignore it.

---

## Runtime Types

Types for Cogitator runtime configuration and execution.

```typescript
import type { CogitatorConfig, RunOptions, RunResult, Span } from '@cogitator-ai/types';

// Cogitator configuration
const config: CogitatorConfig = {
  llm: {
    defaultProvider: 'openai',
    defaultModel: 'gpt-6.1-sol',
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
  memory: { adapter: 'redis', redis: { host: 'localhost' } },
  sandbox: { defaults: { type: 'docker', image: 'node:20-alpine' } },
  reflection: { enabled: true, reflectAfterError: true },
  security: {
    promptInjection: { action: 'block' },
    pii: { mode: 'mask', custom: [{ type: 'customer_id', pattern: /CUS-\d{6}/ }] },
  },
  prompts: { autoDeployWinner: true }, // versioned instructions and A/B tests
};

// Run options with callbacks
const runOptions: RunOptions = {
  input: 'Calculate 2 + 2',
  context: { plan: 'pro' },
  threadId: 'thread_abc',
  userId: 'user_123', // owns the thread; reaches tools as context.userId
  threadAccess: 'owner', // or 'shared'
  timeout: 30000,
  stream: true,
  reasoning: { effort: 'low' },

  // Callbacks
  onToken: (token) => process.stdout.write(token),
  onToolCall: (call) => console.log('Tool called:', call.name),
  onToolResult: (result) => console.log('Tool result:', result.result),
  onRunStart: ({ runId }) => console.log('Started:', runId),
  onRunComplete: (result) => console.log('Done:', result.output),
  onRunError: (error) => console.error('Error:', error),
  onSpan: (span) => console.log('Span:', span.name),
  onReasoning: (delta) => process.stdout.write(delta),
  onHandoff: (handoff) => console.log(`${handoff.from} -> ${handoff.to}`),
  onApproval: (request) => (request.toolName === 'refund' ? 'pause' : { approved: true }),

  // Memory options
  useMemory: true,
  loadHistory: true,
  saveHistory: true,
  parallelToolCalls: false,
};
```

### Approvals, Handoffs and Pauses

| Type                   | Description                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `ToolApprovalRequest`  | A tool call waiting for a decision: `toolCallId`, `toolName`, `arguments`, `description`, `sideEffects` |
| `ToolApprovalDecision` | `{ approved: true }` or `{ approved: false; reason? }`                                                  |
| `RunCheckpoint`        | JSON snapshot of a paused run, passed to `cogitator.resume()`                                           |
| `RunCheckpointStore`   | `save` / `load(threadId)` / `delete` for paused runs (`CogitatorConfig.runCheckpoints`)                 |
| `ResumeOptions`        | Run options for `resume()` plus `userId`, `decisions` and `defaultDecision`                             |
| `HandoffEvent`         | `{ from, to, reason? }` for each handoff                                                                |
| `PromptsConfig`        | `versions` / `abTests` stores, `score`, `autoDeployWinner`                                              |
| `RunPrompt`            | The instruction version or A/B variant a run used                                                       |
| `PiiConfig`            | `mode` (`mask` \| `redact` \| `block`), `detect`, `custom`, `onDetect`                                  |

### RunResult

```typescript
import type { RunResult } from '@cogitator-ai/types';

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
  messages: [],
  trace: {
    traceId: 'trace_abc',
    spans: [],
  },
  status: 'completed', // 'paused' when tool calls wait for approval
};
```

Optional fields: `structured`, `modelUsed`, `usage.reasoningTokens` / `cachedInputTokens` / `cacheWriteTokens`, `reasoning`, `prompt`, `handoffs`, `finalAgent`, `status`, `pendingApprovals`, `checkpoint`, `reflections`, `reflectionSummary`. All fields are `readonly`.

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
  const delay = getRetryDelay(error, 1000); // retryAfter, or the default
  await new Promise((resolve) => setTimeout(resolve, delay));
}

console.log(ERROR_STATUS_CODES[ErrorCode.LLM_RATE_LIMITED]); // 429
```

### Error Codes

| Domain   | Codes                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM      | `LLM_UNAVAILABLE`, `LLM_RATE_LIMITED`, `LLM_TIMEOUT`, `LLM_INVALID_RESPONSE`, `LLM_CONTEXT_LENGTH_EXCEEDED`, `LLM_CONTENT_FILTERED`                |
| Sandbox  | `SANDBOX_UNAVAILABLE`, `SANDBOX_TIMEOUT`, `SANDBOX_OOM`, `SANDBOX_EXECUTION_FAILED`, `SANDBOX_INVALID_MODULE`                                      |
| Tool     | `TOOL_NOT_FOUND`, `TOOL_INVALID_ARGS`, `TOOL_EXECUTION_FAILED`, `TOOL_TIMEOUT`                                                                     |
| Memory   | `MEMORY_UNAVAILABLE`, `MEMORY_WRITE_FAILED`, `MEMORY_READ_FAILED`, `THREAD_ACCESS_DENIED`                                                          |
| Agent    | `AGENT_NOT_FOUND`, `AGENT_ALREADY_RUNNING`, `AGENT_MAX_ITERATIONS`, `RUN_TOKEN_LIMIT_EXCEEDED`, `RUN_NOT_PAUSED`, `RUN_TIMEOUT`, `BUDGET_EXCEEDED` |
| Workflow | `WORKFLOW_NOT_FOUND`, `WORKFLOW_STEP_FAILED`, `WORKFLOW_CYCLE_DETECTED`                                                                            |
| Swarm    | `SWARM_NO_WORKERS`, `SWARM_CONSENSUS_FAILED`                                                                                                       |
| Security | `PROMPT_INJECTION_DETECTED`, `PII_DETECTED`                                                                                                        |
| General  | `VALIDATION_ERROR`, `CONFIGURATION_ERROR`, `INTERNAL_ERROR`, `NOT_IMPLEMENTED`, `CIRCUIT_OPEN`                                                     |

The runtime throws `RUN_TIMEOUT` (HTTP 504) for a run that hits its timeout (`Run timed out after <n>ms`), `BUDGET_EXCEEDED` (429) for a run over its cost-routing budget, and `LLM_CONTENT_FILTERED` (400) when guardrails block the input or output (`Input blocked: …` / `Output blocked: …`).

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
  reflectionModel: 'gpt-6-luna',
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
      usageCount: 0,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      agentId: 'agent_789',
      source: { runId: 'run_456', reflectionId: 'ref_123' },
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
  beamWidth: 2, // Queue the best 2 candidates per expanded node
  maxDepth: 5, // Max reasoning depth
  explorationStrategy: 'beam', // 'beam' | 'best-first' | 'dfs'

  confidenceThreshold: 0.3,
  terminationConfidence: 0.8,
  maxTotalNodes: 50,
  maxIterationsPerBranch: 3, // Iteration cap for each branch run

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
  messagesSnapshot: [/* ... */],
};
```

`beam` runs the tree level by level, `best-first` runs the node whose own branch scored highest, and `dfs` goes deep first; candidates beyond `beamWidth` wait as pending alternatives for backtracking. `maxTotalNodes` caps executed nodes, and `maxIterationsPerBranch` caps each branch run (never above the agent's own `maxIterations`).

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
  traceRetention: 1000,
  maxDemosPerAgent: 5,
  minScoreForDemo: 0.8,
  defaultMetrics: ['success', 'tool_accuracy', 'efficiency'],
  customMetrics: [
    { name: 'tool_accuracy', type: 'numeric', description: 'Tools worked', weight: 0.5 },
  ],
};
// autoOptimize, optimizeAfterRuns and traceStore are deprecated and not read

// Optimizer configuration
const optimizerConfig: OptimizerConfig = {
  type: 'full', // 'bootstrap-few-shot' | 'instruction' | 'full'
  maxBootstrappedDemos: 5,
  maxRounds: 3,
  instructionCandidates: 3,
  metricThreshold: 0.7,
  teacherModel: 'gpt-6.1-sol',
};

// Execution trace
const trace: ExecutionTrace = {
  id: 'trace_123',
  runId: 'run_456',
  agentId: 'agent_789',
  threadId: 'thread_abc',
  input: 'Calculate compound interest',
  output: 'The compound interest is $1,628.89',
  steps: [],
  toolCalls: [],
  reflections: [],
  metrics: {
    success: true,
    toolAccuracy: 0.95,
    efficiency: 0.8,
    completeness: 1.0,
    coherence: 0.9,
  },
  score: 0.92,
  model: 'gpt-6.1-sol',
  createdAt: new Date(),
  duration: 1500,
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.0023,
  },
  isDemo: true,
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
  messages: [],
  toolResults: { call_1: 42, call_2: 'result' },
  pendingToolCalls: [],
  label: 'before-critical-decision',
  createdAt: new Date(),
};

// Replay options
const replayOptions: ReplayOptions = {
  fromCheckpoint: 'cp_123',
  mode: 'live', // 'deterministic' | 'live'
  modifiedToolResults: { web_search: { results: [] } }, // by tool name
  skipTools: ['expensive_api'], // removed from the replayed agent
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
    { index: 2, status: 'different' }, // step1 / step2 hold the ExecutionSteps
  ],
  commonSteps: 2,
  divergencePoint: 2,
  trace1OnlySteps: 1,
  trace2OnlySteps: 0,
  metricsDiff: {
    success: { trace1: true, trace2: false },
    score: { trace1: 0.9, trace2: 0.6, delta: -0.3 },
    tokens: { trace1: 1200, trace2: 1500, delta: 300 },
    duration: { trace1: 2100, trace2: 2600, delta: 500 },
  },
};
```

---

## Memory Types

See [@cogitator-ai/memory](https://www.npmjs.com/package/@cogitator-ai/memory) for detailed memory adapter types.

---

## Knowledge Graph Types

Entity-relationship memory with traversal and inference.

```typescript
import type {
  GraphNode,
  GraphEdge,
  EntityType,
  RelationType,
  GraphAdapter,
  TraversalOptions,
  TraversalResult,
  GraphPath,
  ExtractionResult,
  InferredEdge,
} from '@cogitator-ai/types';

// EntityType: 'person' | 'organization' | 'location' | 'concept' | 'event' | 'object' | 'custom'
// RelationType: 'knows' | 'works_at' | 'located_in' | 'part_of' | 'related_to' | 'created_by'
//   | 'belongs_to' | 'associated_with' | 'causes' | 'precedes' | 'custom'

// Graph node
const node: GraphNode = {
  id: 'node_123',
  agentId: 'agent-1',
  type: 'person',
  name: 'Alice',
  aliases: ['alice_dev'],
  description: 'Software engineer',
  properties: { role: 'developer', team: 'platform' },
  embedding: [0.1, 0.2, 0.3],
  confidence: 1.0,
  source: 'extracted', // 'extracted' | 'user' | 'inferred'
  createdAt: new Date(),
  updatedAt: new Date(),
  lastAccessedAt: new Date(),
  accessCount: 0,
};

// Graph edge
const edge: GraphEdge = {
  id: 'edge_456',
  agentId: 'agent-1',
  sourceNodeId: 'node_123',
  targetNodeId: 'node_789',
  type: 'works_at',
  label: 'Senior Developer',
  weight: 1.0,
  bidirectional: false,
  confidence: 0.95,
  source: 'extracted',
  properties: { since: '2020' },
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Traversal options
const traversalOptions: TraversalOptions = {
  agentId: 'agent-1',
  startNodeId: 'node_123',
  maxDepth: 3,
  direction: 'outgoing', // 'outgoing' | 'incoming' | 'both'
  edgeTypes: ['works_at', 'knows'],
  minEdgeWeight: 0.5,
  minConfidence: 0.7,
  limit: 100,
};

// Traversal result
const path: GraphPath = { nodes: [node], edges: [edge], totalWeight: 1.0, length: 1 };
const result: TraversalResult = {
  paths: [path],
  visitedNodes: [node],
  visitedEdges: [edge],
  depth: 1,
};
```

---

## Prompt Optimization Types

A/B testing, monitoring, and version control for agent instructions.

```typescript
import type {
  CapturedPrompt,
  PromptStore,
  ABTest,
  ABTestResults,
  ABTestOutcome,
  ABTestStore,
  InstructionVersion,
  InstructionVersionStore,
  PromptPerformanceMetrics,
  DegradationAlert,
  OptimizationRun,
} from '@cogitator-ai/types';

// Captured prompt
const prompt: CapturedPrompt = {
  id: 'prompt_123',
  runId: 'run_456',
  agentId: 'agent-1',
  threadId: 'thread_789',
  model: 'gpt-6.1-sol',
  provider: 'openai',
  timestamp: new Date(),
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [
    {
      name: 'calculator',
      description: 'Evaluate math',
      parameters: { type: 'object', properties: {} },
    },
  ],
  promptTokens: 150,
  response: {
    content: 'Hi there!',
    completionTokens: 10,
    finishReason: 'stop',
    latencyMs: 450,
  },
};

// A/B test
const abTest: ABTest = {
  id: 'test_123',
  agentId: 'agent-1',
  name: 'Instruction Experiment',
  description: 'Testing concise vs verbose',
  status: 'running',
  controlInstructions: 'You are helpful.',
  treatmentInstructions: 'Be concise and direct.',
  treatmentAllocation: 0.5,
  minSampleSize: 100,
  maxDuration: 7 * 24 * 60 * 60 * 1000,
  confidenceLevel: 0.95,
  metricToOptimize: 'score',
  controlResults: {
    sampleSize: 50,
    successRate: 0.9,
    avgScore: 0.82,
    avgLatency: 900,
    totalCost: 0.4,
    scores: [],
  },
  treatmentResults: {
    sampleSize: 48,
    successRate: 0.94,
    avgScore: 0.87,
    avgLatency: 850,
    totalCost: 0.38,
    scores: [],
  },
  createdAt: new Date(),
  startedAt: new Date(),
};

// A/B test outcome
const outcome: ABTestOutcome = {
  winner: 'treatment',
  pValue: 0.023,
  confidenceInterval: [0.02, 0.08],
  effectSize: 0.45,
  isSignificant: true,
  recommendation: 'Treatment performs significantly better.',
};

// Instruction version
const version: InstructionVersion = {
  id: 'ver_123',
  agentId: 'agent-1',
  version: 3,
  instructions: 'Optimized instructions...',
  source: 'optimization',
  sourceId: 'opt-run-456',
  deployedAt: new Date(),
  metrics: { runCount: 100, avgScore: 0.88, successRate: 0.95, avgLatency: 1200, totalCost: 1.4 },
};

// Degradation alert
const alert: DegradationAlert = {
  id: 'alert_123',
  agentId: 'agent-1',
  type: 'score_drop',
  severity: 'warning',
  currentValue: 0.72,
  baselineValue: 0.85,
  threshold: 0.15,
  percentChange: 0.153,
  detectedAt: new Date(),
  autoAction: 'rollback',
  actionTaken: false,
};
```

---

## Other Modules

Every module below is exported from the package root; the owning package documents how the types are used.

| Module                               | Main types                                                                                                                                                                                                                                                                                                                                           | Used by                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Memory                               | `MemoryAdapter`, `MemoryResult`, `Thread`, `MemoryEntry`, `Fact`, `Embedding`, `EmbeddingService`, `ContextBuilderConfig`, `MemoryConfig`                                                                                                                                                                                                            | [@cogitator-ai/memory](https://www.npmjs.com/package/@cogitator-ai/memory)                 |
| Sandbox                              | `SandboxConfig`, `SandboxManagerConfig` (`allowNativeFallback`, default `true`: Docker-sandboxed commands run on the host when Docker is unavailable), `SandboxPoolConfig` (`reuseContainers`, default `false`: every execution gets a fresh container), `SandboxWasmConfig` (`memoryPages` caps the module's own memory), `SandboxExecutionRequest` | [@cogitator-ai/sandbox](https://www.npmjs.com/package/@cogitator-ai/sandbox)               |
| Workflow                             | `WorkflowState`, `Workflow`, `CheckpointStore`, `RunStore`, `ApprovalStore`, `TimerStore` (optional `claimTtl`, `renew`, `release`), `WorkflowRunStats`                                                                                                                                                                                              | [@cogitator-ai/workflows](https://www.npmjs.com/package/@cogitator-ai/workflows)           |
| Swarm, negotiation                   | `SwarmConfig`, `SwarmStrategy`, `SwarmResult`, negotiation types                                                                                                                                                                                                                                                                                     | [@cogitator-ai/swarms](https://www.npmjs.com/package/@cogitator-ai/swarms)                 |
| Constitutional, security             | `GuardrailConfig`, `Constitution`, `PromptInjectionConfig`, `PiiConfig`, `PiiType`                                                                                                                                                                                                                                                                   | `@cogitator-ai/core`                                                                       |
| Cost routing, context, tool cache    | `CostRoutingConfig`, `BudgetConfig`, `ContextManagerConfig`, `ToolCacheConfig`, `RedisClientLike` (an ioredis client fits)                                                                                                                                                                                                                           | `@cogitator-ai/core`                                                                       |
| Causal                               | `CausalGraph`, `StructuralEquation` (`custom` type with a `customFn` expression), `InterventionQuery`, `CounterfactualQuery`, `CausalReasoningConfig`                                                                                                                                                                                                | `@cogitator-ai/core`                                                                       |
| Neuro-symbolic                       | `NeuroSymbolicConfig`, `ResolvedNeuroSymbolicConfig` (every section present, returned by `getConfig()`)                                                                                                                                                                                                                                              | [@cogitator-ai/neuro-symbolic](https://www.npmjs.com/package/@cogitator-ai/neuro-symbolic) |
| Self-modifying                       | `SelfModifyingConfig`, generated tool and architecture types                                                                                                                                                                                                                                                                                         | [@cogitator-ai/self-modifying](https://www.npmjs.com/package/@cogitator-ai/self-modifying) |
| Channel gateway                      | `GatewayConfig`, `ChannelMessage`, `HookRegistry`, `HookPayloads` (each hook name's payload: `MessageReceivedEvent`, `AgentErrorEvent`, `ApprovalResolvedEvent`, …)                                                                                                                                                                                  | [@cogitator-ai/channels](https://www.npmjs.com/package/@cogitator-ai/channels)             |
| RAG, voice, browser, session, deploy | `RAGPipelineConfig`, voice/STT/TTS types, browser session types, session types, `DeployConfig`                                                                                                                                                                                                                                                       | the package of the same name                                                               |
| Skills, logging                      | `Skill`, `SkillConfig`, `LoggingConfig` (`level` up to `'silent'`, `destination: 'file'` with `filePath`)                                                                                                                                                                                                                                            | `@cogitator-ai/core`                                                                       |

`HookPayloads` types gateway hooks by name: `HookRegistry.on('agent:error', ({ error, threadId }) => …)` gets an `AgentErrorEvent` (`error` is always an `Error`), and `HookName` is `keyof HookPayloads`. A handler typed `HookHandler` (`unknown` payload) is accepted for any hook. `GatewayConfig.owner` is deprecated: owners are set on `ownerCommands({ ownerIds })` and `dmPolicy({ ownerIds })`.

---

## License

MIT
