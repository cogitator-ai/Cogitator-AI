/**
 * Runtime types for Cogitator
 */

import type { Message, ToolCall, ToolCallMessage, ToolResult, ToolResultMessage } from './message';
import type {
  Tool,
  ToolInputAbandoned,
  ToolInputAvailable,
  ToolInputDelta,
  ToolInputStart,
  ToolProgress,
} from './tool';
import type {
  LLMBackend,
  LLMProvider,
  LLMProvidersConfig,
  ModelPriceConfig,
  LLMRetryConfig,
  PromptCacheConfig,
  ReasoningConfig,
  ToolChoice,
} from './llm';
import type { MemoryConfig, MemoryEntry } from './memory';
import type { SandboxManagerConfig } from './sandbox';
import type { ReflectionConfig, Reflection, ReflectionSummary } from './reflection';
import type { GuardrailConfig } from './constitutional';
import type { CostRoutingConfig } from './cost-routing';
import type { PiiConfig, PromptInjectionConfig } from './security';
import type { DeployConfig } from './deploy';
import type { DecisionBackend } from './decision';
import type { ContextManagerConfig } from './context';
import type { RunMiddleware } from './middleware';
import type { Workspace } from './workspace';
import type { TodoItem } from './todos';
import type { LoggingConfig } from './logging';
import type { ABTestStore, ABTestVariant, InstructionVersionStore } from './prompt-optimization';
import type { MultitaskStrategy, QueuedRunMessage, RunInterrupt } from './run-control';

/**
 * Where a run's spans go in a distributed trace: the trace they join and the span that is the
 * parent of the run's root span. W3C ids: 32 lowercase hex characters for the trace, 16 for the
 * span.
 */
export interface TraceParent {
  traceId: string;
  parentSpanId?: string;
}

/** Telemetry settings of a runtime. */
export interface TelemetryConfig {
  /**
   * Record the GenAI content attributes on the spans: what the model was sent and answered
   * (`gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`,
   * `gen_ai.tool.definitions`) and tool arguments and results (`gen_ai.tool.call.arguments`,
   * `gen_ai.tool.call.result`). Off by default: prompts and answers are often sensitive and large.
   * Cogitator's own `tool.arguments`, `tool.error` and `decision.answers` attributes are recorded
   * as before, whatever this says.
   */
  captureContent?: boolean;
}

/**
 * Sees every run of a `Cogitator`, next to the callbacks a single run passes.
 * An observer that throws is logged and never fails the run.
 */
export interface RunObserver {
  /**
   * This observer wants model and tool content on its spans (see
   * `TelemetryConfig.captureContent`). Content is recorded while such an observer watches, and
   * only observers that asked for it receive it.
   */
  captureContent?: boolean;
  onRunStart?(event: {
    runId: string;
    agentId: string;
    agentName: string;
    input: string;
    threadId: string;
    model?: string;
  }): void;
  /** A finished span of the run, with the id of the run it belongs to. */
  onSpan?(span: Span, run: { runId: string }): void;
  onRunComplete?(result: RunResult): void;
  /** The todo list of the run each time `write_todos` changes it, see `RunOptions.onTodos` */
  onTodos?(todos: readonly TodoItem[], run: { runId: string }): void;
  /**
   * A run that failed, with what its finished model calls used and cost:
   * a run cut short by its timeout or an abort still spent them.
   */
  onRunError?(error: Error, runId: string, usage?: RunUsage): void;
  /** Called by `cogitator.close()`: send what is still buffered and release resources. */
  close?(): Promise<void> | void;
}

export interface CogitatorConfig {
  llm?: {
    defaultProvider?: LLMProvider;
    defaultModel?: string;
    providers?: LLMProvidersConfig;
    /**
     * Backends of your own, by name: an agent with model `name/model` (or
     * `provider: 'name'`) runs on it. A name of a built-in provider replaces it.
     */
    backends?: Record<string, LLMBackend>;
    /**
     * Decision model providers of your own, by provider name, for
     * `cog.decide()`. OpenRouter is built in, from `providers.openrouter`.
     */
    decisionBackends?: Record<string, DecisionBackend>;
    /** Configuration passed to backend plugins registered with `registerLLMBackend`, by provider name. */
    plugins?: Record<string, unknown>;
    /**
     * Retries for failed LLM calls, on every backend the runtime uses; `false`
     * turns them off. On by default: 2 retries with exponential backoff.
     */
    retry?: LLMRetryConfig | false;
    /**
     * Prices of your own, in USD per million tokens, by model: for a fine-tune, a model the
     * catalogue does not list yet, a negotiated rate or a self-hosted model you want to cost.
     * They win over the model registry for calls whose provider reports no cost. A key is the
     * model string a run uses or its tail after any `/`: `openai/gpt-4o` prices that model
     * string and the ones ending in it (`openrouter/openai/gpt-4o`), `gpt-4o` the model at every
     * provider that serves it under that name. Ollama and vLLM models are free without one.
     */
    pricing?: Record<string, ModelPriceConfig>;
    /**
     * Prompt caching for agent runs; `false` turns it off. On by default:
     * Anthropic requests mark their stable prefix for caching, and every
     * provider's cache hits lower the run's cost.
     */
    promptCache?: PromptCacheConfig | false;
    /**
     * When a model an agent falls back from (`fallbackModels`) is skipped. Each model has its
     * own breaker, shared by every run of this runtime: after `failureThreshold` failures in a
     * row, or at once for an out-of-quota account, a rejected key or a missing model, turns go
     * straight to the next model for `resetTimeout` ms, and then try it again.
     */
    modelCircuitBreaker?: ModelCircuitBreakerConfig;
  };
  /**
   * Where paused runs are kept. Defaults to the memory adapter's threads (so
   * pauses last as long as the memory does), or to process memory without one.
   */
  runCheckpoints?: RunCheckpointStore;
  /**
   * What a run on a thread does while another run of this runtime goes on there (see
   * `MultitaskStrategy`), for runs that set no `multitaskStrategy` of their own. Unset, runs of
   * one thread go on side by side, as they always did
   */
  multitaskStrategy?: MultitaskStrategy;
  /**
   * Watch every run of this runtime, whoever starts it: a script, a server
   * adapter, a workflow node or a swarm. Exporters such as `OTLPExporter` and
   * `LangfuseExporter` give one with `observer()`.
   */
  observers?: RunObserver[];
  /** Telemetry settings: content capture for the spans of every run. */
  telemetry?: TelemetryConfig;
  /**
   * Hooks around the model and tool calls of every run of this runtime, outermost, before the
   * agent's and the run's own (see `RunMiddleware`). Their `wrapToolCall` also wraps tool
   * calls made with `invokeTool()`.
   */
  middleware?: RunMiddleware[];
  /**
   * Versioned instructions and A/B tests. Runs of an agent with a deployed
   * version use its instructions; while an A/B test runs, each thread gets
   * one variant. Every run's outcome is recorded against what it used.
   */
  prompts?: PromptsConfig;
  limits?: {
    maxConcurrentRuns?: number;
    defaultTimeout?: number;
    maxTokensPerRun?: number;
    /**
     * Most characters of a tool's result the model reads (default 100 000, about 25 000
     * tokens). A longer result is cut in the middle, with a note of how much was left out, so
     * one huge output cannot fill the context. A tool's own `maxResultLength` overrides it. The
     * application still gets the whole result, in `onToolResult`.
     */
    maxToolResultLength?: number;
    /**
     * Milliseconds the full text of long tool results stays in a run's workspace
     * (`.cogitator/tool-results/<runId>/`, see `RunOptions.workspace`): saving a result removes
     * the folders of runs older than this. Default: 7 days, `Infinity` keeps them all
     */
    toolResultRetention?: number;
  };
  memory?: MemoryConfig;
  /** Sandbox configuration for isolated tool execution */
  sandbox?: SandboxManagerConfig;
  /** Reflection configuration for self-analyzing agents */
  reflection?: ReflectionConfig;
  /** Constitutional AI guardrails; fields left out take `DEFAULT_GUARDRAIL_CONFIG`. On unless `enabled: false`. */
  guardrails?: Partial<GuardrailConfig>;
  /** Cost-aware model routing configuration */
  costRouting?: CostRoutingConfig;
  /** Prompt injection detection and PII masking */
  security?: {
    /** Prompt injection detection; fields left out take the detector's defaults */
    promptInjection?: Partial<PromptInjectionConfig>;
    /** Keep personal data and secrets away from the model provider */
    pii?: PiiConfig;
  };
  /** Context management for long conversations (128k+ tokens) */
  context?: ContextManagerConfig;
  logging?: LoggingConfig;
  deploy?: DeployConfig;
}

/** See `CogitatorConfig.llm.modelCircuitBreaker`. */
export interface ModelCircuitBreakerConfig {
  /** Failures in a row that make a model be skipped (default 5) */
  failureThreshold?: number;
  /** How long a failing model is skipped, in ms (default 30 000) */
  resetTimeout?: number;
  /** Calls that must succeed after `resetTimeout` before the model counts as healthy (default 3) */
  halfOpenRequests?: number;
}

/** A turn of a run moved from one model to the next of the agent's `fallbackModels`. */
export interface ModelFallbackEvent {
  /** The model that failed, as `provider/model` */
  from: string;
  /** The model the turn goes on with, as `provider/model` */
  to: string;
  /** Why `from` failed: its error, or a `CIRCUIT_OPEN` error when it was skipped */
  error: Error;
}

/** A model turn of a run, as the run keeps it: after every `afterModel` middleware. */
export interface KeptModelTurn {
  /** The turn's text, empty when it only calls tools */
  content: string;
  /** The tool calls the turn asks for, none on a final answer */
  toolCalls: ToolCall[];
  /** The model that answered, as `provider/model` */
  model: string;
}

export type ImageInput =
  string | { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' };

export type AudioFormat = 'mp3' | 'mp4' | 'mpeg' | 'mpga' | 'm4a' | 'wav' | 'webm' | 'ogg' | 'flac';

export type AudioInput = string | { data: string; format: AudioFormat };

export interface RunOptions<TDeps = unknown> {
  input: string;
  /** Images to include with the input. Can be URLs or base64 encoded data. */
  images?: ImageInput[];
  /** Audio files to transcribe and include with the input. Can be URLs or base64 encoded data. */
  audio?: AudioInput[];
  /** Data added to the system prompt for this run, as JSON: the model reads it */
  context?: Record<string, unknown>;
  /**
   * Your own values for the run's tools, such as a database client, a logger or the signed-in
   * user: tools get them as `context.deps`. Unlike `context`, they never reach the model, the
   * memory, spans or a paused run's checkpoint, so pass them again to `resume()`. Required when
   * the agent declares its deps type (`new Agent<Deps>(...)`)
   */
  deps?: TDeps;
  /**
   * The workspace for this run, instead of the agent's `workspace`: tools get it as
   * `context.workspace`, and a tool result too long for the model is saved there in full, the
   * model gets a preview and the path to read the rest from. Like `deps` it is not kept in a
   * paused run's checkpoint, so pass it again to `resume()`. The run only uses it, whoever
   * created it starts and disposes it
   */
  workspace?: Workspace;
  threadId?: string;
  /** Milliseconds the whole run may take (`RUN_TIMEOUT`), see also `timeouts` */
  timeout?: number;
  /**
   * Deadlines of the stages of the run, over the agent's `timeouts` field by field. Each unset
   * one is off, `totalMs` falls back to `timeout`
   */
  timeouts?: RunTimeouts;
  /** Abort signal for cancelling the run. */
  signal?: AbortSignal;
  stream?: boolean;
  onToken?: (token: string) => void;
  /**
   * Pieces of the model's reasoning summary while streaming: needs `stream: true` and
   * `reasoning.summary`, with or without `onToken`
   */
  onReasoning?: (delta: string) => void;
  /** Called when an agent hands the conversation over to another */
  onHandoff?: (handoff: HandoffEvent) => void;
  /** Called when a turn moves from a failing model to the next of the agent's `fallbackModels` */
  onModelFallback?: (event: ModelFallbackEvent) => void;
  /**
   * Called for each model turn the run keeps, before its tool calls run: the text and calls as
   * every `afterModel` middleware left them. A run without `stream: true` gets the text of
   * turns that call tools only from here
   */
  onModelTurn?: (turn: KeptModelTurn) => void;
  /**
   * Whether an aborted run saves the text it already streamed to `onToken` as an assistant
   * message with `metadata.interrupted: true` (default true). Turn it off when your code keeps
   * what the user really got itself, as a voice runner keeps only what was spoken
   */
  saveInterruptedReply?: boolean;
  /** Overrides the agent's `reasoning` for this run */
  reasoning?: ReasoningConfig;
  /**
   * Which tools the model may or must call. `'none'` keeps it from calling any on every turn.
   * `'required'` or a named function forces a call on each turn until the model makes one,
   * then the run goes back to `'auto'` so the model can answer from the results (forcing it on
   * every turn would loop until `maxIterations`). A named function the agent does not have
   * fails the run with `VALIDATION_ERROR`.
   */
  toolChoice?: ToolChoice;
  /**
   * Decides tool calls that need approval (`requiresApproval`) while the run
   * waits. Return `{ approved }` to go on, or `'pause'` to pause the run: it
   * returns with `status: 'paused'`, the calls in `pendingApprovals` and a
   * `checkpoint` to continue from with `cogitator.resume()`. Return `undefined`
   * to leave a call to `guardrails.onToolApproval`, as if there were no
   * `onApproval`. Without either, such calls always pause the run.
   */
  onApproval?: (
    request: ToolApprovalRequest
  ) =>
    | ToolApprovalDecision
    | 'pause'
    | undefined
    | Promise<ToolApprovalDecision | 'pause' | undefined>;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  /** What a running tool has so far, each time it reports it with `context.update()` */
  onToolUpdate?: (update: ToolUpdate) => void;
  /**
   * The model began to write a tool call: its id and name, before the arguments. Needs
   * `stream: true`, as do `onToolInputDelta` and `onToolInputAvailable`. A backend that gets whole
   * calls only (Gemini, Ollama) reports each call in one piece when it arrives
   */
  onToolInputStart?: (event: ToolInputStart) => void;
  /** The next piece of the JSON arguments of the call the model writes, see `onToolInputStart` */
  onToolInputDelta?: (event: ToolInputDelta) => void;
  /**
   * A call the model wrote is complete, with its arguments read, see `onToolInputStart`. It may
   * still not run: a turn cut at the token limit keeps no calls, and an `afterModel` middleware
   * may change them. `onToolCall` reports the calls that run
   */
  onToolInputAvailable?: (event: ToolInputAvailable) => void;
  /**
   * A call the model began to write will not run: its arguments never came complete (the turn
   * was cut at the token limit, failed or was aborted), or the turn did not keep it (an
   * `afterModel` middleware, a turn that may not call tools). Every call `onToolInputStart`
   * reported ends in `onToolCall` or here
   */
  onToolInputAbandoned?: (event: ToolInputAbandoned) => void;
  /**
   * The agent's todo list each time `write_todos` changes it (`AgentConfig.todos`), the whole
   * list every time
   */
  onTodos?: (todos: readonly TodoItem[]) => void;

  /** Enable/disable memory for this run. Default: true if adapter configured */
  useMemory?: boolean;
  /** Load conversation history from memory. Default: true */
  loadHistory?: boolean;
  /**
   * The conversation before `input`, as the caller holds it: the run reads it instead of the
   * thread's history in memory. User, assistant and tool messages only, since the agent's
   * instructions are the system prompt. `saveHistory` still saves only the new turn, never these.
   * What memory recalls for the turn (facts, retrieved items) still comes with the input, and the
   * history is sent as given: trim a long one yourself, the context budget applies to memory only.
   */
  history?: Array<Message | ToolCallMessage | ToolResultMessage>;
  /** Save messages to memory after each turn. Default: true */
  saveHistory?: boolean;

  /** Callback when run starts */
  onRunStart?: (data: { runId: string; agentId: string; input: string; threadId: string }) => void;
  /** Callback when run completes */
  onRunComplete?: (result: RunResult) => void;
  /** Callback when run fails, with what its finished model calls used and cost */
  onRunError?: (error: Error, runId: string, usage?: RunUsage) => void;
  /** Callback when a span is created */
  onSpan?: (span: Span) => void;
  /**
   * The trace this run joins: its root span becomes a child of `parentSpanId`. Without it, a run
   * started inside a tool of another run joins that run's trace under the tool's span, and any
   * other run starts a trace of its own.
   */
  trace?: TraceParent;
  /** Callback when memory operation fails */
  onMemoryError?: (error: Error, operation: 'save' | 'load') => void;
  /**
   * Called with each entry the run saved to its thread, once the write succeeded: the input, each
   * model turn, tool results and session events such as an `interrupt`. An aborted or failed run
   * reports what it wrote too, before its promise rejects, so a caller knows the run's place in
   * the thread without a `RunResult`. The run does not wait for it: an error it throws, or a
   * promise it returns that rejects, is logged.
   */
  onMemoryEntry?: (entry: MemoryEntry) => unknown;
  /**
   * Runs on a branch of the thread: history is read along the branch ending at `fromEntryId`
   * (null for none, a new root), and the run's entries go after it, one after another. With
   * `activate: false` the thread's active leaf stays where it was, so a fork or a replay writes
   * a branch of its own while the conversation goes on; true by default. Such a run does not
   * take the thread's place for a paused run: when it pauses, resume it with its checkpoint, not
   * its thread id. Needs a memory adapter with branches (every built-in one).
   */
  branch?: { fromEntryId: string | null; activate?: boolean };
  /**
   * Notes for this turn only, such as the current time, sent with the input after what memory
   * recalls for it (the `brief` partition of a context). They are not saved with the input and,
   * unlike the system prompt, do not change the prefix later turns read from the prompt cache.
   */
  brief?: string;
  /**
   * The moment memory reads the turn at, the clock by default: what a turn's "yesterday" or
   * "now" means when memory is searched, and which memory items hold. Set it to replay a
   * conversation or evaluate one recorded at another time.
   */
  asOf?: Date;

  /**
   * Run the tool calls of a step that are safe to run together at the same time
   * (`isConcurrencySafe`, by default a tool's `annotations.readOnlyHint`), at most
   * `maxParallelToolCalls` at once. A call that is not safe waits for the calls before it and
   * runs alone. Results reach the conversation in the order of the calls either way. Default:
   * false, every call runs after the one before it
   */
  parallelToolCalls?: boolean;
  /** Most calls of a step that run at once with `parallelToolCalls` (default 10) */
  maxParallelToolCalls?: number;

  /**
   * What the run does when another run of this runtime goes on in its thread (`threadId`), see
   * `MultitaskStrategy`. Overrides `CogitatorConfig.multitaskStrategy`. Unset, both go on side by
   * side, as they always did. A run started from a tool call of the run going on is
   * never held back, it would wait for itself. A run on a branch that leaves the active leaf
   * where it is (`branch.activate: false`) does not count as the thread's run
   */
  multitaskStrategy?: MultitaskStrategy;

  /**
   * Hooks around this run's model and tool calls, after the Cogitator's and the agent's
   * middleware (see `RunMiddleware`). Pass them again to `resume()`.
   */
  middleware?: RunMiddleware<TDeps>[];

  /**
   * The user the run acts for. It owns the threads the run creates, scopes the
   * facts and embeddings put into the context, and reaches tools as `context.userId`.
   */
  userId?: string;
  /**
   * Who may continue a given `threadId`. `'owner'` (default): only the user who
   * created the thread, so a client cannot read or extend another user's
   * conversation by sending its id; the run fails with `THREAD_ACCESS_DENIED`.
   * `'shared'`: anyone, for threads your server derives itself, such as a group
   * chat several users write to.
   */
  threadAccess?: 'owner' | 'shared';
  channelType?: string;
  channelId?: string;
  /** The topic of the chat the run serves (`ChannelMessage.topicId`), as its tools get it */
  topicId?: string;
  /** The conversation the run serves (`ChannelMessage.conversationId`), as its tools get it */
  conversationId?: string;
}

/**
 * Deadlines of the stages of a run, in ms, each off unless set:
 * - `totalMs`: the whole run, `RUN_TIMEOUT` (it replaces `timeout`)
 * - `stepMs`: one model call, from sending it to its last chunk, retries and fallback models
 *   included, `RUN_STEP_TIMEOUT`
 * - `chunkMs`: a streamed model call without a chunk for this long, the first one included,
 *   `RUN_CHUNK_TIMEOUT`
 * - `toolMs`: a tool call of a tool without a `timeout` of its own: the call fails with
 *   `errorCode: 'TOOL_TIMEOUT'` and the model reads why, the run goes on
 */
export interface RunTimeouts {
  totalMs?: number;
  stepMs?: number;
  chunkMs?: number;
  toolMs?: number;
}

/** What a running tool reported with `context.update()`, see `RunOptions.onToolUpdate` */
export interface ToolUpdate extends ToolProgress {
  callId: string;
  name: string;
}

/**
 * `deps` as a run of an agent with deps type `TDeps` must pass them: required when the agent
 * declares its deps type, optional otherwise.
 */
export type RunDeps<TDeps> = unknown extends TDeps ? { deps?: unknown } : { deps: TDeps };

export interface PromptsConfig {
  /** Default: in process memory */
  versions?: InstructionVersionStore;
  /** Default: in process memory */
  abTests?: ABTestStore;
  /** Score of a completed run, 0 – 1, for version metrics and A/B tests. Default: 1 */
  score?: (result: RunResult) => number | Promise<number>;
  /** Deploy the winning instructions when an A/B test completes with a significant winner */
  autoDeployWinner?: boolean;
}

/** The versioned instructions a run used. */
export interface RunPrompt {
  /** Instructions are versioned per agent `id` when it was set explicitly, else per `name` */
  key: string;
  versionId?: string;
  version?: number;
  abTest?: { id: string; variant: ABTestVariant };
}

/** The conversation went from one agent to another. */
export interface HandoffEvent {
  from: string;
  to: string;
  reason?: string;
}

/** A tool call waiting for a person to approve it. */
export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description: string;
  /** What the tool touches, as it declares (`sideEffects`) */
  sideEffects?: string[];
  /** The agent a call made with `invokeTool` is made for, as its options name it */
  agentId?: string;
  /** The thread a call made with `invokeTool` belongs to, as its options name it */
  threadId?: string;
  /** The user a call made with `invokeTool` acts for, as its options name it */
  userId?: string;
}

export type ToolApprovalDecision = { approved: true } | { approved: false; reason?: string };

/** The agent a tool call made outside a run belongs to, see `ToolInvocationOptions.agent`. */
export interface ToolInvocationAgent {
  readonly id: string;
  readonly name: string;
  readonly model: string | undefined;
  readonly config: {
    readonly middleware?: readonly RunMiddleware[];
    readonly workspace?: Workspace;
  };
}

/** Options of one tool call made outside an agent run, see `ToolInvoker`. */
export interface ToolInvocationOptions {
  /** Id of the call, reported back as `callId` (default: a fresh id) */
  toolCallId?: string;
  /** Run and agent the call is made for, as the tool's context reports them */
  runId?: string;
  agentId?: string;
  /**
   * The agent the call is made for, so it gets the gates a run of that agent applies: the
   * guardrails are built with its model unless `guardrails.model` is set (as for a run, the
   * first call or run builds them), its `middleware` wraps the call after the Cogitator's, and
   * its id and name are the call's `agentId` and `agentName` unless `agentId` is set
   */
  agent?: ToolInvocationAgent;
  /** Cancels the call */
  signal?: AbortSignal;
  /** What the tool has so far, each time it reports it with `context.update()` */
  onUpdate?: (update: ToolUpdate) => void;
  threadId?: string;
  /** The user the call acts for */
  userId?: string;
  channelType?: string;
  channelId?: string;
  topicId?: string;
  conversationId?: string;
  /**
   * More fields for the tool's context, e.g. an MCP server's `elicit`. They cannot replace
   * `agentId`, `runId` or `signal`
   */
  context?: Record<string, unknown>;
  /**
   * `deps` for the tool, as a run passes them (`RunOptions.deps`)
   */
  deps?: unknown;
  /** The workspace the tool gets as `context.workspace` (default: the `agent`'s workspace) */
  workspace?: Workspace;
  /**
   * Decides a call that needs approval (`requiresApproval`, or the guardrails), as
   * `RunOptions.onApproval` does in a run. Without it `guardrails.onToolApproval` decides. A call
   * nobody decides, or one answered with `'pause'`, is refused: there is no run to pause, so the
   * result carries the request in `pendingApproval`
   */
  onApproval?: RunOptions['onApproval'];
}

/** What a tool call made outside a run returned, see `ToolInvoker`. */
export interface ToolInvocationResult extends ToolResult {
  /** The call needed approval that nobody gave, so the tool did not run */
  pendingApproval?: ToolApprovalRequest;
}

/**
 * Runs single tool calls the way an agent run does: arguments validated against the tool's
 * schema, approval asked for calls that need it, the guardrails applied, the sandbox used for
 * sandboxed tools, and `tool.timeout` kept. A `Cogitator` is one, so code that runs tools
 * outside a run (an MCP server, a self-modifying agent) takes it to honor all of that.
 */
export interface ToolInvoker {
  /**
   * Never throws for a failing tool: the error is in the result's `error`. An error a
   * `wrapToolCall` middleware of the Cogitator throws, and a `tripwire()` raised in the tool
   * itself (a nested agent run), are thrown, as they would fail a run.
   */
  invokeTool(
    tool: Tool,
    args: unknown,
    options?: ToolInvocationOptions
  ): Promise<ToolInvocationResult>;
}

/**
 * Everything needed to continue a paused run, as plain JSON: keep it on your
 * server (it holds the conversation) and hand it to `cogitator.resume()`.
 */
/** The part of a run's cost already counted, kept in checkpoints so a resumed run adds to it. */
export interface RunCostState {
  /** USD providers reported for their calls. */
  reportedUsd: number;
  /**
   * Tokens of calls whose provider reported no cost, kept before costs were kept per model, so
   * priced on the run's model. A checkpoint saved since then holds them in `unreportedByModel`.
   */
  unreported: RunCostTokens;
  /** Tokens of calls whose provider reported no cost, by the model each call used. */
  unreportedByModel?: Record<string, RunCostTokens>;
}

/** Tokens a run used, as its cost is counted. */
export interface RunCostTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Part of `cacheWriteTokens` written with the 1-hour TTL; missing in checkpoints saved before it existed */
  cacheWrite1hTokens?: number;
}

export interface RunCheckpoint {
  version: 1;
  runId: string;
  agentId: string;
  threadId: string;
  userId?: string;
  /** The model the run uses, and the provider it was routed to */
  model: string;
  provider?: string;
  input: string;
  messages: Message[];
  toolCalls: ToolCall[];
  prompt?: RunPrompt;
  /** The agent the run was in when it paused, after handoffs */
  activeAgent?: string;
  handoffs?: HandoffEvent[];
  /** The tool calls of the turn that paused, with the decisions made so far */
  turn: {
    toolCalls: ToolCall[];
    decisions: Record<string, ToolApprovalDecision>;
    /**
     * Calls of the turn that already ran, their results in `messages`: a pause on a question of a
     * tool keeps them in the turn so the resumed run does not run them again and still hands
     * over when one of them was a handoff. Missing when no call of the turn ran yet
     */
    completed?: string[];
  };
  /**
   * What the run waits on, approvals among them (`kind: 'approval'`), and the answers given so
   * far to the questions its tools asked. Missing in checkpoints saved before it existed
   */
  interrupts?: RunInterrupt[];
  /**
   * The iteration the run stops at, when a follow-up message moved it past `maxIterations`.
   * Missing when it is the agent's `maxIterations`
   */
  iterationLimit?: number;
  iterations: number;
  lastToolCallSignature: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /**
     * Cost so far: USD the providers reported, and the tokens of calls that reported none (priced
     * from the model registry). Missing in checkpoints saved before it existed, which then price
     * every token from the registry.
     */
    cost?: RunCostState;
  };
  reasoning: string[];
  startedAt: number;
  /**
   * The trace the paused run belongs to and its root span, so the resumed run continues the
   * trace under it. Missing in checkpoints saved before it existed
   */
  trace?: { traceId: string; rootSpanId: string };
  /**
   * Where the run writes next (`parentId`, after the thread's active leaf when absent) and where
   * it started writing (`branchPoint`), so the resumed run goes on along its branch and reports
   * the same place
   */
  branch?: { parentId?: string | null; activate: boolean; branchPoint?: string | null };
  /**
   * How the paused run ran its tools, so `resume()` runs them the same way unless its options
   * say otherwise. Missing in checkpoints saved before it existed
   */
  toolExecution?: {
    parallelToolCalls?: boolean;
    maxParallelToolCalls?: number;
    timeouts?: RunTimeouts;
  };
}

/** Where a run's entries went in the thread's tree of memory */
export interface RunMemoryPlace {
  readonly threadId: string;
  /** The entry the run's first entry went after, null for none */
  readonly branchPoint: string | null;
  /** The run's last entry */
  readonly leafId?: string;
}

/**
 * Where paused runs wait for their approvals, one per thread. The runtime
 * saves a run's checkpoint when it pauses and removes it once the run goes
 * on, so `cogitator.resume(agent, threadId)` finds it.
 */
export interface RunCheckpointStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(threadId: string): Promise<RunCheckpoint | null>;
  delete(threadId: string): Promise<void>;
}

/** Options for `cogitator.resume()`: run options, minus what the checkpoint fixes. */
export interface ResumeOptions<TDeps = unknown> extends Omit<
  RunOptions<TDeps>,
  'input' | 'images' | 'audio' | 'context' | 'threadId' | 'threadAccess' | 'history'
> {
  /**
   * Who resumes the run. When set, or when resuming by thread id, it must be
   * the user the run belongs to, or the resume fails with `THREAD_ACCESS_DENIED`.
   */
  userId?: string;
  /** Decisions for the paused calls, by tool call id; calls left out pause again */
  decisions?: Record<string, ToolApprovalDecision>;
  /** Decision for every paused call `decisions` leaves out, e.g. one "approve all" answer */
  defaultDecision?: ToolApprovalDecision;
  /**
   * Answers to the run's interrupts, by interrupt id (`RunResult.interrupts`). Each is checked
   * against the interrupt's `responseSchema`, an answer after its `expiresAt` fails the resume
   * with `INTERRUPT_EXPIRED`. An approval's answer is a decision (`{ approved, reason? }`), the
   * same as in `decisions`. Interrupts left out keep the run paused
   */
  responses?: Record<string, unknown>;
}

/** Why the model's last answer in a run was withheld; see `RunResult.blocked`. */
export type RunBlockReason = 'content_filter' | 'refusal';

/** What a run's model calls used and cost, so far or in all. */
export type RunUsage = RunResult['usage'];

export interface RunResult {
  readonly output: string;
  readonly structured?: unknown;
  /**
   * Why the final answer does not match the agent's `responseFormat`, after the one chance the
   * run gives the model to correct it, in the words the model was given: `structured` is then
   * absent. Unset when the answer matches or the agent asked for plain text
   */
  readonly structuredError?: string;
  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;
  /**
   * The model that gave the final answer, as `provider/model`, when it may differ from the
   * agent's `model`: cost routing picked it, or the turn fell back to one of `fallbackModels`
   */
  readonly modelUsed?: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly duration: number;
    /** Hidden reasoning tokens; already counted in `outputTokens` */
    readonly reasoningTokens?: number;
    /** Input tokens served from the prompt cache; already counted in `inputTokens` */
    readonly cachedInputTokens?: number;
    /** Input tokens written to the prompt cache; already counted in `inputTokens` */
    readonly cacheWriteTokens?: number;
  };
  /** The model's reasoning summary for the run, when the agent asked for one (`reasoning.summary`) */
  readonly reasoning?: string;
  /**
   * True when the model's last answer stopped at the output token limit (`maxTokens`): the
   * output may be cut off, or empty when a reasoning model spent the whole limit thinking
   */
  readonly truncated?: boolean;
  /**
   * Set when the model's last answer was withheld instead of finished: `content_filter` when the
   * provider's safety system filtered it, `refusal` when the model declined to answer. The run
   * still completes, with `output` holding what the model said before it stopped: the explanation
   * of a refusal, often nothing for a filter. The runtime does not ask again for such an answer.
   */
  readonly blocked?: RunBlockReason;
  /** The versioned instructions or A/B variant the run used */
  readonly prompt?: RunPrompt;
  /** Handoffs during the run, in order */
  readonly handoffs?: readonly HandoffEvent[];
  /** The agent that answered, when the run handed the conversation over */
  readonly finalAgent?: string;
  /** `paused` when tool calls wait for approval; see `pendingApprovals` and `checkpoint` */
  readonly status?: 'completed' | 'paused';
  /**
   * True when tool calls used up the agent's `maxIterations` before the model answered. With
   * `onIterationLimit: 'answer'` the output is the answer of one extra turn without tools.
   */
  readonly iterationLimitReached?: boolean;
  readonly pendingApprovals?: readonly ToolApprovalRequest[];
  /**
   * What a paused run waits on: approvals (`kind: 'approval'`, the calls of `pendingApprovals`)
   * and questions its tools asked (`kind: 'input'`). Answer them in `ResumeOptions.responses`
   */
  readonly interrupts?: readonly RunInterrupt[];
  /**
   * Messages queued on the run's handle (`cogitator.start()`) that it did not deliver, because it
   * paused or ran out of iterations first. They never reached the thread
   */
  readonly undelivered?: readonly QueuedRunMessage[];
  /** Pass to `cogitator.resume()` with the decisions to continue a paused run */
  readonly checkpoint?: RunCheckpoint;
  readonly toolCalls: readonly ToolCall[];
  readonly messages: readonly Message[];
  readonly trace: {
    readonly traceId: string;
    readonly spans: readonly Span[];
  };
  readonly reflections?: readonly Reflection[];
  readonly reflectionSummary?: ReflectionSummary;
  /** Where the run wrote in the thread's memory, when it wrote anything */
  readonly memory?: RunMemoryPlace;
  /**
   * The agent's todo list as the run left it, when the agent keeps one (`AgentConfig.todos`) and
   * the list was written in this run or an earlier run of the thread
   */
  readonly todos?: readonly TodoItem[];
}

export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  status: 'ok' | 'error' | 'unset';
  startTime: number;
  endTime: number;
  duration: number;
  attributes: Record<string, unknown>;
  events?: { name: string; timestamp: number; attributes?: Record<string, unknown> }[];
}
