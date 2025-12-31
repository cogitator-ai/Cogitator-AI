# @cogitator-ai/core

Core runtime for Cogitator AI agents. Build and run LLM-powered agents with tool calling, streaming, reflection, Tree-of-Thought reasoning, learning optimization, and time-travel debugging.

## Installation

```bash
pnpm add @cogitator-ai/core
```

## Quick Start

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string(),
  }),
  execute: async ({ expression }) => {
    return { result: eval(expression) };
  },
});

const agent = new Agent({
  name: 'math-assistant',
  instructions: 'You are a helpful math assistant',
  model: 'openai/gpt-4o',
  tools: [calculator],
});

const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'What is 25 * 4?',
});

console.log(result.output);
```

## Features

- **Multi-Provider LLM Support** - Ollama, OpenAI, Anthropic, Google, vLLM
- **Type-Safe Tools** - Zod-validated tool definitions
- **Streaming Responses** - Real-time token streaming
- **Memory Integration** - Redis, PostgreSQL, in-memory adapters
- **20+ Built-in Tools** - Calculator, filesystem, HTTP, regex, and more
- **Reflection Engine** - Self-improvement through tool call analysis
- **Tree-of-Thought** - Advanced reasoning with branch exploration
- **Agent Optimizer** - DSPy-style learning from traces
- **Time Travel** - Checkpoint, replay, fork, and compare executions
- **Resilience** - Retry, circuit breaker, and fallback patterns
- **Observability** - Full tracing with spans and callbacks

---

## LLM Backends

### Supported Providers

```typescript
// Ollama (local, default)
const cog = new Cogitator({ defaultModel: 'ollama/llama3.2:3b' });

// OpenAI
const cog = new Cogitator({ defaultModel: 'openai/gpt-4o' });

// Anthropic Claude
const cog = new Cogitator({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });

// Google Gemini
const cog = new Cogitator({ defaultModel: 'google/gemini-1.5-flash' });

// vLLM
const cog = new Cogitator({ defaultModel: 'vllm/mistral-7b' });
```

### Backend Configuration

```typescript
import { Cogitator, OllamaBackend, OpenAIBackend, AnthropicBackend } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    ollama: {
      baseUrl: 'http://localhost:11434',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      organization: 'org-xxx',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    google: {
      apiKey: process.env.GOOGLE_API_KEY,
    },
  },
});
```

### Direct Backend Usage

```typescript
import { createLLMBackend, parseModel } from '@cogitator-ai/core';

const backend = createLLMBackend('openai', { apiKey: process.env.OPENAI_API_KEY });

const response = await backend.chat({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello!' },
  ],
});
```

---

## Agent Configuration

```typescript
import { Agent } from '@cogitator-ai/core';

const agent = new Agent({
  id: 'custom-id',
  name: 'research-assistant',
  instructions: 'You research topics thoroughly',
  model: 'openai/gpt-4o',
  tools: [webSearch, calculator],

  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  maxIterations: 15,
  timeout: 120_000,
  stopSequences: ['DONE'],
});

// Clone with modifications
const variant = agent.clone({
  name: 'fast-assistant',
  temperature: 0.3,
  maxTokens: 1024,
});
```

---

## Tools

### Creating Tools

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  execute: async ({ city, units = 'celsius' }, context) => {
    console.log(`Run ID: ${context.runId}`);
    return { temperature: 22, units, city };
  },
});
```

### Tool Context

Every tool receives a context object:

```typescript
interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal;
}
```

### Sandboxed Tools

Execute tools in isolated Docker or WASM environments:

```typescript
const shellTool = tool({
  name: 'run_shell',
  description: 'Execute shell commands safely',
  parameters: z.object({
    command: z.string(),
  }),
  sandbox: {
    type: 'docker',
    image: 'ubuntu:22.04',
  },
  timeout: 30000,
  execute: async ({ command }) => command,
});
```

### Tool Registry

```typescript
import { ToolRegistry } from '@cogitator-ai/core';

const registry = new ToolRegistry();

registry.register(calculator);
registry.registerMany([datetime, webSearch, fileRead]);

const tool = registry.get('calculator');
const names = registry.getNames();
const schemas = registry.getSchemas();
```

### Built-in Tools

| Tool            | Description                      |
| --------------- | -------------------------------- |
| `calculator`    | Evaluate math expressions        |
| `datetime`      | Get current date/time            |
| `uuid`          | Generate UUIDs                   |
| `randomNumber`  | Random number generation         |
| `randomString`  | Random string generation         |
| `hash`          | Hash strings (md5, sha256, etc.) |
| `base64Encode`  | Encode to base64                 |
| `base64Decode`  | Decode from base64               |
| `sleep`         | Delay execution                  |
| `jsonParse`     | Parse JSON strings               |
| `jsonStringify` | Stringify to JSON                |
| `regexMatch`    | Match regex patterns             |
| `regexReplace`  | Replace with regex               |
| `fileRead`      | Read file contents               |
| `fileWrite`     | Write to files                   |
| `fileList`      | List directory contents          |
| `fileExists`    | Check if file exists             |
| `fileDelete`    | Delete files                     |
| `httpRequest`   | Make HTTP requests               |
| `exec`          | Execute shell commands           |

```typescript
import { builtinTools, calculator, datetime } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'utility-agent',
  instructions: 'Use your tools to help users',
  model: 'openai/gpt-4o',
  tools: builtinTools,
});
```

---

## Run Options

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator();
const agent = new Agent({
  /* ... */
});

const result = await cog.run(agent, {
  input: 'Analyze this data...',

  threadId: 'thread_123',
  context: { userId: 'user_456', task: 'analysis' },

  timeout: 60000,
  stream: true,
  onToken: (token) => process.stdout.write(token),

  useMemory: true,
  loadHistory: true,
  saveHistory: true,

  onToolCall: (call) => console.log('Tool:', call.name),
  onToolResult: (result) => console.log('Result:', result.result),
  onSpan: (span) => console.log('Span:', span.name),
  onRunStart: ({ runId }) => console.log('Started:', runId),
  onRunComplete: (result) => console.log('Completed'),
  onRunError: (error) => console.error('Error:', error),
  onMemoryError: (error, op) => console.warn(`Memory ${op} failed`),
});
```

### Run Result

```typescript
interface RunResult {
  output: string;
  runId: string;
  agentId: string;
  threadId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
  toolCalls: ToolCall[];
  messages: Message[];
  trace: { traceId: string; spans: Span[] };
  reflections?: Reflection[];
  reflectionSummary?: ReflectionSummary;
}
```

---

## Memory Integration

Configure memory for conversation persistence:

```typescript
const cog = new Cogitator({
  memory: {
    adapter: 'redis',
    redis: {
      url: 'redis://localhost:6379',
      keyPrefix: 'cogitator:',
    },
    contextBuilder: {
      maxTokens: 4000,
      strategy: 'recent',
    },
  },
});

// Or PostgreSQL
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: {
      connectionString: 'postgresql://...',
    },
  },
});

// Or in-memory
const cog = new Cogitator({
  memory: {
    adapter: 'memory',
    inMemory: {
      maxEntries: 1000,
    },
  },
});
```

---

## Reflection Engine

Enable self-improvement through reflection on tool calls and runs:

```typescript
import { Cogitator, ReflectionEngine, InMemoryInsightStore } from '@cogitator-ai/core';

const cog = new Cogitator({
  reflection: {
    enabled: true,
    reflectionModel: 'openai/gpt-4o-mini',
    reflectAfterToolCall: true,
    reflectAtEnd: true,
    minConfidenceToStore: 0.7,
    maxInsightsPerAgent: 50,
  },
});

const result = await cog.run(agent, { input: 'Complete this task...' });

console.log('Reflections:', result.reflections);
console.log('Summary:', result.reflectionSummary);

const insights = await cog.getInsights(agent.id);
console.log('Learned insights:', insights);
```

### Standalone Reflection Engine

```typescript
import { ReflectionEngine, InMemoryInsightStore, createLLMBackend } from '@cogitator-ai/core';

const backend = createLLMBackend('openai', { apiKey: '...' });
const insightStore = new InMemoryInsightStore();

const engine = new ReflectionEngine({
  llm: backend,
  insightStore,
  config: {
    reflectAfterToolCall: true,
    minConfidenceToStore: 0.7,
  },
});

const result = await engine.reflectOnToolCall(action, agentContext);
if (result.shouldAdjustStrategy) {
  console.log('Suggested action:', result.suggestedAction);
}
```

---

## Tree-of-Thought Reasoning

Explore multiple reasoning paths before deciding:

```typescript
import { ThoughtTreeExecutor, BranchGenerator, BranchEvaluator } from '@cogitator-ai/core';

const executor = new ThoughtTreeExecutor(cogitator, {
  maxBranches: 5,
  maxDepth: 3,
  explorationStrategy: 'best-first',
  pruneThreshold: 0.3,
});

const result = await executor.run(agent, {
  input: 'Solve this complex problem...',
  explorationBudget: 10,
});

console.log('Best path:', result.bestPath);
console.log('All branches explored:', result.tree.branches.length);
console.log('Stats:', result.stats);
```

### ToT Configuration

```typescript
const executor = new ThoughtTreeExecutor(cogitator, {
  maxBranches: 5,
  maxDepth: 3,
  explorationStrategy: 'breadth-first',
  pruneThreshold: 0.3,
  branchTemperature: 0.8,
  evaluationModel: 'openai/gpt-4o-mini',
});
```

---

## Agent Optimizer (Learning)

DSPy-style optimization through execution traces:

```typescript
import {
  AgentOptimizer,
  InMemoryTraceStore,
  createSuccessMetric,
  createContainsMetric,
} from '@cogitator-ai/core';

const traceStore = new InMemoryTraceStore();
const optimizer = new AgentOptimizer(cogitator, {
  traceStore,
  optimizationModel: 'openai/gpt-4o',
  maxCandidates: 5,
  evaluationRuns: 3,
});

const result = await optimizer.compile(agent, {
  demos: [
    { input: 'Calculate 2+2', expectedOutput: '4' },
    { input: 'Calculate 10*5', expectedOutput: '50' },
  ],
  metric: createSuccessMetric(),
  maxIterations: 10,
});

console.log('Optimized instructions:', result.optimizedAgent.instructions);
console.log('Improvement:', result.improvement);
```

### Built-in Metrics

```typescript
import {
  createSuccessMetric,
  createExactMatchMetric,
  createContainsMetric,
  MetricEvaluator,
} from '@cogitator-ai/core';

const successMetric = createSuccessMetric();

const exactMatch = createExactMatchMetric();

const containsMetric = createContainsMetric(['error', 'failed'], { negate: true });
```

### Demo Selection

```typescript
import { DemoSelector } from '@cogitator-ai/core';

const selector = new DemoSelector({
  strategy: 'diverse',
  maxDemos: 5,
});

const selectedDemos = selector.select(allDemos, currentInput);
```

---

## Time Travel Debugging

Checkpoint, replay, fork, and compare agent executions:

```typescript
import { TimeTravel, InMemoryCheckpointStore } from '@cogitator-ai/core';

const timeTravel = new TimeTravel(cogitator);

const result = await cogitator.run(agent, { input: 'Original task...' });
const checkpoints = await timeTravel.checkpointAll(result, 'original');

const replayResult = await timeTravel.replayLive(agent, checkpoints[2].id);
console.log('Replayed from step 2:', replayResult.result.output);

const forkResult = await timeTravel.fork(agent, checkpoints[2].id, {
  newInput: 'Modified task...',
});
console.log('Forked result:', forkResult.result.output);

const diff = await timeTravel.compareWithOriginal(forkResult);
console.log(timeTravel.formatDiff(diff));
```

### Forking Variants

```typescript
const forkWithContext = await timeTravel.forkWithContext(
  agent,
  checkpointId,
  'Additional context: the user is an expert'
);

const forkWithMock = await timeTravel.forkWithMockedTool(agent, checkpointId, 'api_call', {
  status: 'success',
  data: 'mocked data',
});

const forkWithMocks = await timeTravel.forkWithMockedTools(agent, checkpointId, {
  api_call: { status: 'success' },
  database_query: { rows: [] },
});

const forkWithNewInput = await timeTravel.forkWithNewInput(
  agent,
  checkpointId,
  'Completely different task...'
);

const variants = await timeTravel.forkMultiple(agent, checkpointId, [
  { newInput: 'Variant A' },
  { newInput: 'Variant B' },
  { additionalContext: 'Be more concise' },
]);
```

### Replay Modes

```typescript
const deterministicReplay = await timeTravel.replayDeterministic(agent, checkpointId);

const liveReplay = await timeTravel.replayLive(agent, checkpointId, {
  maxSteps: 5,
});
```

---

## Error Handling & Resilience

### Retry with Backoff

```typescript
import { withRetry, retryable } from '@cogitator-ai/core';

const result = await withRetry(() => unreliableApiCall(), {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential',
  jitter: 0.1,
  onRetry: (error, attempt, delay) => {
    console.log(`Retry ${attempt} after ${delay}ms: ${error.message}`);
  },
});

const retryableFetch = retryable(fetch, { maxRetries: 3 });
const response = await retryableFetch('https://api.example.com');
```

### Circuit Breaker

```typescript
import { CircuitBreaker, CircuitBreakerRegistry } from '@cogitator-ai/core';

const breaker = new CircuitBreaker({
  threshold: 5,
  resetTimeout: 30000,
  successThreshold: 2,
});

if (breaker.canExecute()) {
  try {
    const result = await riskyOperation();
    breaker.recordSuccess();
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}

breaker.onStateChange((state) => {
  console.log('Circuit state:', state);
});
```

### Fallback Patterns

```typescript
import {
  withFallback,
  withGracefulDegradation,
  createLLMFallbackExecutor,
} from '@cogitator-ai/core';

const result = await withFallback(
  () => primaryCall(),
  () => fallbackCall()
);

const degraded = await withGracefulDegradation(
  () => fullFeatureCall(),
  [() => reducedFeatureCall(), () => minimalCall(), () => cachedResult()]
);

const llmExecutor = createLLMFallbackExecutor([
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  { provider: 'ollama', model: 'llama3.2:70b' },
]);
const response = await llmExecutor.chat(request);
```

---

## Logging

```typescript
import { Logger, getLogger, setLogger, createLogger } from '@cogitator-ai/core';

const logger = createLogger({
  level: 'debug',
  prefix: '[MyApp]',
  timestamps: true,
});

setLogger(logger);

getLogger().info('Agent started', { agentId: agent.id });
getLogger().debug('Tool call', { tool: 'calculator', args: { expression: '2+2' } });
getLogger().warn('Rate limited', { retryAfter: 60 });
getLogger().error('Failed', { error: 'Connection timeout' });
```

---

## Type Reference

### Core Types

```typescript
import type {
  Agent,
  AgentConfig,
  Tool,
  ToolConfig,
  ToolContext,
  Message,
  MessageRole,
  ToolCall,
  ToolResult,
  CogitatorConfig,
  RunOptions,
  RunResult,
  Span,
} from '@cogitator-ai/core';
```

### LLM Types

```typescript
import type {
  LLMBackend,
  LLMProvider,
  LLMConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator-ai/core';
```

### Reasoning Types

```typescript
import type {
  ToTConfig,
  ToTResult,
  ToTStats,
  ThoughtTree,
  ThoughtNode,
  ThoughtBranch,
  BranchScore,
  ExplorationStrategy,
} from '@cogitator-ai/core';
```

### Learning Types

```typescript
import type {
  ExecutionTrace,
  ExecutionStep,
  TraceStore,
  Demo,
  MetricFn,
  MetricResult,
  OptimizerConfig,
  OptimizationResult,
} from '@cogitator-ai/core';
```

### Time Travel Types

```typescript
import type {
  ExecutionCheckpoint,
  ReplayOptions,
  ReplayResult,
  ForkOptions,
  ForkResult,
  TraceDiff,
  TimeTravelConfig,
} from '@cogitator-ai/core';
```

### Error Types

```typescript
import { CogitatorError, ErrorCode, isRetryableError, getRetryDelay } from '@cogitator-ai/core';

try {
  await riskyOperation();
} catch (error) {
  if (error instanceof CogitatorError) {
    console.log('Code:', error.code);
    console.log('Retryable:', isRetryableError(error));
    console.log('Retry delay:', getRetryDelay(error, 1000));
  }
}
```

---

## Examples

### Research Agent with Memory

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';

const webSearch = tool({
  name: 'web_search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    return { results: await searchApi(query) };
  },
});

const cog = new Cogitator({
  memory: { adapter: 'redis', redis: { url: 'redis://localhost:6379' } },
  reflection: { enabled: true },
});

const researcher = new Agent({
  name: 'researcher',
  instructions: 'Research topics thoroughly using web search',
  model: 'openai/gpt-4o',
  tools: [webSearch],
});

const result = await cog.run(researcher, {
  input: 'Research the latest AI developments',
  threadId: 'research-session-1',
});
```

### Streaming Response

```typescript
const result = await cog.run(agent, {
  input: 'Write a story about...',
  stream: true,
  onToken: (token) => process.stdout.write(token),
});
```

### Full Observability

```typescript
const result = await cog.run(agent, {
  input: 'Analyze this data...',
  onRunStart: ({ runId }) => console.log(`Run ${runId} started`),
  onToolCall: (call) => console.log(`Calling ${call.name}`),
  onToolResult: (result) => console.log(`Result: ${JSON.stringify(result.result)}`),
  onSpan: (span) => {
    console.log(`[${span.name}] ${span.duration}ms`);
  },
  onRunComplete: (result) => {
    console.log(`Cost: $${result.usage.cost.toFixed(4)}`);
    console.log(`Tokens: ${result.usage.totalTokens}`);
  },
});
```

---

## License

MIT
