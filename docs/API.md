# API Reference

> One-page TypeScript reference for the main public API of Cogitator. The website has the per-package
> reference ([core](https://cogitator.app/docs/api-reference/core),
> [types](https://cogitator.app/docs/api-reference/types),
> [memory](https://cogitator.app/docs/api-reference/memory),
> [workflows](https://cogitator.app/docs/api-reference/workflows),
> [swarms](https://cogitator.app/docs/api-reference/swarms)) and guides for every feature.

## Core Classes

### Cogitator

The runtime that runs agents.

```typescript
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator(config?: CogitatorConfig);
```

#### CogitatorConfig

```typescript
interface CogitatorConfig {
  llm?: {
    defaultProvider?: LLMProvider; // used for model strings without a known provider prefix (Ollama when unset)
    defaultModel?: string; // used by agents without a `model`
    providers?: {
      ollama?: { baseUrl: string; apiKey?: string };
      openai?: {
        apiKey: string;
        baseUrl?: string;
        api?: 'responses' | 'chat-completions';
        profile?: OpenAICompatibleServer | OpenAICompatibleProfile; // what the server at baseUrl takes
        headers?: Record<string, string>;
      };
      anthropic?: { apiKey: string; baseUrl?: string; headers?: Record<string, string> };
      google?: { apiKey: string; baseUrl?: string; headers?: Record<string, string> }; // baseUrl with the API version
      azure?: { endpoint: string; apiKey: string; apiVersion?: string; deployment?: string };
      bedrock?: {
        region?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        endpoint?: string;
      };
      vllm?: {
        baseUrl: string;
        profile?: OpenAICompatibleServer | OpenAICompatibleProfile;
        headers?: Record<string, string>;
      };
      mistral?: { apiKey: string };
      groq?: { apiKey: string };
      together?: { apiKey: string };
      deepseek?: { apiKey: string };
    };
    // Your own backends by name: model 'name/model' (or provider: 'name') runs on them.
    // A built-in provider name replaces that provider.
    backends?: Record<string, LLMBackend>;
    // Config for backend plugins registered with registerLLMBackend(), by provider name
    plugins?: Record<string, unknown>;
    // Retries for failed LLM calls (default: 2 retries, exponential backoff); false turns them off
    retry?: LLMRetryConfig | false;
    // Prompt caching (on by default); false turns it off
    promptCache?: PromptCacheConfig | false;
    // When a model agents fall back from (fallbackModels) is skipped, per model, shared by all runs
    modelCircuitBreaker?: {
      failureThreshold?: number;
      resetTimeout?: number;
      halfOpenRequests?: number;
    };
    // Prices of your own in USD per million tokens, by model string or its tail after any '/',
    // over the model registry: { input, output, inputCached?, inputCacheWrite?, inputCacheWrite1h? }
    pricing?: Record<string, ModelPriceConfig>;
  };

  memory?: MemoryConfig; // see "Memory configuration" below

  // Where paused runs (tool approvals) are kept. Default: memory adapter threads, else process memory
  runCheckpoints?: RunCheckpointStore;

  // Versioned instructions and A/B tests (cog.prompts)
  prompts?: PromptsConfig;

  // Hooks around the model and tool calls of every run, also wrapping invokeTool()
  middleware?: RunMiddleware[];

  limits?: {
    maxConcurrentRuns?: number;
    defaultTimeout?: number; // ms; default 120000
    maxTokensPerRun?: number;
    maxToolResultLength?: number; // characters of a tool result the model reads, default 100000
  };

  sandbox?: SandboxManagerConfig; // from @cogitator-ai/sandbox
  reflection?: ReflectionConfig;
  guardrails?: Partial<GuardrailConfig>; // on unless enabled: false
  costRouting?: CostRoutingConfig;
  security?: {
    promptInjection?: Partial<PromptInjectionConfig>;
    pii?: PiiConfig; // mask personal data before it reaches the provider
  };
  context?: ContextManagerConfig; // long-conversation compression
  logging?: LoggingConfig; // the process-wide logger, see below
  deploy?: DeployConfig;
}
```

#### Logging configuration

```typescript
interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent'; // default 'info'
  format?: 'json' | 'pretty'; // default 'pretty' ('json' for files)
  destination?: 'console' | 'file'; // default 'console'
  filePath?: string; // required for 'file'
}
```

`new Cogitator({ logging })` replaces the process-wide logger (`getLogger()`), so with several runtimes the last one created with `logging` wins. `'silent'` outputs nothing. `destination: 'file'` appends one JSON line per entry to `filePath` (unless `format` says otherwise); without `filePath`, or where there is no file system, it logs to the console with a warning. `createLoggerFromConfig(config)` from `@cogitator-ai/core` builds the same logger for `setLogger()`.

#### Memory configuration

```typescript
interface MemoryConfig {
  adapter?: 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant';
  inMemory?: { maxEntries?: number };
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    cluster?: { nodes: { host: string; port: number }[]; scaleReads?: 'master' | 'slave' | 'all' };
    keyPrefix?: string;
    ttl?: number; // seconds after the last write, default 0 (no expiry)
    password?: string;
  };
  postgres?: { connectionString: string; schema?: string; poolSize?: number };
  sqlite?: { path: string; walMode?: boolean };
  mongodb?: { uri: string; database?: string; collectionPrefix?: string };
  qdrant?: { url?: string; apiKey?: string; collection?: string; dimensions: number };
  embedding?:
    | { provider: 'openai'; apiKey: string; model?: string; baseUrl?: string; dimensions?: number }
    | { provider: 'ollama'; model?: string; baseUrl?: string; dimensions?: number }
    | { provider: 'google'; apiKey: string; model?: string; baseUrl?: string; dimensions?: number };
  contextBuilder?: {
    maxTokens?: number;
    strategy?: 'recent' | 'relevant' | 'hybrid';
    reserveTokens?: number;
    includeSystemPrompt?: boolean;
    includeFacts?: boolean;
    includeSemanticContext?: boolean;
    includeGraphContext?: boolean;
  };
  brief?: {
    model?: string;
    maxCards?: number;
    timeoutMs?: number;
    maxTokens?: number;
    prompt?: string;
  };
  observations?: { model?: string; maxEntities?: number; minItems?: number; prompt?: string };
  consolidation?: {
    model?: string;
    everyRuns?: number; // default 20
    afterCompaction?: boolean; // default true
    maxChanges?: number; // default 10
    maxSubjects?: number; // default 10
    playbook?: 'apply' | 'shadow' | false; // default 'apply'
    showPlaybook?: boolean; // default true
    prompt?: string;
    afterConsolidate?: (report: MemoryConsolidationReport) => void | Promise<void>;
  };
}
```

`brief`, `observations` and `consolidation` keep memory useful between runs, see [Memory upkeep](#memory-upkeep).

The runtime creates the adapter itself only for `adapter: 'memory'`, `'redis'` (requires `redis.url`) and
`'postgres'` (requires `postgres.connectionString`); any other value only logs a warning. For SQLite or
MongoDB, create the adapter from `@cogitator-ai/memory`, connect it and assign it:

```typescript
import { createMemoryAdapter } from '@cogitator-ai/memory';

const adapter = await createMemoryAdapter({ provider: 'sqlite', path: './memory.db' });
await adapter.connect();
cog.memory = adapter;
```

Qdrant is an embedding store (`QdrantAdapter`, `createEmbeddingAdapter`), not a conversation memory adapter.

#### Methods

```typescript
class Cogitator {
  // Run an agent
  run(agent: Agent, options: RunOptions): Promise<RunResult>;

  // Continue a run that paused for tool approvals, from its checkpoint or its thread id
  resume(
    agent: Agent,
    target: RunCheckpoint | string,
    options?: ResumeOptions // run options plus { decisions?, defaultDecision?, userId? }
  ): Promise<RunResult>;

  // Tool registry shared across all runs. register(tool, { replace? }) and registerMany(tools, { replace? })
  // warn when a different tool takes a registered name, unless replace: true. An agent's own tool
  // of the same name wins in its runs, without a warning
  readonly tools: ToolRegistry;

  // Memory adapter, connecting it on first use (undefined when not configured or it failed to connect)
  getMemory(): Promise<MemoryAdapter | undefined>;
  // The adapter once connected (by a run or getMemory()); assign your own adapter here
  memory: MemoryAdapter | undefined;
  // A pass over the agent's memory now (memory.consolidation or memory.observations): repeats marked
  // stale, lessons folded into the playbook, observations written again. With the 'user' extraction
  // scope it needs a userId, or a threadId for memory of runs without a user, with 'thread' a
  // threadId, with 'agent' nothing. Throws without the config or when memory keeps no items
  consolidateMemory(
    agent: Agent,
    run?: { userId?: string; threadId?: string; since?: Date } // since: report.dedupe.through to go on
  ): Promise<MemoryConsolidationReport>;
  // Deletes entries (a user message with its replies, unless keepReplies), a thread, or every thread
  // of a user and everything kept for the user, with all memory derived from them. Goes through the
  // memory of the agents each thread names (metadata.memoryAgentIds) and its owner, agents adds
  // others and is needed for a thread that names none or a user without threads
  forget(
    target: { entryIds: readonly string[] } | { threadId: string } | { userId: string },
    options?: MemoryCascadeCall // { agents?: (Agent | string)[]; graph?: GraphAdapter; keepReplies?: boolean }
  ): Promise<MemoryCascadeReport>;
  // What the entries said becomes '[redacted]', their place stays, what was derived from them goes
  redactEntries(
    entryIds: readonly string[],
    options?: MemoryCascadeCall & { reason?: string }
  ): Promise<MemoryCascadeReport>;
  // Rewinds the thread to an entry of its active branch, items standing only on the turns after it go stale
  rewind(
    threadId: string,
    toEntryId: string,
    options?: MemoryCascadeCall
  ): Promise<MemoryCascadeReport>;

  // Versioned instructions and A/B tests
  readonly prompts: PromptRegistry;

  // The model a run of `agent` uses: agent.model, else llm.defaultModel (throws CONFIGURATION_ERROR)
  resolveModel(agent: Agent): string;
  // The backend a model string runs on and the model name sent to it
  route(modelString: string, explicitProvider?: string): ModelRoute;
  getLLMBackend(modelString: string, explicitProvider?: string): LLMBackend;

  // Estimate cost before executing
  estimateCost(params: {
    agent: Agent;
    input: string;
    options?: EstimateOptions;
    model?: string;
  }): Promise<CostEstimate>;

  // Reflection
  getInsights(agentId: string): Promise<Insight[]>;
  getReflectionSummary(agentId: string): Promise<ReflectionSummary | null>;
  readonly reflectionEngine: ReflectionEngine | undefined;

  // Constitutional AI guardrails
  getGuardrails(): ConstitutionalAI | undefined;
  setConstitution(constitution: Constitution): void;

  // Cost tracking
  getCostSummary(): CostSummary | undefined;
  getCostRouter(): CostAwareRouter | undefined;

  // Release connections, sandboxes and backends
  close(): Promise<void>;
}
```

Cogitator has no event emitter. For observability, use the `RunOptions` callbacks.

#### RunOptions

```typescript
interface RunOptions<TDeps = unknown> {
  input: string;

  // Images (URLs or base64) and audio to transcribe
  images?: (
    string | { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  )[];
  audio?: (
    | string
    | {
        data: string;
        format: 'mp3' | 'mp4' | 'mpeg' | 'mpga' | 'm4a' | 'wav' | 'webm' | 'ogg' | 'flac';
      }
  )[];

  // Additional context injected into the system prompt
  context?: Record<string, unknown>;
  // Your own values for the tools (context.deps): never sent to the model, memory, spans or
  // checkpoints. Required when the agent declares its deps type (new Agent<Deps>(...))
  deps?: TDeps;

  threadId?: string;
  timeout?: number; // overrides agent.timeout
  signal?: AbortSignal; // cancel the run
  stream?: boolean;

  // Overrides the agent's reasoning config for this run
  reasoning?: ReasoningConfig;

  // Memory control
  useMemory?: boolean; // default: true if an adapter is configured
  loadHistory?: boolean; // default: true
  saveHistory?: boolean; // default: true

  // Execute tool calls in parallel (default: false)
  parallelToolCalls?: boolean;

  // Hooks around this run's model and tool calls, after the Cogitator's and the agent's
  middleware?: RunMiddleware<TDeps>[];

  // The user the run acts for: owns the threads it creates, reaches tools as context.userId
  userId?: string;
  // 'owner' (default): only the thread's creator may continue it; 'shared': anyone
  threadAccess?: 'owner' | 'shared';
  channelType?: string;
  channelId?: string;

  // Decide tool calls that require approval; return 'pause' to pause the run
  onApproval?: (
    request: ToolApprovalRequest
  ) => ToolApprovalDecision | 'pause' | Promise<ToolApprovalDecision | 'pause'>;

  // Callbacks
  onToken?: (token: string) => void;
  onReasoning?: (delta: string) => void;
  onHandoff?: (handoff: { from: string; to: string; reason?: string }) => void;
  // A turn moved from a failing model to the next of the agent's fallbackModels
  onModelFallback?: (event: { from: string; to: string; error: Error }) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  onRunStart?: (data: { runId: string; agentId: string; input: string; threadId: string }) => void;
  onRunComplete?: (result: RunResult) => void;
  onRunError?: (error: Error, runId: string, usage?: RunUsage) => void; // usage of the finished model calls
  onSpan?: (span: Span) => void;
  onMemoryError?: (error: Error, operation: 'save' | 'load') => void;
}
```

#### RunResult

```typescript
interface RunResult {
  readonly output: string;
  readonly structured?: unknown; // parsed output for responseFormat json / json_schema

  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;

  // The model of the final answer when it may differ from agent.model: cost routing or a fallback
  readonly modelUsed?: string;

  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly duration: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteTokens?: number;
  };

  readonly reasoning?: string; // reasoning summary (reasoning.summary)
  readonly prompt?: RunPrompt; // versioned instructions / A/B variant used
  readonly handoffs?: readonly { from: string; to: string; reason?: string }[];
  readonly finalAgent?: string;

  // Tool approvals: 'paused' when calls wait for a decision
  readonly status?: 'completed' | 'paused';
  readonly pendingApprovals?: readonly ToolApprovalRequest[];
  readonly checkpoint?: RunCheckpoint; // pass to cog.resume()

  readonly toolCalls: readonly ToolCall[];
  readonly messages: readonly Message[];
  readonly trace: {
    readonly traceId: string;
    readonly spans: readonly Span[];
  };

  readonly reflections?: readonly Reflection[];
  readonly reflectionSummary?: ReflectionSummary;
}
```

#### Tool approvals

A tool with `requiresApproval` pauses the run unless `onApproval` (or `guardrails.onToolApproval`) decides it:

```typescript
const paused = await cog.run(agent, { input: 'Refund order 42', threadId: 'thread-1' });

if (paused.status === 'paused') {
  const result = await cog.resume(agent, 'thread-1', {
    defaultDecision: { approved: true },
  });
}
```

See [Tool Approvals](https://cogitator.app/docs/tools/approvals).

---

### Agent

A configured LLM agent. Agents are run by `cog.run(agent, { input })`; `Agent` has no `run()` method.

```typescript
import { Agent } from '@cogitator-ai/core';

const agent = new Agent(config: AgentConfig);
```

#### AgentConfig

```typescript
interface AgentConfig<TDeps = unknown> {
  id?: string; // stable id (generated when omitted)
  name: string;
  description?: string;
  instructions: string;

  // 'provider/model', e.g. 'openai/gpt-5.5', 'anthropic/claude-sonnet-5-5', 'ollama/llama3.2'.
  // Falls back to llm.defaultModel of the Cogitator that runs the agent.
  model?: string;
  // Explicit provider override (useful for OpenRouter and similar proxies)
  provider?: string;
  // Models a turn moves to, in order, when model is down, out of quota, rejects the key or is
  // gone. Rate limits and server errors are retried on model first
  fallbackModels?: Array<string | { model: string; provider?: string }>;

  temperature?: number; // default: 0.7
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];

  tools?: Tool[];
  skills?: Skill[];
  responseFormat?: ResponseFormat;
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    budgetTokens?: number;
    summary?: boolean;
  };
  // Agents this one can hand the conversation over to (transfer_to_<name> tools)
  handoffs?: Array<Agent | { agent: Agent; toolName?: string; description?: string }>;

  maxIterations?: number; // default: 10
  timeout?: number; // ms; falls back to limits.defaultTimeout, then 120000
  // Hooks around this agent's model and tool calls, after the Cogitator's middleware
  middleware?: RunMiddleware<TDeps>[];
}
```

#### ResponseFormat

```typescript
type ResponseFormat =
  { type: 'text' } | { type: 'json' } | { type: 'json_schema'; schema: ZodType };
```

`json_schema` takes a Zod schema, not a raw JSON Schema object.

#### Members

```typescript
class Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;
  readonly model: string | undefined;
  readonly instructions: string;
  readonly tools: Tool[];

  clone(overrides: Partial<AgentConfig>): Agent;
  serialize(): AgentSnapshot;
  static deserialize(snapshot: AgentSnapshot, options?: DeserializeOptions): Agent;
  static validateSnapshot(snapshot: unknown): snapshot is AgentSnapshot;
}

interface DeserializeOptions {
  toolRegistry?: { get(name: string): Tool | undefined };
  tools?: Tool[];
  overrides?: Partial<AgentConfig>;
}
```

---

### Tool

A capability an agent can call.

```typescript
import { tool, toolset } from '@cogitator-ai/core';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, temperature: 21 }),
});

// A typed tuple of tools: still a Tool[], but each keeps its own parameter types
const tools = toolset(getWeather);
```

#### ToolConfig

```typescript
interface ToolConfig<TParams = unknown, TResult = unknown, TDeps = unknown> {
  name: string;
  description: string;
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

  parameters: ZodType<TParams>;
  // Annotate context as ToolContext<Deps> to read the run's deps, typed
  execute: (params: TParams, context: ToolContext<TDeps>) => Promise<TResult>;

  sideEffects?: ('filesystem' | 'network' | 'database' | 'process' | 'external')[];
  requiresApproval?: boolean | ((params: TParams) => boolean);
  timeout?: number;
  sandbox?: SandboxConfig; // from @cogitator-ai/sandbox
  maxResultLength?: number; // overrides limits.maxToolResultLength for this tool

  title?: string; // name for people, such as an MCP client shows
  outputSchema?: ZodType<TResult>; // advertised by MCPServer, results sent as structuredContent
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}
```

`name` must be one every LLM provider accepts: letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters. `tool()` throws a `TypeError` for any other name, with a suggested name in the message. `isProviderSafeToolName(name)`, `normalizeToolName(name)`, `normalizeToolNames(names)` and `TOOL_NAME_MAX_LENGTH` from `@cogitator-ai/core` check a name or make one that fits.

#### Tool results with parts

```typescript
import { toolContent } from '@cogitator-ai/core';

return toolContent(
  { type: 'text', text: 'Rendered the chart' },
  { type: 'image', data: pngBase64, mediaType: 'image/png' }, // the model sees the image
  { type: 'file', data: mp3Base64, mediaType: 'audio/mpeg', filename: 'speech.mp3' }, // stays with the app
  { type: 'json', value: { points: 42 } }, // the model reads JSON text
  { type: 'resource', uri: 'file:///repo/README.md', mediaType: 'text/markdown', text: readme }
);
```

A `resource` part has `uri`, `name?`, `description?`, `mediaType?` and at most one of `text` and base64 `data`. The model reads a text resource after a line naming it, and only that line (with the size) for a binary one. `isToolContentResult`, `toolResultParts`, `toolPartsToText`, `truncateToolResultText` and `DEFAULT_TOOL_RESULT_MAX_LENGTH` come from `@cogitator-ai/types` and are re-exported by core.

The model reads at most `limits.maxToolResultLength` characters of a result (default 100 000), or the tool's `maxResultLength`. A longer result, or error, keeps its start and end with a note of how much was left out in the middle, and `onToolResult` still gets the whole result, while `RunResult.messages` and the thread history keep what the model read.

#### ToolContext

```typescript
interface BaseToolContext<TDeps = unknown> {
  agentId: string;
  runId: string;
  signal: AbortSignal;
  toolCallId?: string;
  threadId?: string;
  userId?: string;
  channelType?: string;
  channelId?: string;
  deps?: TDeps; // RunOptions.deps
}

// With a deps type, deps is present and typed
type ToolContext<TDeps = unknown> = unknown extends TDeps
  ? BaseToolContext
  : BaseToolContext<TDeps> & { deps: TDeps };
```

`new Agent<AppDeps>(...)` makes `deps` required in `run()` and `resume()` and refuses tools whose deps type is unrelated to `AppDeps` (declare every field the tools read in it: tool methods are compared loosely, so a tool reading a field `AppDeps` lacks still compiles). A paused run's checkpoint never holds `deps`, so `resume()` takes them again.

#### Built-in Tools

```typescript
import {
  // Filesystem
  fileRead,
  fileWrite,
  fileDelete,
  fileList,
  fileExists,

  // HTTP and web
  httpRequest,
  webSearch,
  webScrape,

  // Code execution
  exec,

  // Database
  sqlQuery,
  vectorSearch,

  // Math and utilities
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

  // All of the above as an array
  builtinTools,
} from '@cogitator-ai/core';
```

Tool factories: `createAnalyzeImageTool`, `createGenerateImageTool`, `createTranscribeAudioTool`,
`createGenerateSpeechTool`, `createMemoryTools`, `createMemorySearchTools`, `memoryFileTool`, `createSchedulerTools`, and
`agentAsTool(cogitator, agent, options)`
to call one agent from another. See [Built-in Tools](https://cogitator.app/docs/tools/built-in).

---

### Workflow

DAG-based pipelines from `@cogitator-ai/workflows`. State types must satisfy `WorkflowState`
(`Record<string, unknown>`): use a type alias or an interface that extends `WorkflowState`.

```typescript
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  functionNode,
} from '@cogitator-ai/workflows';
import type { WorkflowState } from '@cogitator-ai/types';

interface PageState extends WorkflowState {
  page: string;
  summary: string;
}

const workflow = new WorkflowBuilder<PageState>('summarize-page')
  .initialState({ page: '', summary: '' })
  .addNode(
    'fetch',
    functionNode<PageState>(
      'fetch',
      async () => {
        const res = await fetch('https://example.com');
        return res.text();
      },
      { stateMapper: (text) => ({ page: String(text) }) }
    )
  )
  .addNode(
    'summarize',
    agentNode<PageState>(agent, {
      inputMapper: (state) => `Summarize:\n${state.page}`,
      stateMapper: (result) => ({ summary: result.output }),
    }),
    { after: ['fetch'] }
  )
  .build();

const executor = new WorkflowExecutor(cog);
const result = await executor.execute(
  workflow,
  {},
  {
    onNodeStart: (node) => console.log('Starting:', node),
    onNodeComplete: (node, output, duration) => console.log('Done:', node, duration),
  }
);
console.log(result.state.summary);
```

#### WorkflowBuilder

```typescript
class WorkflowBuilder<S extends WorkflowState = WorkflowState> {
  constructor(name: string);

  // Default state, merged with the execution input
  initialState(state: S): this;

  // Explicit entry point
  entryPoint(nodeName: string): this;

  // Add a node: a NodeFn or a node created by a factory (agentNode, functionNode, ...)
  addNode(
    name: string,
    node: NodeFn<S> | WorkflowNode<S>,
    options?: { after?: string[]; config?: NodeConfig }
  ): this;

  // Route to the node(s) the condition names
  addConditional(
    name: string,
    condition: (state: S) => string | string[],
    options?: { after?: string[] }
  ): this;

  // Loop back while the condition holds
  addLoop(
    name: string,
    options: {
      condition: (state: S) => boolean;
      back: string;
      exit: string;
      after?: string[];
    }
  ): this;

  // Fan out to several nodes
  addParallel(name: string, targets: string[], options?: { after?: string[] }): this;

  // Validate and compile
  build(): Workflow<S>;
}

interface NodeConfig {
  name?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}
```

#### Node factories

```typescript
import { agentNode, toolNode, functionNode, customNode } from '@cogitator-ai/workflows';

// Run an agent; input defaults to ctx.input or the JSON-encoded state
agentNode<S>(
  agent: Agent,
  options?: {
    inputMapper?: (state: S, input?: unknown) => string;
    stateMapper?: (result: RunResult) => Partial<S>;
    runOptions?: Partial<RunOptions>;
  }
): WorkflowNode<S>;

// Run a tool with arguments built from the state
toolNode<S, TArgs>(
  tool: Tool<TArgs, unknown>,
  options: {
    argsMapper: (state: S, input?: unknown) => TArgs;
    stateMapper?: (result: unknown) => Partial<S>;
    signal?: AbortSignal;
  }
): WorkflowNode<S>;

// Run a function of (state, input); its return value is the node output
functionNode<S, O>(
  name: string,
  fn: (state: S, input?: unknown) => Promise<O>,
  options?: { stateMapper?: (output: unknown) => Partial<S> }
): WorkflowNode<S>;

// Full control: receives the NodeContext, returns a NodeResult
customNode<S>(name: string, fn: (ctx: NodeContext<S>) => Promise<NodeResult<S>>): WorkflowNode<S>;
```

More factories: `humanWorkflowNode`, `timerWorkflowNode`, `mapWorkflowNode`, `mapReduceWorkflowNode`,
`subworkflowWorkflowNode`, `parallelSubworkflowsNode`. See [Nodes](https://cogitator.app/docs/workflows/nodes).

#### WorkflowExecutor

```typescript
class WorkflowExecutor {
  constructor(cogitator: Cogitator, checkpointStore?: CheckpointStore); // default: InMemoryCheckpointStore

  execute<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: ExecutorExecuteOptions
  ): Promise<WorkflowResult<S>>;

  // Continue from a saved checkpoint (needs checkpoint: true on the original run)
  resume<S extends WorkflowState>(
    workflow: Workflow<S>,
    checkpointId: string,
    options?: WorkflowExecuteOptions
  ): Promise<WorkflowResult<S>>;

  // Execution events as they happen
  stream<S extends WorkflowState>(
    workflow: Workflow<S>,
    input?: Partial<S>,
    options?: Omit<
      WorkflowExecuteOptions,
      'onNodeStart' | 'onNodeComplete' | 'onNodeError' | 'onNodeProgress'
    >
  ): AsyncIterable<StreamingWorkflowEvent>;
}
```

#### Execute options

```typescript
interface WorkflowExecuteOptions {
  maxConcurrency?: number; // default: 4
  maxIterations?: number; // default: 100
  checkpoint?: boolean; // default: false
  checkpointStrategy?: 'per-iteration' | 'per-node'; // default: 'per-iteration'
  skipNodes?: Set<string>; // nodes that already ran (when resuming)
  nodeResults?: Record<string, unknown>; // outputs of skipNodes
  workflowId?: string;
  onNodeStart?: (node: string) => void;
  onNodeComplete?: (node: string, result: unknown, duration: number) => void;
  onNodeError?: (node: string, error: Error) => void;
  onNodeProgress?: (node: string, progress: number) => void;
}

// execute() also accepts
interface ExecutorExecuteOptions extends WorkflowExecuteOptions {
  signal?: AbortSignal;
  tracer?: WorkflowTracer;
  metricsCollector?: WorkflowMetricsCollector;
  depth?: number;
  defaultRetry?: RetryConfig;
  defaultCircuitBreaker?: CircuitBreakerConfig;
  deadLetterQueue?: DeadLetterQueue;
  idempotencyStore?: IdempotencyStore;
  approvalStore?: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
  timerStore?: TimerStore;
}
```

#### NodeContext, NodeResult, WorkflowResult

```typescript
interface NodeContext<S = WorkflowState> {
  state: S;
  input?: unknown; // output of the preceding node(s)
  nodeId: string;
  workflowId: string;
  step: number;
  reportProgress?: (progress: number) => void;
}

interface NodeResult<S = WorkflowState> {
  state?: Partial<S>;
  output?: unknown;
  next?: string | string[];
}

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

Multi-agent coordination from `@cogitator-ai/swarms`.

```typescript
import { Swarm, swarm } from '@cogitator-ai/swarms';

// Builder
const team = swarm('research-team')
  .strategy('hierarchical')
  .supervisor(supervisorAgent)
  .workers([researcher, writer])
  .build(cog);

// Or the constructor: Cogitator first, then the config
const debate = new Swarm(cog, {
  name: 'debate',
  strategy: 'debate',
  agents: [advocate, critic],
  moderator,
  debate: { rounds: 3 },
});

const result = await team.run({ input: 'Write a report on solid-state batteries' });
console.log(result.output);
```

#### SwarmConfig

```typescript
interface SwarmConfig {
  name: string;
  strategy:
    | 'hierarchical'
    | 'round-robin'
    | 'consensus'
    | 'auction'
    | 'pipeline'
    | 'debate'
    | 'negotiation';

  // Agents (which ones depend on the strategy)
  supervisor?: Agent; // hierarchical
  workers?: Agent[]; // hierarchical
  agents?: Agent[]; // round-robin, consensus, auction, debate, negotiation
  stages?: PipelineStage[]; // pipeline stages (alternative to pipeline.stages)
  moderator?: Agent; // debate
  router?: Agent;
  agentMetadata?: Record<string, SwarmAgentMetadata>; // role, expertise, weight, ... by agent name

  // Strategy-specific config
  hierarchical?: {
    maxDelegationDepth?: number; // default: 3
    workerCommunication?: boolean;
    routeThrough?: 'supervisor' | 'direct';
    visibility?: 'full' | 'summary' | 'none';
  };
  roundRobin?: {
    sticky?: boolean;
    stickyKey?: (input: unknown) => string;
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
    stageInput?: (prevOutput: unknown, stage: PipelineStage, ctx: PipelineContext) => unknown;
    gates?: Record<string, PipelineGateConfig>;
  };
  debate?: {
    rounds: number;
    maxTokensPerTurn?: number;
    format?: 'structured' | 'freeform';
  };
  negotiation?: NegotiationConfig;

  // Agent communication
  messaging?: {
    enabled: boolean;
    protocol?: 'direct' | 'broadcast' | 'pub-sub'; // deprecated, no effect
    maxMessageLength?: number;
    maxMessagesPerTurn?: number;
    maxTotalMessages?: number;
  };
  blackboard?: {
    enabled: boolean;
    sections: Record<string, unknown>;
    locking?: boolean; // deprecated, no effect
    trackHistory?: boolean;
  };

  resources?: {
    maxConcurrency?: number; // default: 4
    tokenBudget?: number;
    costLimit?: number; // dollars
    timeout?: number; // ms
    perAgent?: { maxIterations?: number; maxTokens?: number; timeout?: number };
  };

  errorHandling?: {
    onAgentFailure: 'retry' | 'skip' | 'failover' | 'abort';
    retry?: {
      maxRetries: number;
      backoff: 'constant' | 'linear' | 'exponential';
      initialDelay?: number;
      maxDelay?: number;
    };
    failover?: Record<string, string>;
    circuitBreaker?: { enabled: boolean; threshold: number; resetTimeout: number };
    partialResults?: boolean;
  };

  // Run agents on BullMQ workers
  distributed?: DistributedSwarmConfig;

  // Built-in messaging/blackboard tools for every agent (in-process swarms only)
  agentTools?: { messaging?: boolean; blackboard?: boolean };

  observability?: {
    tracing?: boolean; // log each agent run's trace
    messageLogging?: boolean;
    blackboardLogging?: boolean;
  };
}
```

#### SwarmRunOptions

```typescript
interface SwarmRunOptions {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
  userId?: string;
  timeout?: number;
  saveHistory?: boolean; // default: true
  onAgentStart?: (agentName: string) => void;
  onAgentComplete?: (agentName: string, result: RunResult) => void;
  onAgentError?: (agentName: string, error: Error) => void;
  onMessage?: (message: SwarmMessage) => void;
  onEvent?: (event: SwarmEvent) => void;
}
```

#### Swarm members

```typescript
class Swarm {
  constructor(cogitator: Cogitator, config: SwarmConfig, assessorConfig?: AssessorConfig);

  run(options: SwarmRunOptions): Promise<StrategyResult>; // output, agentResults, votes, bids, ...
  dryRun(options: { input: string }): Promise<AssessmentResult>; // needs an assessor
  getLastAssessment(): AssessmentResult | undefined;

  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;
  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void;

  getAgents(): SwarmAgent[];
  getAgent(name: string): SwarmAgent | undefined;
  getResourceUsage(): SwarmResourceUsage;

  pause(): void;
  resume(): void;
  abort(): void;
  isPaused(): boolean;
  isAborted(): boolean;
  reset(): Promise<void>;
  close(): Promise<void>;

  readonly name: string;
  readonly id: string;
  readonly strategyType: string;
  readonly isDistributed: boolean;
  readonly messageBus: MessageBus;
  readonly blackboard: Blackboard;
  readonly events: SwarmEventEmitter;
}
```

The builder (`swarm(name)`) has a method per config field (`strategy`, `supervisor`, `workers`, `agents`,
`moderator`, `router`, `agentMetadata`, `hierarchical`, `roundRobin`, `consensus`, `auction`, `pipeline`,
`debate`, `negotiation`, `messaging`, `blackboardConfig`, `resources`, `errorHandling`, `distributed`,
`observability`), plus `withAssessor(config?)` and `build(cogitator)`.

---

## Memory API

### MemoryAdapter

Implemented by `InMemoryAdapter`, `RedisAdapter`, `PostgresAdapter`, `SQLiteAdapter` and `MongoDBAdapter`
from `@cogitator-ai/memory`.

```typescript
interface MemoryAdapter {
  readonly provider: 'memory' | 'redis' | 'postgres' | 'sqlite' | 'mongodb' | 'qdrant';

  // Threads
  createThread(
    agentId: string,
    metadata?: Record<string, unknown>,
    threadId?: string
  ): Promise<MemoryResult<Thread>>;
  getThread(threadId: string): Promise<MemoryResult<Thread | null>>;
  updateThread(threadId: string, metadata: Record<string, unknown>): Promise<MemoryResult<Thread>>;
  deleteThread(threadId: string): Promise<MemoryResult<void>>;

  // Entries
  addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryResult<MemoryEntry>>;
  getEntries(options: MemoryQueryOptions): Promise<MemoryResult<MemoryEntry[]>>;
  getEntry(entryId: string): Promise<MemoryResult<MemoryEntry | null>>;
  deleteEntry(entryId: string): Promise<MemoryResult<void>>;
  clearThread(threadId: string): Promise<MemoryResult<void>>;
  // Optional, in every built-in adapter: text, tool arguments and results become '[redacted]',
  // place, role and call ids stay, metadata.redacted records { at, reason? }. Null for a missing
  // entry, an event entry such as a compaction refused
  redactEntry?(
    entryId: string,
    redaction: EntryRedaction
  ): Promise<MemoryResult<MemoryEntry | null>>;

  // Lifecycle
  connect(): Promise<MemoryResult<void>>;
  disconnect(): Promise<MemoryResult<void>>;
}
```

### MemoryResult

Adapter calls never throw for storage failures; they return a result. `unwrap()` returns the data or throws:

```typescript
type MemoryResult<T> = { success: true; data: T } | { success: false; error: string };
```

```typescript
import { unwrap } from '@cogitator-ai/memory';

const memory = await cog.getMemory();
if (memory) {
  const entries = unwrap(await memory.getEntries({ threadId: 'thread-1', limit: 20 }));
  for (const entry of entries) console.log(entry.message.role, entry.message.content);
}
```

### Thread, MemoryEntry, MemoryQueryOptions

```typescript
interface Thread {
  id: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
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

See [Memory Adapters](https://cogitator.app/docs/memory/adapters) for facts, embeddings and hybrid search.

### Memory upkeep

The pieces behind `memory.brief`, `memory.observations` and `memory.consolidation`, for use without a Cogitator:

```typescript
import {
  MemoryBriefer,
  MemoryConsolidator,
  MemoryFiles,
  MemoryItems,
  MemoryObservations,
} from '@cogitator-ai/memory';

// Cards for a turn, each quoting its source: { kind, text, quote, source }
const cards = await new MemoryBriefer({ summarize, maxCards: 4 }).brief(input, sources);

// Observations of entities as memory files under /memories/observations/
const observations = new MemoryObservations({ files, items, itemAdapter: memory });
await observations.refresh(scope, { summarize, maxEntities: 3, minItems: 3 }); // { written, deleted }
await observations.read(scope); // MemoryObservation[]

// Repeats marked stale, lessons folded into /memories/playbook.md
const consolidator = new MemoryConsolidator({ items, itemAdapter: memory, files });
await consolidator.dedupe(scope, { summarize, since, maxChanges: 10, maxSubjects: 10 }); // { stale, complete, through? }
await consolidator.foldLessons(scope, { summarize, mode: 'apply' }); // PlaybookChange | undefined
await consolidator.promotePlaybook(scope); // a shadow draft made the playbook, false when it is stale

// Helpers they build on
await files.put(access, '/memories/notes.md', text, expectedSha256OrNull); // a whole file, created or replaced
await items.markStale(itemIds, { reason: 'duplicate', keptId }, ['active']); // the ids it marked, only items still active
```

`memoryBriefMiddleware(config, deps)` and `memoryUpkeepMiddleware(config, deps)` from `@cogitator-ai/core` are the run middleware a Cogitator builds from the config, exported for a runtime of your own. See [Between Runs](https://cogitator.app/docs/memory#between-runs).

### Memory cascades

The lineage cascades behind `cog.forget`, `cog.redactEntries` and `cog.rewind`, for stores of your own:

```typescript
import { MemoryCascade, MemoryItems } from '@cogitator-ai/memory';

// stores: items a MemoryItemAdapter, files a MemoryFileAdapter, all but memory optional
const cascade = new MemoryCascade({
  memory,
  items: memory,
  files: memory,
  graph,
  facts,
  embeddings,
});
const who = { agentIds: ['assistant'], keepReplies: false }; // whose items, files, facts and graph to go through

await cascade.deleteEntries(entryIds, who); // a user message takes its replies unless keepReplies
await cascade.redactEntries(entryIds, { at: new Date(), reason: 'erasure request' }, who); // needs redactEntry
await cascade.deleteThread(threadId, who); // also purges the thread's own items and entities, redacts its files
await cascade.deleteUser(userId, who); // every thread with metadata.userId, the user's scope, owned facts and graph
await cascade.rewind(threadId, toEntryId, who); // items standing only on the turns after it marked stale

// MemoryCascadeReport
interface MemoryCascadeReport {
  entries: { deleted: string[]; redacted: string[] };
  threads: string[];
  summaries: string[]; // compaction entries deleted, the next compaction writes them again
  items: { purged: string[]; trimmed: string[]; stale: string[] };
  entities: string[];
  facts: { deleted: string[]; trimmed: string[] };
  graph: { nodes: string[]; edges: string[]; trimmed: string[] };
  fileVersions: string[]; // memory file versions redacted
  playbookRules: number; // rules taken out of a playbook in front
}

// MemoryItems: keeps the evidence pieces keep takes, returns the ids it changed
await new MemoryItems({ adapter: memory }).reviseEvidence(
  itemIds,
  (piece) => !gone.has(piece.entryId ?? '')
);
```

With deleted or redacted entries go the compaction summaries that cover or quote them, the memory items, facts and graph nodes and edges that stand only on them (the others lose those quotes), their vectors, the memory file versions written at them and every version of an observation or a playbook that names an item or a lesson that went. `redactedEntry(entry, redaction)` and `REDACTED_TEXT` build a redacted entry for an adapter of your own. See [Forgetting, Redacting and Rewinding](https://cogitator.app/docs/memory#forgetting-redacting-and-rewinding).

---

## HTTP APIs

Cogitator itself is a library and serves no HTTP. Two packages expose it over HTTP.

### Server adapters

`@cogitator-ai/express`, `@cogitator-ai/fastify`, `@cogitator-ai/hono`, `@cogitator-ai/koa` and
`@cogitator-ai/tetsu` serve the agents, workflows and swarms you register with the same routes. Express
(`config.basePath`) and Fastify (`prefix`) mount them under `/cogitator` by default; Hono, Koa and Tetsu serve
them where you mount them.

```http
GET    /health                    # { status, uptime, timestamp }
GET    /ready
GET    /agents                    # name, description, tool names
POST   /agents/:name/run          # { input, context?, threadId? }
POST   /agents/:name/stream       # same body, SSE response
POST   /agents/:name/resume       # { threadId, decisions?, defaultDecision? }
GET    /threads/:id
POST   /threads/:id/messages      # { role, content, metadata? }
DELETE /threads/:id
GET    /tools
GET    /workflows
POST   /workflows/:name/run       # { input?, options? }
POST   /workflows/:name/stream
GET    /swarms
POST   /swarms/:name/run          # { input, context?, threadId?, timeout? }
POST   /swarms/:name/stream
GET    /swarms/:name/blackboard
GET    /openapi.json              # and Swagger UI at /docs
```

Authentication is a function you pass in the adapter config (`auth`); it reads the request and returns
`{ userId?, roles?, permissions?, metadata? }`. Throwing rejects the request with `401` (on Tetsu, returning
`undefined` does too). The `userId` it returns owns the threads that user creates. There are no routes to create, update or delete agents, and no run listing or
cancellation endpoints: agents are registered in code.

```typescript
import express from 'express';
import { CogitatorServer } from '@cogitator-ai/express';

const app = express();
const server = new CogitatorServer({
  app,
  cogitator: cog,
  agents: { assistant: agent },
  config: {
    auth: (req) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (token !== process.env.API_TOKEN) throw new Error('Unauthorized');
      return { userId: 'service' };
    },
  },
});
await server.init();
app.listen(3000);
```

See [Server Adapters](https://cogitator.app/docs/server-adapters) for responses, errors, the SSE protocol and
WebSocket, and [OpenAPI](https://cogitator.app/docs/server-adapters/openapi).

### OpenAI-compatible server

`@cogitator-ai/openai-compat` serves an OpenAI Assistants API (default port `8080`). With `apiKeys` set,
every route except `/health` requires `Authorization: Bearer <key>`. There is no `/v1/chat/completions`.

```http
GET    /health
GET    /v1/models

POST   /v1/assistants
GET    /v1/assistants
GET    /v1/assistants/:assistant_id
POST   /v1/assistants/:assistant_id
DELETE /v1/assistants/:assistant_id

POST   /v1/threads
GET    /v1/threads/:thread_id
POST   /v1/threads/:thread_id
DELETE /v1/threads/:thread_id
POST   /v1/threads/:thread_id/messages
GET    /v1/threads/:thread_id/messages
GET    /v1/threads/:thread_id/messages/:message_id

POST   /v1/threads/runs
POST   /v1/threads/:thread_id/runs
GET    /v1/threads/:thread_id/runs
GET    /v1/threads/:thread_id/runs/:run_id
POST   /v1/threads/:thread_id/runs/:run_id/cancel
POST   /v1/threads/:thread_id/runs/:run_id/submit_tool_outputs

POST   /v1/files
GET    /v1/files
GET    /v1/files/:file_id
GET    /v1/files/:file_id/content
DELETE /v1/files/:file_id
```

```typescript
import { createOpenAIServer } from '@cogitator-ai/openai-compat';

const server = createOpenAIServer(cog, {
  port: 8080,
  apiKeys: [process.env.OPENAI_COMPAT_KEY ?? ''],
  defaultModel: 'openai/gpt-5.5',
});
await server.start();
```

See [OpenAI Compatibility](https://cogitator.app/docs/integrations/openai-compat).

---

## Events

### Run callbacks

```typescript
const result = await cog.run(agent, {
  input: 'hello',
  stream: true,
  onRunStart: ({ runId, agentId, input, threadId }) => {},
  onToken: (token) => process.stdout.write(token),
  onReasoning: (delta) => {},
  onHandoff: ({ from, to }) => {},
  onToolCall: (call) => console.log('Tool:', call.name),
  onToolResult: (result) => {},
  onSpan: (span) => {},
  onRunComplete: (result) => {},
  onRunError: (error, runId) => {},
  onMemoryError: (error, operation) => {},
});
```

### Run middleware

Callbacks and observers only watch a run. `RunMiddleware` changes it, in `middleware` of the Cogitator, the agent or the run:

```typescript
import { tripwire, type RunMiddleware } from '@cogitator-ai/core';

const guard: RunMiddleware = {
  name: 'guard',
  beforeRun: ({ input }) => {
    if (input.includes('DROP TABLE')) tripwire('SQL in the input');
  },
  beforeModel: ({ messages }, context) => undefined, // or { messages } to change the conversation
  wrapModelCall: (call, next, context) => next(call), // call.request, call.model, call.stream
  afterModel: ({ response }) => undefined, // or { content } / { toolCalls }
  wrapToolCall: (call, next, context) => next(call), // call.toolCall, call.args, call.approved
};
```

The Cogitator's middleware runs outermost, then the agent's, then the run's, then the built-in PII masking, prompt injection, guardrails, compaction and memory (extraction, compaction of the thread, upkeep and the pre-turn brief). See [Run Middleware](https://cogitator.app/docs/core/middleware).

### Workflow callbacks

```typescript
const result = await executor.execute(workflow, undefined, {
  onNodeStart: (node) => {},
  onNodeComplete: (node, output, duration) => {},
  onNodeError: (node, error) => {},
  onNodeProgress: (node, progress) => {},
});

for await (const event of executor.stream(workflow)) {
  // workflow_started, node_started, node_progress, node_completed, node_error, workflow_completed
  console.log(event.type);
}
```

### Swarm events

```typescript
const unsubscribe = team.on('agent:start', (event) => {});
team.on('agent:complete', (event) => {});
team.on('agent:error', (event) => {});
team.on('message:sent', (event) => {});
team.on('swarm:complete', (event) => {});

// Every event
team.on('*', (event) => console.log(event.type, event.agentName, event.data));

unsubscribe();
```

`SwarmEventType` also covers `swarm:start`, `swarm:error`, `swarm:paused`, `swarm:resumed`, `swarm:aborted`,
`swarm:reset`, `message:received`, `blackboard:write`, and strategy events (`consensus:*`, `auction:*`,
`debate:*`, `pipeline:*`, `round-robin:assigned`, `negotiation:*`, `assessor:complete`).

---

## Errors

Cogitator throws a single `CogitatorError` class with typed codes:

```typescript
import { CogitatorError, ErrorCode } from '@cogitator-ai/core';

try {
  await cog.run(agent, { input: '...' });
} catch (error) {
  if (CogitatorError.isCogitatorError(error)) {
    switch (error.code) {
      case ErrorCode.TOOL_EXECUTION_FAILED:
        console.log('Tool failed:', error.message, error.details);
        break;
      case ErrorCode.LLM_RATE_LIMITED:
        if (error.retryable) console.log('Retry after', error.retryAfter, 'ms');
        break;
      case ErrorCode.LLM_QUOTA_EXCEEDED:
        console.log('Out of credits or over a quota:', error.details?.kind);
        break;
      case ErrorCode.THREAD_ACCESS_DENIED:
        console.log('Thread belongs to another user');
        break;
    }
  }
}
```

#### ErrorCode

String enum (each value equals its name), `ERROR_STATUS_CODES` maps each to an HTTP status (`RUN_TIMEOUT` 504, `BUDGET_EXCEEDED` 429, `LLM_CONTENT_FILTERED` 400, `LLM_QUOTA_EXCEEDED` 402).

Errors of model provider calls are `LLMError`s with a `kind` (also `details.kind`, type `LLMErrorKind`): `rate_limit`, `quota`, `authentication`, `permission`, `not_found`, `invalid_request`, `context_overflow`, `content_filter`, `overloaded`, `server_error`, `timeout`, `network` or `invalid_response`, read from the provider's own error codes. A `quota` error is `LLM_QUOTA_EXCEEDED` and never retried. A call the caller aborts fails with the abort reason.

`cog.run()` throws a `CogitatorError` when the run hits its `timeout` (`Run timed out after <n>ms` → `RUN_TIMEOUT`, with what the finished model calls used and cost in `details.usage`), when cost routing finds the budget exceeded (`Budget exceeded: …` → `BUDGET_EXCEEDED`), when guardrails block the input or output (`Input blocked: …` / `Output blocked: …` → `LLM_CONTENT_FILTERED`, with `details.harmScores`), and when a run middleware calls `tripwire()` (`Guardrail "<name>" tripped: …` → `GUARDRAIL_TRIPPED` 400, with `details.middleware`, `details.reason` and `details.info`), so server adapters answer with that status and message.

```typescript
enum ErrorCode {
  // LLM
  LLM_UNAVAILABLE,
  LLM_RATE_LIMITED,
  LLM_TIMEOUT,
  LLM_INVALID_RESPONSE,
  LLM_CONTEXT_LENGTH_EXCEEDED,
  LLM_CONTENT_FILTERED,
  LLM_QUOTA_EXCEEDED,

  // Sandbox
  SANDBOX_UNAVAILABLE,
  SANDBOX_TIMEOUT,
  SANDBOX_OOM,
  SANDBOX_EXECUTION_FAILED,
  SANDBOX_INVALID_MODULE,

  // Tools
  TOOL_NOT_FOUND,
  TOOL_INVALID_ARGS,
  TOOL_EXECUTION_FAILED,
  TOOL_TIMEOUT,

  // Memory and threads
  MEMORY_UNAVAILABLE,
  MEMORY_WRITE_FAILED,
  MEMORY_READ_FAILED,
  THREAD_ACCESS_DENIED,

  // Agents and runs
  AGENT_NOT_FOUND,
  AGENT_ALREADY_RUNNING,
  AGENT_MAX_ITERATIONS,
  RUN_TOKEN_LIMIT_EXCEEDED,
  RUN_NOT_PAUSED,
  RUN_TIMEOUT,
  BUDGET_EXCEEDED,

  // Workflows
  WORKFLOW_NOT_FOUND,
  WORKFLOW_STEP_FAILED,
  WORKFLOW_CYCLE_DETECTED,

  // Swarms
  SWARM_NO_WORKERS,
  SWARM_CONSENSUS_FAILED,

  // Security
  PROMPT_INJECTION_DETECTED,
  PII_DETECTED,
  GUARDRAIL_TRIPPED, // a middleware tripwire() stopped the run

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
  constructor(options: {
    message: string;
    code: ErrorCode;
    statusCode?: number; // default: ERROR_STATUS_CODES[code]
    details?: Record<string, unknown>;
    cause?: Error;
    retryable?: boolean; // default: false
    retryAfter?: number; // ms
  });

  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly retryAfter?: number;

  toJSON(): Record<string, unknown>;
  static isCogitatorError(error: unknown): error is CogitatorError;
  static wrap(error: unknown, code?: ErrorCode): CogitatorError; // default code: INTERNAL_ERROR
}
```

`isRetryableError(error)` and `getRetryDelay(error)` are exported alongside it.

---

## TypeScript Types

All shared types live in `@cogitator-ai/types`; `@cogitator-ai/core` re-exports the common ones
(`AgentConfig`, `Tool`, `ToolConfig`, `RunOptions`, `RunResult`, `CogitatorConfig`, `Message`, `LLMBackend`, ...).

```typescript
import type {
  // Agents and tools
  AgentConfig,
  ResponseFormat,
  ReasoningConfig,
  Tool,
  ToolConfig,
  ToolContext,
  ToolSchema,
  ToolContentResult, // what toolContent() returns
  ToolContentPart, // text, image, file, json or resource

  // Runs
  CogitatorConfig,
  RunOptions,
  RunResult,
  ResumeOptions,
  RunCheckpoint,
  ToolApprovalRequest,
  ToolApprovalDecision,
  HandoffEvent,
  Span,

  // Workflows
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

  // Swarms
  SwarmConfig,
  SwarmRunOptions,
  SwarmResult,
  SwarmStrategy,
  SwarmEvent,
  SwarmEventType,

  // Memory
  MemoryConfig,
  MemoryAdapter,
  MemoryResult,
  MemoryEntry,
  MemoryQueryOptions,
  Thread,

  // Messages
  Message,
  ToolCall,
  ToolResult,

  // LLM
  LLMProvider,
  LLMBackendProvider, // LLMProvider or the name of your own backend
  LLMBackend,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator-ai/types';
```
