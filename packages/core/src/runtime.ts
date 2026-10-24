import { resolve as resolvePath } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  BuiltContext,
  CogitatorConfig,
  RunObserver,
  RunOptions,
  RunResult,
  RunTimeouts,
  RunUsage,
  RunBlockReason,
  Message,
  ToolCall,
  ToolChoice,
  ToolResult,
  ToolProgress,
  Workspace,
  LLMBackend,
  ChatResponse,
  ModelRoute,
  Span,
  Reflection,
  ReflectionAction,
  AgentContext,
  Constitution,
  CostSummary,
  CostEstimate,
  EstimateOptions,
  MemoryAdapter,
  MemoryFilesConfig,
  MemoryFileAdapter,
  GraphAdapter,
  Thread,
  MemoryItemScope,
  MemoryConsolidationReport,
  HandoffEvent,
  ResumeOptions,
  RunCheckpoint,
  RunDeps,
  RunCheckpointStore,
  RunPrompt,
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolInvocationOptions,
  ToolInvocationResult,
  ToolInvoker,
  ChatRequest,
  RunMiddlewareContext,
  ModelCallRequest,
  ModelStreamSink,
  RunMiddleware,
  TodoItem,
  ToolSchema,
  QueuedRunMessage,
  RunHandle,
  RunInterrupt,
  StartOptions,
  PermissionClassifier,
  PermissionDecision,
  PermissionDecisionEvent,
  PermissionsConfig,
  SessionBudgetConfig,
  SessionSpend,
  BudgetLimits,
  BudgetUsage,
} from '@cogitator-ai/types';
import { memoryAgentId, type Agent } from './agent';
import { ToolRegistry } from './registry';
import { readFileBinding } from './tools/workspace-tools';
import { createLLMBackend } from './llm/index';
import { memoryCompactionMiddleware, type CompactionRun } from './middleware/memory-compaction';
import { memoryExtractionMiddleware } from './middleware/memory-extraction';
import { memoryBriefMiddleware } from './middleware/memory-brief';
import {
  memoryUpkeepMiddleware,
  upkeepScope,
  type MemoryUpkeep,
} from './middleware/memory-consolidation';
import { LLMError, llmInvalidResponse } from './llm/errors';
import { isLLMProvider } from './llm/providers';
import { createLLMBackendFromPlugin, hasLLMPlugin } from './llm/plugin';
import { withLLMRetry } from './llm/retry';
import { ModelFallbackChain, type ModelCandidate } from './llm/model-fallback';
import { modelContextWindow } from './context/model-window';
import {
  countMessagesTokens,
  countTokens,
  indexedText,
  type IndexedText,
  type SummarizeFn,
  isMemoryFileAdapter,
  isMemoryItemAdapter,
  FORKS_KEY,
  MEMORY_USERS_KEY,
  MemoryCascade,
  type MemoryCascadeReport,
  MemoryFiles,
  PLAYBOOK_PATH,
  inert,
  parsePlaybook,
} from '@cogitator-ai/memory';

/** The memory ids a thread's metadata names, see `MEMORY_AGENTS` */
function memoryAgentsOf(metadata: Record<string, unknown>): string[] {
  return stringsOf(metadata[MEMORY_AGENTS]);
}

/** The strings of a metadata list */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Whose memory a cascade of {@link Cogitator.forget}, {@link Cogitator.redactEntries} or
 * {@link Cogitator.rewind} goes through, besides the agents its threads name
 */
export interface MemoryCascadeCall {
  /** Agents (or their memory ids) whose items, files, facts and graph to go through */
  agents?: readonly (Agent | string)[];
  /** A knowledge graph of your own to go through too */
  graph?: GraphAdapter;
  /**
   * Leave the replies to a user message alone: by default forgetting or redacting a user message
   * takes the entries that answer it too, as an answer may say again what it said
   */
  keepReplies?: boolean;
}

/** Entries of a thread {@link Cogitator.indexMemory} reads at once */
const INDEX_PAGE = 500;
/** Characters of the playbook a run's context shows at most */
const PLAYBOOK_CHARS = 4000;

/** The playbook a run of `visibleTo` sees, as its context shows it, undefined while it has no rules */
async function playbookNote(
  files: MemoryFiles,
  visibleTo: MemoryItemScope
): Promise<string | undefined> {
  const file = await files.read({ scope: visibleTo, visibleTo, readOnly: true }, PLAYBOOK_PATH);
  if (!file || file.version.author === 'model') return undefined;
  const lines: string[] = [];
  let left = PLAYBOOK_CHARS;
  const { rules } = parsePlaybook(file.content);
  for (const rule of rules) {
    left -= rule.length + 3;
    if (left < 0) {
      lines.push(
        `- ... and ${rules.length - lines.length} more rules, view ${PLAYBOOK_PATH} to see them`
      );
      break;
    }
    lines.push(`- ${rule}`);
  }
  if (lines.length === 0) return undefined;
  return inert(
    `The playbook memory keeps, rules learned from earlier work (a hint, check it against the task):\n${lines.join('\n')}`
  );
}
import { TruncateStrategy } from './context/strategies/index';
import { ABORTED_BEFORE_DISPATCH, sanitizeToolHistory } from './utils/tool-history';
import { RunQueue } from './cogitator/run-queue';
import { assertThreadAccess } from './cogitator/threads';
import {
  ThreadRuns,
  currentToolRuns,
  insideToolOf,
  type ThreadSeat,
} from './cogitator/thread-runs';
import {
  InterruptSchemas,
  isExpired,
  answerInterrupts,
  approvalInterrupt,
  checkpointInterrupts,
  isAnswered,
  isToolInterrupt,
  toolInterrupter,
} from './cogitator/interrupts';
import { MEMORY_AGENTS, noteThreadRun } from './cogitator/message-builder';
import { normalizeTurn } from './llm/turn';
import { withPiiDecisions, withPiiMasking } from './security/pii';
import { MiddlewarePipeline } from './middleware/pipeline';
import {
  compactionMiddleware,
  guardrailsMiddleware,
  piiMiddleware,
  promptInjectionMiddleware,
} from './middleware/builtins';
import {
  clearedToolOutputsAttributes,
  clearToolOutputsMiddleware,
  PINNED_TOOL_OUTPUTS,
  restoreClearedOutputs,
} from './middleware/clear-tool-outputs';
import { recallToolOutputTool } from './tools/recall-tool-output';
import { createLoggerFromConfig, getLogger, setLogger } from './logger';
import { CallPricer, RunCostMeter } from './cogitator/run-cost';
import { isDecisionModel } from '@cogitator-ai/models';
import type {
  DecideOptions,
  DecisionBackend,
  DecisionQuestions,
  DecisionResult,
} from '@cogitator-ai/types';
import { runDecision, validateDecision } from './decisions/decide';
import { decisionsUrlFor, OpenRouterDecisionBackend } from './decisions/openrouter';
import {
  type InitializerState,
  initializeMemory,
  initializeSandbox,
  initializeReflection,
  initializeGuardrails,
  initializeCostRouting,
  initializeSecurity,
  initializeContextManager,
  cleanupState,
  isEmbeddingAdapter,
  isFactAdapter,
} from './cogitator/initializers';
import { CogitatorError, ErrorCode, resolveModelRoute } from '@cogitator-ai/types';
import {
  buildInitialMessages,
  buildUserContent,
  contextPartitionAttributes,
  buildInputWithAudio,
  enrichMessagesWithInsights,
  addContextToMessages,
} from './cogitator/message-builder';
import { RunMemory } from './cogitator/run-memory';
import { toAbortError } from './utils/abort';
import { RunHarness, todosRecall } from './cogitator/harness';
import { parseKeptTodos, TODOS_METADATA_KEY, type KeptTodos } from './tools/write-todos';
import { createSpan, getTextContent } from './cogitator/span-factory';
import {
  runToolCall,
  createToolMessage,
  createToolMessageWithOffload,
  isConcurrencySafe,
  needsApproval,
} from './cogitator/tool-executor';
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS, scheduleToolCalls } from './cogitator/tool-scheduler';
import { ToolInputLedger } from './cogitator/tool-input-ledger';
import { StepGate } from './cogitator/tool-locks';
import { DEFAULT_TOOL_RESULT_MAX_LENGTH, toolResultLengthError } from './tool-content';
import { streamChatRequest, type StreamTiming } from './cogitator/streaming';
import {
  chatContentAttributes,
  chatRequestAttributes,
  chatResponseAttributes,
  errorType,
  GEN_AI,
  genAiProviderName,
  invokeAgentAttributes,
  safeJson,
  TOOL_ERROR_TYPE,
  toolResultContent,
  withoutContent,
} from './observability/genai';
import {
  currentTraceContext,
  newSpanId,
  newTraceId,
  normalizeTraceParent,
  withTraceContext,
} from './observability/trace-context';
import { telemetryObservers } from './observability/telemetry';
import { RunLimiter } from './cogitator/run-limiter';
import { findHandoffAgent, handoffTools } from './cogitator/handoffs';
import { PromptRegistry } from './cogitator/prompts';
import { createMemorySearchTools } from './tools/memory-search-tools';
import {
  memoryFilePlace,
  memoryFileScope,
  memoryFileTool,
  memoryFileVisibility,
} from './tools/memory-file-tool';
import { InMemoryRunCheckpointStore, ThreadRunCheckpointStore } from './cogitator/run-checkpoints';
import {
  parseStructuredOutput,
  structuredOutputProblem,
  toLLMResponseFormat,
} from './cogitator/response-format';
import { CostEstimator } from './cost-routing/cost-estimator';
import { readEnv } from './utils/env';
import {
  EXIT_PLAN_MODE,
  PermissionModeControl,
  PermissionService,
  RunPermissions,
  type PermissionCall,
} from './cogitator/run-permissions';
import { exitPlanModeTool } from './cogitator/plan-mode';
import {
  DEFAULT_CLASSIFIER_TRANSCRIPT,
  isPermissionClassifier,
  modelClassifier,
} from './permissions/classifier';
import {
  addToSession,
  budgetInterrupt,
  readBudgetResponse,
  readSessionSpend,
  RunBudget,
  SESSION_BUDGET_KEY,
  usageOf,
} from './cogitator/run-budget';

/** What a call of a turn gets when the run stops at a budget before it runs */
const STOPPED_AT_BUDGET = 'Not run: the run stopped at its budget';

/** The runtime's budgets with the run's over them, field by field */
function mergeBudgets(
  base: SessionBudgetConfig | undefined,
  own: SessionBudgetConfig | undefined
): SessionBudgetConfig {
  const session = { ...base?.session, ...own?.session };
  const agentLimits = { ...base?.agent, ...own?.agent };
  const warnAt = own?.warnAt ?? base?.warnAt;
  const onWarning = own?.onWarning ?? base?.onWarning;
  return {
    ...(Object.keys(session).length > 0 && { session }),
    ...(Object.keys(agentLimits).length > 0 && { agent: agentLimits }),
    ...(warnAt !== undefined && { warnAt }),
    ...(onWarning && { onWarning }),
  };
}

/** How many newest messages the `auto` classifier reads */
function classifierTranscriptLength(config: PermissionsConfig | undefined): number {
  const classifier = config?.classifier;
  if (!classifier || isPermissionClassifier(classifier)) return DEFAULT_CLASSIFIER_TRANSCRIPT;
  return classifier.transcriptMessages ?? DEFAULT_CLASSIFIER_TRANSCRIPT;
}

const TRANSCRIPT_MESSAGE_CHARS = 1000;

/** The newest `count` messages but the system prompt, as `role: text` lines for the classifier */
function transcriptOf(messages: readonly Message[], count: number): string[] {
  return messages
    .filter((message) => message.role !== 'system')
    .slice(-count)
    .map((message) => {
      const text = getTextContent(message.content);
      const cut =
        text.length > TRANSCRIPT_MESSAGE_CHARS
          ? `${text.slice(0, TRANSCRIPT_MESSAGE_CHARS)}...`
          : text;
      return `${message.role}: ${cut}`;
    });
}

/** A decision as a checkpoint keeps it: its rule saved already, so a resume does not save it again */
function withoutRemember(decision: ToolApprovalDecision): ToolApprovalDecision {
  if (!decision.approved || decision.remember === undefined) return decision;
  const { remember: _saved, ...rest } = decision;
  return rest;
}

/** What a call of a step paused on an earlier call's question gets when the user moves on */
const NOT_STARTED_MOVED_ON =
  'Not started: the user moved on while an earlier tool call of this step waited for an answer';

/** Run timeout when neither the run, the agent nor `limits.defaultTimeout` sets one. */
const DEFAULT_RUN_TIMEOUT = 120_000;

/** The largest delay a timer can hold. Node fires a longer one at once, so a run never arms a deadline past it. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How many times a run asks again when the model ends its turn with neither text nor tool calls.
 * Some models (Gemini after a function response, notably) occasionally stop with an empty turn;
 * asking again usually gets the real answer, and the empty turn never enters the history.
 */
const MAX_EMPTY_ANSWER_RETRIES = 2;

const ITERATION_LIMIT_PROMPT =
  'You have used every step this run allows. Do not call any more tools. Give your final answer now, from what you have.';

/** The reason a turn's answer was withheld, when it was. */
function blockReasonOf(
  reason: ChatResponse['finishReason'] | undefined
): RunBlockReason | undefined {
  return reason === 'content_filter' || reason === 'refusal' ? reason : undefined;
}

/**
 * The tool choice of the next turn for a run asked to use `choice`: `'none'` holds for every turn,
 * a forced choice (`'required'` or a named function) holds until the run made a tool call, so
 * the model can then answer, and a named function the turn's tools lack is not forced.
 */
function toolChoiceForTurn(
  choice: ToolChoice | undefined,
  madeToolCall: boolean,
  registry: ToolRegistry
): ToolChoice | undefined {
  if (choice === undefined || choice === 'auto') return undefined;
  if (choice === 'none') return 'none';
  if (madeToolCall) return undefined;
  if (typeof choice === 'object' && !registry.get(choice.function.name)) return undefined;
  return choice;
}

/** A finished turn with no text and no tool calls: nothing a caller could use as an answer. */
function isEmptyAnswer(response: ChatResponse): boolean {
  return (
    response.finishReason === 'stop' &&
    !response.toolCalls?.length &&
    response.content.trim() === ''
  );
}

/**
 * Main runtime for executing AI agents.
 *
 * Cogitator orchestrates agent execution with support for:
 * - Multiple LLM providers (OpenAI, Anthropic, Ollama, Google, Azure, etc.)
 * - Memory persistence (Redis, PostgreSQL, in-memory)
 * - Sandboxed tool execution (Docker, WASM)
 * - Reflection and learning from past runs
 * - Constitutional AI guardrails
 * - Cost-aware model routing
 *
 * @example Basic usage
 * ```ts
 * import { Cogitator, Agent } from '@cogitator-ai/core';
 *
 * const cog = new Cogitator({
 *   llm: { defaultProvider: 'anthropic' },
 * });
 *
 * const agent = new Agent({
 *   name: 'assistant',
 *   model: 'anthropic/claude-sonnet-5-5',
 *   instructions: 'You are a helpful assistant.',
 * });
 *
 * const result = await cog.run(agent, { input: 'Hello!' });
 * console.log(result.output);
 *
 * await cog.close();
 * ```
 *
 * @example With memory and streaming
 * ```ts
 * const cog = new Cogitator({
 *   memory: {
 *     adapter: 'redis',
 *     redis: { url: 'redis://localhost:6379' },
 *   },
 * });
 *
 * const result = await cog.run(agent, {
 *   input: 'Remember my name is Alice',
 *   threadId: 'conversation-123',
 *   stream: true,
 *   onToken: (token) => process.stdout.write(token),
 * });
 * ```
 */
export class Cogitator implements ToolInvoker {
  private config: CogitatorConfig;
  private observers: RunObserver[];

  /**
   * Whether a memory adapter was configured for this Cogitator instance.
   */
  get memoryConfigured(): boolean {
    return Boolean(this.config.memory?.adapter);
  }
  /** Prices model calls whose provider reports no cost: by `llm.pricing`, then by the model registry. */
  readonly pricer: CallPricer;
  private backends = new Map<string, LLMBackend>();
  /** Backends of agent turns: PII masking runs as middleware there, not in the backend */
  private turnBackends = new Map<string, LLMBackend>();
  private piiLayer?: RunMiddleware;
  private clearingLayer?: RunMiddleware;
  private memoryCompactionLayer?: RunMiddleware;
  private memoryBriefLayer?: RunMiddleware;
  private memoryUpkeepLayer?: MemoryUpkeep;
  private memoryExtractionLayer?: RunMiddleware;
  /** What the `afterRun` hooks of a run spent on the model, by run, added to its usage */
  private readonly afterRunSpend = new Map<
    string,
    { inputTokens: number; outputTokens: number; cost: number }
  >();
  private recallTool?: Tool;
  private readonly memoryFileTools = new Map<string, Tool>();
  private memoryFilesService?: { adapter: MemoryAdapter; service: MemoryFiles };
  private warnedNoMemoryFiles = false;
  /** The memory of each run going on, for `recall_tool_output` to read the run's branch */
  private readonly runMemories = new Map<string, RunMemory>();
  private modelChain?: ModelFallbackChain;
  private readonly decisionBackends = new Map<string, DecisionBackend>();
  private processCheckpoints?: InMemoryRunCheckpointStore;
  private promptRegistry?: PromptRegistry;
  private threadCheckpoints?: { memory: MemoryAdapter; store: ThreadRunCheckpointStore };
  /** The runs going on in each thread, for `multitaskStrategy` */
  private readonly threadRuns = new ThreadRuns();
  /** The Zod schemas of the questions tools of this process's runs wait on */
  private readonly interruptSchemas = new InterruptSchemas();
  /** Permission rules, settings files and session rules of this runtime's runs */
  private permissionService?: PermissionService;
  private classifier?: PermissionClassifier;
  /** What each session spent, for threads without memory to keep it in */
  private readonly sessionSpends = new Map<string, SessionSpend>();
  /** Global tool registry shared across all runs */
  public readonly tools: ToolRegistry = new ToolRegistry();

  private state: InitializerState = {
    memoryInitialized: false,
    sandboxInitialized: false,
    reflectionInitialized: false,
    guardrailsInitialized: false,
    costRoutingInitialized: false,
    securityInitialized: false,
    contextManagerInitialized: false,
  };

  private costEstimator?: CostEstimator;
  private initPromise?: Promise<void>;
  private memoryInit?: Promise<void>;
  private runLimiter?: RunLimiter;
  private warnedGuardrailsWithoutModel = false;
  private constitution?: Constitution;

  /**
   * Create a new Cogitator runtime.
   *
   * @param config - Runtime configuration
   * @param config.llm - LLM provider settings (API keys, base URLs)
   * @param config.memory - Memory adapter configuration
   * @param config.sandbox - Sandbox execution settings
   * @param config.reflection - Reflection engine settings
   * @param config.guardrails - Constitutional AI settings
   * @param config.costRouting - Cost-aware routing settings
   * @param config.logging - Level, format and destination of the process-wide
   *   logger (`getLogger()`); the last runtime created with `logging` sets it
   */
  constructor(config: CogitatorConfig = {}) {
    const lengthError = toolResultLengthError(
      config.limits?.maxToolResultLength,
      'limits.maxToolResultLength'
    );
    if (lengthError) {
      throw new CogitatorError({ message: lengthError, code: ErrorCode.CONFIGURATION_ERROR });
    }
    const retention = config.limits?.toolResultRetention;
    if (retention !== undefined && !(retention >= 0)) {
      throw new CogitatorError({
        message: `limits.toolResultRetention must be 0 or more milliseconds, got ${String(retention)}`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    this.config = config;
    this.pricer = new CallPricer(config.llm?.pricing, (name) =>
      Object.hasOwn(config.llm?.backends ?? {}, name)
        ? config.llm?.backends?.[name]?.provider
        : undefined
    );
    this.observers = [...(config.observers ?? [])];
    if (config.logging) setLogger(createLoggerFromConfig(config.logging));
  }

  /**
   * Run an agent with the given input.
   *
   * Executes the agent's task, handling LLM calls, tool execution,
   * memory persistence, and observability callbacks.
   *
   * @param agent - Agent to execute
   * @param options - Run configuration
   * @param options.input - User input/prompt for the agent
   * @param options.threadId - Thread ID for memory persistence
   * @param options.context - Additional context to include in system prompt
   * @param options.deps - Values for the agent's tools (`context.deps`), kept out of the prompt
   * @param options.stream - Enable streaming responses
   * @param options.onToken - Callback for each streamed token
   * @param options.onToolCall - Callback when a tool is called
   * @param options.onToolResult - Callback when a tool returns a result
   * @param options.onSpan - Callback for observability spans
   * @param options.timeout - Override agent timeout
   * @returns Run result with output, usage stats, and trace
   *
   * @example
   * ```ts
   * const result = await cog.run(agent, {
   *   input: 'Search for TypeScript tutorials',
   *   threadId: 'session-123',
   *   stream: true,
   *   onToken: (token) => process.stdout.write(token),
   *   onToolCall: (call) => console.log('Tool:', call.name),
   * });
   *
   * console.log('Output:', result.output);
   * console.log('Tokens:', result.usage.totalTokens);
   * console.log('Cost:', result.usage.cost);
   * ```
   */
  async run<TDeps = unknown>(
    agent: Agent<TDeps>,
    options: RunOptions<TDeps> & RunDeps<TDeps>
  ): Promise<RunResult> {
    return this.launch(agent, options);
  }

  /**
   * Starts a run and hands back what steers it while it goes on: `steer()` adds a message after
   * the current step's tool calls (they always finish), `followUp()` one the agent takes when it
   * would stop, `inject()` context for the next model call that does not wake the agent, and
   * `abort()` stops the run and returns the messages it did not deliver. `queue.steering` and
   * `queue.followUp` take queued messages one per step (default) or all at once (`'all'`).
   * Delivered messages are saved to the thread as user messages with `metadata.queued`. The
   * handle's `result` is what `run()` returns.
   *
   * @example
   * ```ts
   * const handle = cog.start(agent, { input: 'Plan the release', threadId });
   * handle.steer('Skip the changelog, it is done');
   * handle.followUp('Then draft the announcement');
   * const result = await handle.result;
   * ```
   */
  start<TDeps = unknown>(
    agent: Agent<TDeps>,
    options: StartOptions<TDeps> & RunDeps<TDeps>
  ): RunHandle {
    const { queue: queueOptions, onRefusedMessage, ...runOptions } = options;
    const queue = new RunQueue(queueOptions, (refused) => {
      try {
        onRefusedMessage?.(refused);
      } catch (error) {
        getLogger().warn('Run onRefusedMessage failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    const stop = new AbortController();
    const signal = runOptions.signal
      ? AbortSignal.any([runOptions.signal, stop.signal])
      : stop.signal;
    const modes = new PermissionModeControl();
    const result = this.launch(agent, { ...runOptions, signal }, undefined, queue, modes).finally(
      () => {
        queue.close();
      }
    );
    result.catch(() => undefined);
    return {
      result,
      steer: (message) => queue.push('steer', message),
      followUp: (message) => queue.push('followUp', message),
      inject: (message) => queue.push('inject', message),
      get queued() {
        return queue.pending;
      },
      get refused() {
        return queue.refused;
      },
      abort: (reason) => {
        const left = queue.cancel();
        if (!stop.signal.aborted) stop.abort(toAbortError(reason, 'Run aborted'));
        return left;
      },
      get permissionMode() {
        return modes.mode;
      },
      setPermissionMode: (mode) => modes.set(mode),
    };
  }

  /**
   * Continue a run that paused for tool approvals (`status: 'paused'`) from its
   * `checkpoint`. Approved calls run, declined ones answer the model with the
   * reason, and the run goes on; calls without a decision pause it again.
   *
   * @example
   * ```ts
   * const paused = await cog.run(agent, { input: 'Refund order 42' });
   * if (paused.status === 'paused') {
   *   await store.save(paused.checkpoint);
   *   // ... later, once someone approved it
   *   const result = await cog.resume(agent, checkpoint, {
   *     decisions: { [paused.pendingApprovals[0].toolCallId]: { approved: true } },
   *   });
   * }
   * ```
   */
  async resume<TDeps = unknown>(
    agent: Agent<TDeps>,
    target: RunCheckpoint | string,
    ...[options = {}]: ResumeArgs<TDeps>
  ): Promise<RunResult> {
    if (typeof target !== 'string' && target.version !== 1) {
      throw new CogitatorError({
        message: `Unsupported run checkpoint version: ${String(target.version)}`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const { decisions = {}, defaultDecision, responses, userId, ...rest } = options;
    const threadId = typeof target === 'string' ? target : target.threadId;
    return this.launch(
      agent,
      { ...rest, input: '', threadId, ...(userId !== undefined && { userId }) },
      {
        ...(typeof target === 'string' ? {} : { checkpoint: target }),
        decisions,
        ...(defaultDecision && { defaultDecision }),
        ...(responses && { responses }),
        checkUser: typeof target === 'string' || userId !== undefined,
      }
    );
  }

  /**
   * Run one tool call outside an agent run, the way a run executes it: the arguments validated
   * against the tool's schema, approval asked for a call that needs it (`options.onApproval`,
   * else `guardrails.onToolApproval`), the guardrails applied, sandboxed tools run in this
   * runtime's sandbox and `tool.timeout` kept. A call that needs approval nobody gives does not
   * run: there is no run to pause, so it is refused with the request in `pendingApproval`. A call
   * whose `signal` aborts, even while its approval is being decided, does not run either. Pass
   * `agent` for the gates a run of that agent applies: its model for the guardrails unless
   * `guardrails.model` is set, and its middleware around the call.
   *
   * @example
   * ```ts
   * const result = await cog.invokeTool(exec, { command: 'ls' }, {
   *   onApproval: async (request) => ((await askUser(request)) ? { approved: true } : { approved: false }),
   * });
   * if (result.error) console.error(result.error);
   * ```
   */
  async invokeTool<TParams, TResult, TDeps = unknown>(
    tool: Tool<TParams, TResult, TDeps>,
    args: unknown,
    ...[options = {}]: InvocationArgs<TDeps>
  ): Promise<ToolInvocationResult> {
    const toolCall: ToolCall = {
      id: options.toolCallId ?? `call_${nanoid(12)}`,
      name: tool.name,
      arguments: isArgumentRecord(args) ? args : {},
    };
    const agent = options.agent;
    this.ensureGuardrails(agent ? agent.model || this.config.llm?.defaultModel : undefined);
    const constitutionalAI = this.state.constitutionalAI;
    if (!constitutionalAI) this.warnGuardrailsWithoutModel();
    const agentId = options.agentId ?? agent?.id ?? 'tool-invoker';
    const signal = options.signal;
    const aborted = (): ToolInvocationResult => ({
      callId: toolCall.id,
      name: tool.name,
      result: null,
      error: toAbortError(signal?.reason, `Tool "${tool.name}" aborted`).message,
    });
    if (signal?.aborted) return aborted();

    const workspace = options.workspace ?? agent?.config.workspace;
    const permissionService = this.permissionsOf();
    const permissions = await RunPermissions.create({
      service: permissionService,
      threadId: options.threadId ?? `invoke_${toolCall.id}`,
      scopes: [
        { options: this.config.permissions, origin: 'runtime' },
        { options: options.permissions, origin: 'call' },
      ],
      root: resolvePath(
        permissionService.settingsOptions?.root ?? workspace?.root ?? process.cwd()
      ),
      record: async (event) => {
        notify('onPermissionDecision', () => options.onPermissionDecision?.(event));
      },
    });
    const baseTool: Tool = tool;
    const permissionCall: PermissionCall = {
      toolCallId: toolCall.id,
      needsApproval:
        needsApproval(baseTool, toolCall.arguments) ||
        constitutionalAI?.toolNeedsApproval(baseTool, toolCall.arguments) === true,
      ...(workspace && { workspace }),
    };
    const verdict = await permissions.decide(baseTool, toolCall.arguments, permissionCall);
    const withPermission = (result: ToolInvocationResult): ToolInvocationResult =>
      permissions.active ? { ...result, permission: verdict } : result;
    const event = (decision: PermissionDecision): PermissionDecisionEvent => ({
      ...decision,
      toolCallId: toolCall.id,
      toolName: tool.name,
    });
    if (signal?.aborted) return aborted();
    if (verdict.decision === 'deny') {
      await permissions.record(event(verdict));
      return withPermission({
        callId: toolCall.id,
        name: tool.name,
        result: null,
        error: `Permission denied: ${verdict.reason}`,
        errorCode: 'PERMISSION_DENIED',
      });
    }

    let approvedByUser = verdict.decision === 'allow' && verdict.decidedBy !== 'default';
    let callToRun = toolCall;
    if (verdict.decision === 'allow') await permissions.record(event(verdict));
    if (verdict.decision === 'ask') {
      const suggestedRule = permissions.suggest(baseTool, toolCall.arguments, workspace);
      const request: ToolApprovalRequest = {
        toolCallId: toolCall.id,
        toolName: tool.name,
        arguments: toolCall.arguments,
        description: tool.description,
        ...(tool.sideEffects && { sideEffects: [...tool.sideEffects] }),
        ...((options.agentId !== undefined || agent) && { agentId }),
        ...(options.threadId !== undefined && { threadId: options.threadId }),
        ...(options.userId !== undefined && { userId: options.userId }),
        ...(permissions.active && {
          reason: verdict.reason,
          ...(verdict.rule && { rule: verdict.rule }),
          ...(suggestedRule !== undefined && { suggestedRule }),
          mode: verdict.mode,
        }),
      };
      const deciding = this.decideApproval(request, options.onApproval);
      let decision: Awaited<typeof deciding>;
      try {
        decision = await (signal ? waitForAbortable(deciding, signal) : deciding);
      } catch (error) {
        if (signal?.aborted) return aborted();
        throw error;
      }
      if (signal?.aborted) return aborted();
      if (decision === 'pause') {
        return withPermission({
          callId: toolCall.id,
          name: tool.name,
          result: null,
          error: `Tool "${tool.name}" needs approval, and nobody approved this call`,
          pendingApproval: request,
        });
      }
      if (!decision.approved) {
        await permissions.record({
          ...event(verdict),
          decision: 'deny',
          decidedBy: 'user',
          reason: `Declined by the user${decision.reason ? `: ${decision.reason}` : ''}`,
        });
        return withPermission({
          callId: toolCall.id,
          name: tool.name,
          result: null,
          error: `The user declined this tool call${decision.reason ? `: ${decision.reason}` : ''}`,
        });
      }
      let answered: PermissionDecisionEvent = {
        ...event(verdict),
        decision: 'allow',
        decidedBy: 'user',
        reason: 'Approved by the user',
      };
      if (decision.updatedArguments) {
        const checked = await this.checkUpdatedArguments(
          baseTool,
          decision.updatedArguments,
          permissions,
          { ...permissionCall, needsApproval: false }
        );
        if ('error' in checked) {
          await permissions.record({ ...answered, decision: 'deny', reason: checked.error });
          return withPermission({
            callId: toolCall.id,
            name: tool.name,
            result: null,
            error: `Permission denied: ${checked.error}`,
            errorCode: 'PERMISSION_DENIED',
          });
        }
        callToRun = { ...toolCall, arguments: checked.args };
        answered = { ...answered, updatedArguments: checked.args };
      }
      if (decision.remember) {
        const remembered = await permissions.remember(
          baseTool,
          callToRun.arguments,
          decision.remember,
          workspace
        );
        if (remembered) answered = { ...answered, remembered };
      }
      await permissions.record(answered);
      approvedByUser = true;
    }

    const registry = new ToolRegistry();
    registry.register(tool);
    const runId = options.runId ?? `run_${nanoid(12)}`;
    const result = await runToolCall({
      registry,
      toolCall: callToRun,
      runId,
      agentId,
      sandboxManager: this.state.sandboxManager,
      initializeSandbox: () => initializeSandbox(this.config, this.state),
      signal,
      extraContext: {
        ...options.context,
        ...(options.threadId !== undefined && { threadId: options.threadId }),
        ...(options.userId !== undefined && { userId: options.userId }),
        ...(options.channelType !== undefined && { channelType: options.channelType }),
        ...(options.channelId !== undefined && { channelId: options.channelId }),
        ...(options.topicId !== undefined && { topicId: options.topicId }),
        ...(options.conversationId !== undefined && { conversationId: options.conversationId }),
        ...(options.deps !== undefined && { deps: options.deps }),
        ...((options.workspace ?? agent?.config.workspace) && {
          workspace: options.workspace ?? agent?.config.workspace,
        }),
        ...(permissions.view() && { permissions: permissions.view() }),
      },
      approved: approvedByUser,
      allowNativeFallback: this.config.sandbox?.allowNativeFallback !== false,
      ...(options.onUpdate && {
        onUpdate: (progress: ToolProgress) =>
          options.onUpdate?.({ ...progress, callId: toolCall.id, name: tool.name }),
      }),
      middleware: new MiddlewarePipeline([
        ...(this.config.middleware ?? []),
        ...(agent?.config.middleware ?? []),
        ...this.builtinMiddleware(),
      ]),
      context: {
        runId,
        agentId,
        agentName: agent?.name ?? agentId,
        iteration: 0,
        signal: signal ?? new AbortController().signal,
        state: new Map(),
        ...(options.threadId !== undefined && { threadId: options.threadId }),
        ...(options.userId !== undefined && { userId: options.userId }),
        ...(options.channelType !== undefined && { channelType: options.channelType }),
        ...(options.channelId !== undefined && { channelId: options.channelId }),
        ...(options.topicId !== undefined && { topicId: options.topicId }),
        ...(options.conversationId !== undefined && { conversationId: options.conversationId }),
        ...(options.deps !== undefined && { deps: options.deps }),
        ...((options.workspace ?? agent?.config.workspace) && {
          workspace: options.workspace ?? agent?.config.workspace,
        }),
      },
    });
    return withPermission(result);
  }

  /**
   * The middleware the runtime's own features become, closest to the model, in this order:
   * PII masking (`security.pii`), prompt injection (`security.promptInjection`), guardrails
   * (`guardrails`), tool output clearing (`context.clearToolOutputs`), compaction of a turn
   * (`context`), extraction of memory items after a run (`memory.extraction`), compaction of
   * the thread after a run (`memory.compaction`), memory upkeep in the background after a run
   * (`memory.observations`, `memory.consolidation`) and the brief of what memory holds for a
   * turn before its first model call (`memory.brief`). Each is there once its feature is set up.
   */
  private builtinMiddleware(): RunMiddleware[] {
    const pii = this.config.security?.pii;
    if (pii) this.piiLayer ??= piiMiddleware(pii);
    const clearing = this.config.context?.clearToolOutputs;
    if (clearing) {
      this.clearingLayer ??= clearToolOutputsMiddleware(clearing === true ? {} : clearing);
    }
    const memoryExtraction = this.config.memory?.extraction;
    if (memoryExtraction) {
      this.memoryExtractionLayer ??= memoryExtractionMiddleware(memoryExtraction, {
        memory: () => this.state.memoryAdapter,
        summarizer: (model, run) => this.summarizerFor(model, run),
      });
    }
    const { observations, consolidation } = this.config.memory ?? {};
    if (observations || consolidation) {
      this.memoryUpkeepLayer ??= memoryUpkeepMiddleware(
        {
          ...(observations && { observations }),
          ...(consolidation && { consolidation }),
          ...(memoryExtraction?.scope && { scope: memoryExtraction.scope }),
        },
        {
          memory: () => this.state.memoryAdapter,
          summarizer: (model, run) => this.summarizerFor(model, run, false),
        }
      );
    }
    const memoryCompaction = this.config.memory?.compaction;
    if (memoryCompaction) {
      const userAfterCompact = memoryCompaction.afterCompact;
      this.memoryCompactionLayer ??= memoryCompactionMiddleware(
        {
          ...memoryCompaction,
          afterCompact: async (result) => {
            if (result.compactedMessages < result.originalMessages) {
              this.memoryUpkeepLayer?.noteCompaction(result.sessionId);
            }
            await userAfterCompact?.(result);
          },
        },
        {
          memory: () => this.state.memoryAdapter,
          summarizer: (model, run) => this.summarizerFor(model, run),
          windowOf: (model) => this.servedWindow(model),
        }
      );
    }
    const memoryBrief = this.config.memory?.brief;
    if (memoryBrief) {
      this.memoryBriefLayer ??= memoryBriefMiddleware(memoryBrief, {
        memory: () => this.state.memoryAdapter,
        summarizer: (model, run) => this.summarizerFor(model, run),
        placeOf: (runId) => this.runMemories.get(runId)?.conversation,
      });
    }
    const { injectionDetector, constitutionalAI, contextManager } = this.state;
    return [
      ...(this.piiLayer ? [this.piiLayer] : []),
      ...(injectionDetector ? [promptInjectionMiddleware(injectionDetector)] : []),
      ...(constitutionalAI ? [guardrailsMiddleware(constitutionalAI)] : []),
      ...(this.clearingLayer ? [this.clearingLayer] : []),
      ...(contextManager ? [compactionMiddleware(contextManager)] : []),
      ...(this.memoryExtractionLayer ? [this.memoryExtractionLayer] : []),
      ...(this.memoryCompactionLayer ? [this.memoryCompactionLayer] : []),
      ...(this.memoryUpkeepLayer ? [this.memoryUpkeepLayer] : []),
      ...(this.memoryBriefLayer ? [this.memoryBriefLayer] : []),
    ];
  }

  /**
   * A summarizer that asks `model`, routed as a run's model is (see {@link route}), with the
   * prompt as its system message. Each call stops with the run's `signal` and is counted for
   * `run` in the cost router, and with `inRun` in the usage the run returns too: a call made
   * after the run returned, such as by memory upkeep, is not. The routed backend masks what it
   * sends under `security.pii`, as for a run's own model calls.
   */
  private summarizerFor(
    model: string,
    { signal, ...run }: CompactionRun,
    inRun = true
  ): SummarizeFn {
    return async (messages, options) => {
      signal?.throwIfAborted();
      const { backend, model: name } = this.route(model);
      const response = await backend.chat({
        model: name,
        messages: [
          { role: 'system', content: options?.prompt ?? 'Summarize the conversation.' },
          ...messages,
        ],
        ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
        ...(signal && { signal }),
      });
      const priced = this.pricedModel(model);
      const priceOf = response.usage.cost ?? this.pricer.costOrNull(priced, response.usage);
      if (priceOf === null) this.pricer.noteUnpriced(priced);
      const cost = priceOf ?? 0;
      this.getCostRouter()?.recordCost({
        ...run,
        model: priced,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost,
      });
      if (!inRun || signal?.aborted) return response.content;
      const spent = this.afterRunSpend.get(run.runId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      };
      this.afterRunSpend.set(run.runId, {
        inputTokens: spent.inputTokens + response.usage.inputTokens,
        outputTokens: spent.outputTokens + response.usage.outputTokens,
        cost: spent.cost + cost,
      });
      return response.content;
    };
  }

  /**
   * The tools the runtime's own features give `owner`: `recall_tool_output` while
   * `context.clearToolOutputs` is on, and the memory tool (`memory`) with `memory.files`. A tool
   * of the agent's own with one of these names takes its place.
   */
  private builtinTools(owner: Agent): Tool[] {
    const tools: Tool[] = [];
    if (this.config.context?.clearToolOutputs) {
      this.recallTool ??= recallToolOutputTool(
        () => this.state.memoryAdapter,
        (runId) => this.runMemories.get(runId)?.conversation
      );
      tools.push(this.recallTool);
    }
    const files = this.memoryFiles();
    if (files) {
      const agentId = memoryAgentId(owner);
      let fileTool = this.memoryFileTools.get(agentId);
      if (!fileTool) {
        fileTool = memoryFileTool({
          memory: files.adapter,
          files: files.service,
          agentId,
          ...(files.config.scope !== undefined && { scope: files.config.scope }),
          ...(files.config.readOnly && { readOnly: true }),
          placeOf: (runId) => this.runMemories.get(runId)?.conversation,
        });
        this.memoryFileTools.set(agentId, fileTool);
      }
      tools.push(fileTool);
    }
    return tools;
  }

  /**
   * The memory files of `memory.files`, when it is set and the memory adapter keeps them; a
   * memory adapter that keeps none is warned about once
   */
  private memoryFiles():
    { config: MemoryFilesConfig; adapter: MemoryAdapter; service: MemoryFiles } | undefined {
    const config = this.config.memory?.files;
    const adapter = this.state.memoryAdapter;
    if (!config || !adapter) return undefined;
    if (!isMemoryFileAdapter(adapter)) {
      if (!this.warnedNoMemoryFiles) {
        this.warnedNoMemoryFiles = true;
        getLogger().warn(
          `memory.files is set, but the ${adapter.provider} memory adapter keeps no memory files: the memory tool is left out`
        );
      }
      return undefined;
    }
    return { config, adapter, service: this.fileService(adapter) };
  }

  /** The memory files of `adapter`, one service while the adapter stays the same */
  private fileService(adapter: MemoryAdapter & MemoryFileAdapter): MemoryFiles {
    if (this.memoryFilesService?.adapter !== adapter) {
      this.memoryFilesService = { adapter, service: new MemoryFiles({ adapter }) };
      this.memoryFileTools.clear();
    }
    return this.memoryFilesService.service;
  }

  /**
   * What memory holds for a run of `agent`, for its context: the list of the memory files it sees
   * (`memory.files`) and the playbook kept for it (`memory.consolidation`)
   */
  private memoryFilesIndex(
    agent: Agent,
    options: RunOptions
  ):
    | ((thread: { threadId: string; leafId?: string | null }) => Promise<string | undefined>)
    | undefined {
    const files = this.memoryFiles();
    const consolidation = this.config.memory?.consolidation;
    const adapter = this.state.memoryAdapter;
    const showPlaybook =
      consolidation !== undefined &&
      consolidation.showPlaybook !== false &&
      adapter !== undefined &&
      isMemoryFileAdapter(adapter);
    if (!files && !showPlaybook) return undefined;
    return async (thread) => {
      const agentId = memoryAgentId(agent);
      const run = {
        ...(options.userId !== undefined && { userId: options.userId }),
        threadId: thread.threadId,
      };
      const visibleTo = memoryFileVisibility(agentId, run);
      const place = files ? await memoryFilePlace(files.adapter, thread) : undefined;
      const index = files
        ? await files.service.index(
            {
              scope: memoryFileScope(agentId, files.config.scope, run),
              visibleTo,
              ...(place && { place }),
            },
            files.config.indexChars
          )
        : undefined;
      const playbook =
        showPlaybook && adapter && isMemoryFileAdapter(adapter)
          ? await playbookNote(this.fileService(adapter), visibleTo)
          : undefined;
      const notes = [index, playbook].filter((note): note is string => note !== undefined);
      return notes.length === 0 ? undefined : notes.join('\n\n');
    };
  }

  /**
   * Watches every run that starts from now on, next to `config.observers`, until
   * the returned function is called. Tools such as a local studio attach to a
   * runtime a project already built this way, and see the runs of agents its
   * tools start too. `close()` closes it like the configured observers.
   */
  observe(observer: RunObserver): () => void {
    this.observers.push(observer);
    return () => {
      const index = this.observers.indexOf(observer);
      if (index !== -1) this.observers.splice(index, 1);
    };
  }

  /**
   * Everything watching this runtime's runs: its observers (`config.observers` and `observe()`)
   * and those registered process-wide with `registerTelemetry`, each once.
   */
  private watchers(): RunObserver[] {
    return [...new Set([...this.observers, ...telemetryObservers()])];
  }

  /** Whether runs record model and tool content on their spans, see `TelemetryConfig`. */
  private capturesContent(): boolean {
    return (
      this.config.telemetry?.captureContent === true ||
      this.watchers().some((observer) => observer.captureContent === true)
    );
  }

  /**
   * Reports a span that is not part of a run of this runtime (the root span of a swarm, a
   * workflow's span) to everything watching its runs, as `onSpan` of the run `runId`, so the
   * spans of an orchestration reach the same place as the runs inside it. Content attributes
   * reach only the observers that asked for them.
   */
  recordSpan(span: Span, run: { runId: string }): void {
    const contentForAll = this.config.telemetry?.captureContent === true;
    for (const observer of this.watchers()) {
      try {
        observer.onSpan?.(
          contentForAll || observer.captureContent ? span : withoutContent(span),
          run
        );
      } catch (error) {
        getLogger().warn('Run observer onSpan failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Lets every observer send what it buffered; one that fails is logged, the others still close. */
  private async closeObservers(): Promise<void> {
    const results = await Promise.allSettled(
      this.observers.map(async (observer) => observer.close?.())
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        getLogger().warn('Run observer close failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  /**
   * `options` with its run callbacks also reporting to the observers watching
   * when the run starts. The run's own callback goes first; an observer that
   * throws is logged and the run goes on.
   */
  private withObservers(options: RunOptions, agent: Agent, runId: () => string): RunOptions {
    const observers = this.watchers();
    if (observers.length === 0) return options;
    const contentForAll = this.config.telemetry?.captureContent === true;

    const notify = (hook: keyof RunObserver, call: (observer: RunObserver) => void) => {
      for (const observer of observers) {
        try {
          call(observer);
        } catch (error) {
          getLogger().warn(`Run observer ${hook} failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    return {
      ...options,
      onRunStart: (event) => {
        options.onRunStart?.(event);
        notify('onRunStart', (observer) =>
          observer.onRunStart?.({ ...event, agentName: agent.name, model: agent.model })
        );
      },
      onSpan: (span) => {
        options.onSpan?.(contentForAll ? span : withoutContent(span));
        notify('onSpan', (observer) =>
          observer.onSpan?.(
            contentForAll || observer.captureContent ? span : withoutContent(span),
            { runId: runId() }
          )
        );
      },
      onRunComplete: (result) => {
        options.onRunComplete?.(result);
        notify('onRunComplete', (observer) => observer.onRunComplete?.(result));
      },
      onTodos: (todos) => {
        try {
          options.onTodos?.(todos);
        } catch (error) {
          getLogger().warn('Run onTodos failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        notify('onTodos', (observer) => observer.onTodos?.(todos, { runId: runId() }));
      },
      onRunError: (error, id, usage) => {
        options.onRunError?.(error, id, usage);
        notify('onRunError', (observer) => observer.onRunError?.(error, id, usage));
      },
    };
  }

  /**
   * Runs `agent` once its thread lets it (`multitaskStrategy`): a run on an explicit thread takes
   * a seat there for as long as it goes on, so later runs of the thread see it. A rollback run
   * goes on a branch from where the run it interrupted started.
   */
  private async launch(
    agent: Agent,
    options: RunOptions,
    resumeFrom?: ResumeFrom,
    queue?: RunQueue,
    modes?: PermissionModeControl
  ): Promise<RunResult> {
    const threadId = options.threadId;
    const aside =
      options.branch?.activate === false || resumeFrom?.checkpoint?.branch?.activate === false;
    if (threadId === undefined || aside) {
      return this.execute(agent, options, resumeFrom, { queue, modes });
    }
    const strategy = options.multitaskStrategy ?? this.config.multitaskStrategy;
    if (strategy !== undefined) await this.checkThreadUse(threadId, options, resumeFrom);
    const admission = await this.threadRuns.admit(threadId, {
      strategy,
      signal: options.signal,
      ancestorRunIds: currentToolRuns(),
      userId: resumeFrom?.checkpoint?.userId ?? options.userId,
      shared: options.threadAccess === 'shared',
    });
    if (!admission) return this.execute(agent, options, resumeFrom, { queue, modes });
    try {
      const { seat, rollbackTo } = admission;
      const signal = options.signal ? AbortSignal.any([options.signal, seat.signal]) : seat.signal;
      const branch =
        !resumeFrom && rollbackTo !== undefined && options.branch === undefined
          ? { branch: { fromEntryId: rollbackTo } }
          : {};
      return await this.execute(agent, { ...options, ...branch, signal }, resumeFrom, {
        queue,
        seat,
        modes,
      });
    } finally {
      admission.release();
    }
  }

  /**
   * Fails a run that may not use `threadId` before its strategy touches a run going on there:
   * another user's thread, or another user's paused run for a resume. The run checks this again
   * itself, this only keeps a stranger from interrupting, rolling back or probing a thread
   */
  private async checkThreadUse(
    threadId: string,
    options: RunOptions,
    resumeFrom: ResumeFrom | undefined
  ): Promise<void> {
    if (resumeFrom) {
      if (!resumeFrom.checkUser) return;
      await this.getMemory();
      const checkpoint = resumeFrom.checkpoint ?? (await this.runCheckpointStore().load(threadId));
      if (checkpoint && checkpoint.userId !== options.userId) {
        throw new CogitatorError({
          message: `The paused run in thread ${threadId} belongs to another user`,
          code: ErrorCode.THREAD_ACCESS_DENIED,
        });
      }
      return;
    }
    if (options.threadAccess === 'shared' || options.useMemory === false) return;
    const memory = await this.getMemory();
    if (memory) await assertThreadAccess(memory, threadId, options.userId);
  }

  private async execute(
    agent: Agent,
    options: RunOptions,
    resumeFrom?: ResumeFrom,
    control: RunControl = {}
  ): Promise<RunResult> {
    let checkpoint = resumeFrom?.checkpoint;
    let prompt: RunPrompt | undefined;
    let runId = checkpoint?.runId ?? `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const runMemory = new RunMemory(
      () => this.state.memoryAdapter,
      threadId,
      () => options
    );
    const explicitTrace = normalizeTraceParent(options.trace);
    const parentTrace = explicitTrace ?? currentTraceContext();
    let traceId = parentTrace?.traceId ?? newTraceId();
    let parentSpanId = parentTrace?.parentSpanId;
    const { queue, seat } = control;
    if (seat) {
      seat.runId = runId;
      seat.branchPoint = () => runMemory.summary()?.branchPoint;
    }
    const shown = { text: '', agentId: agent.id };
    let pausedOut = false;
    let checkpointKept = resumeFrom !== undefined;
    const conversationId = options.threadId;
    const captureContent = this.capturesContent();
    const publicSpans = () =>
      this.config.telemetry?.captureContent === true ? spans : spans.map(withoutContent);
    const startTime = Date.now();
    const spans: Span[] = [];

    let ownTimeouts: RunTimeouts = { ...options.timeouts };
    let timeouts: RunTimeouts = { ...agent.config?.timeouts, ...ownTimeouts };
    let parallelToolCalls = options.parallelToolCalls;
    let maxParallelToolCalls = options.maxParallelToolCalls;
    const timeout =
      options.timeouts?.totalMs ??
      options.timeout ??
      agent.config?.timeouts?.totalMs ??
      agent.config?.timeout ??
      this.config.limits?.defaultTimeout ??
      DEFAULT_RUN_TIMEOUT;
    const abortController = new AbortController();
    let usageSoFar: () => RunUsage | undefined = () => undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeParentAbortListener: (() => void) | undefined;

    if (options.signal) {
      const abortFromParent = () => {
        abortController.abort(toAbortError(options.signal?.reason, 'Run aborted'));
      };

      if (options.signal.aborted) {
        abortFromParent();
      } else {
        options.signal.addEventListener('abort', abortFromParent, { once: true });
        removeParentAbortListener = () => {
          options.signal?.removeEventListener('abort', abortFromParent);
        };
      }
    }

    const armTimeout = (ms: number) => {
      clearTimeout(timeoutId);
      timeoutId = undefined;
      if (!(ms > 0 && ms <= MAX_TIMER_DELAY_MS)) return;
      timeoutId = setTimeout(() => {
        const usage = usageSoFar();
        abortController.abort(
          new CogitatorError({
            message: `Run timed out after ${ms}ms`,
            code: ErrorCode.RUN_TIMEOUT,
            details: { timeout: ms, ...(usage && { usage }) },
          })
        );
      }, ms);
    };
    if (timeout) armTimeout(timeout);

    const rootSpanId = newSpanId();
    let releaseRunSlot: (() => void) | undefined;
    let budget: RunBudget | undefined;
    options = this.withObservers(options, agent, () => runId);

    try {
      let resumedInterrupts: RunInterrupt[] = [];
      let answeredDecisions: Record<string, ToolApprovalDecision> = {};
      let answeredNow: RunInterrupt[] = [];
      releaseRunSlot = await this.acquireRunSlot(abortController.signal);
      throwIfAborted(abortController.signal);
      if (!checkpoint) {
        options.onRunStart?.({ runId, agentId: agent.id, input: options.input, threadId });
      }

      const agentModel = this.resolveModel(agent);
      await this.initializeAll(agentModel);

      if (resumeFrom) {
        checkpoint ??= (await this.runCheckpointStore().load(threadId)) ?? undefined;
        if (!checkpoint) {
          throw new CogitatorError({
            message: `Thread ${threadId} has no paused run`,
            code: ErrorCode.RUN_NOT_PAUSED,
          });
        }
        if (resumeFrom.checkUser && checkpoint.userId !== options.userId) {
          throw new CogitatorError({
            message: `The paused run in thread ${threadId} belongs to another user`,
            code: ErrorCode.THREAD_ACCESS_DENIED,
          });
        }
        const kept = checkpoint.toolExecution;
        if (kept) {
          parallelToolCalls ??= kept.parallelToolCalls;
          maxParallelToolCalls ??= kept.maxParallelToolCalls;
          ownTimeouts = { ...kept.timeouts, ...options.timeouts };
          timeouts = { ...agent.config?.timeouts, ...ownTimeouts };
          const keptTotal = kept.timeouts?.totalMs;
          if (
            keptTotal !== undefined &&
            options.timeouts?.totalMs === undefined &&
            options.timeout === undefined
          ) {
            armTimeout(keptTotal);
          }
        }
        runId = checkpoint.runId;
        if (seat) seat.runId = runId;
        options = { ...options, userId: checkpoint.userId };
        runMemory.open(checkpoint.branch);
        if (!explicitTrace && checkpoint.trace) {
          traceId = checkpoint.trace.traceId;
          parentSpanId = checkpoint.trace.rootSpanId;
        }
        resumedInterrupts = checkpointInterrupts(checkpoint);
        if (resumeFrom.responses) {
          const pausedRunId = checkpoint.runId;
          const answered = answerInterrupts(
            resumedInterrupts,
            resumeFrom.responses,
            Date.now(),
            (id) => this.interruptSchemas.get(pausedRunId, id)
          );
          for (const entry of answered.answered) {
            this.interruptSchemas.forget(pausedRunId, entry.id);
          }
          resumedInterrupts = answered.interrupts;
          answeredDecisions = answered.decisions;
          answeredNow = answered.answered;
        }
      }

      this.runMemories.set(runId, runMemory);
      prompt = checkpoint?.prompt;
      if (!checkpoint && (this.config.prompts || this.promptRegistry)) {
        const resolution = await this.prompts.resolve(agent, threadId);
        prompt = resolution.prompt;
        if (resolution.instructions !== agent.instructions) {
          agent = agent.clone({ id: agent.id, instructions: resolution.instructions });
        }
      }

      let active: Agent = agent;
      if (checkpoint?.activeAgent && checkpoint.activeAgent !== agent.name) {
        const found = findHandoffAgent(agent, checkpoint.activeAgent);
        if (!found) {
          throw new CogitatorError({
            message: `The paused run is in agent "${checkpoint.activeAgent}", which ${agent.name} cannot hand over to`,
            code: ErrorCode.VALIDATION_ERROR,
          });
        }
        active = found;
      }
      const handoffs: HandoffEvent[] = [...(checkpoint?.handoffs ?? [])];
      let iterations = checkpoint?.iterations ?? 0;

      const builtins = this.builtinMiddleware();
      const pipelineFor = (owner: Agent) =>
        new MiddlewarePipeline([
          ...(this.config.middleware ?? []),
          ...(owner.config.middleware ?? []),
          ...(options.middleware ?? []),
          ...builtins,
        ]);
      let pipeline = pipelineFor(active);
      const middlewareState = new Map<string, unknown>();
      const workspaceOf = (owner: Agent): Workspace | undefined =>
        options.workspace ?? owner.config.workspace;
      const middlewareContext = (): RunMiddlewareContext => ({
        runId,
        threadId,
        agentId: active.id,
        agentName: active.name,
        memoryAgentId: memoryAgentId(active),
        iteration: iterations,
        signal: abortController.signal,
        state: middlewareState,
        ...(options.userId !== undefined && { userId: options.userId }),
        ...(options.channelType !== undefined && { channelType: options.channelType }),
        ...(options.channelId !== undefined && { channelId: options.channelId }),
        ...(options.topicId !== undefined && { topicId: options.topicId }),
        ...(options.conversationId !== undefined && { conversationId: options.conversationId }),
        ...(options.deps !== undefined && { deps: options.deps }),
        ...(workspaceOf(active) && { workspace: workspaceOf(active) }),
      });

      const reportTodos = (todos: readonly TodoItem[]) => {
        try {
          options.onTodos?.(todos);
        } catch (error) {
          getLogger().warn('Run onTodos failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const harness = new RunHarness({
        conversation: () => messages,
        registry: () => registry,
        workspaceOf,
        signal: abortController.signal,
        onTodos: async (todos) => {
          reportTodos(todos);
          await this.keepTodos(threadId, todos, runMemory);
        },
      });
      middlewareState.set(PINNED_TOOL_OUTPUTS, harness.pinnedOutputs);
      await harness.prepare(active);
      const permissionService = this.permissionsOf();
      const permissions = await RunPermissions.create({
        service: permissionService,
        threadId,
        scopes: [
          { options: this.config.permissions, origin: 'runtime' },
          { options: agent.config.permissions, origin: `agent:${agent.name}` },
          { options: options.permissions, origin: 'run' },
        ],
        ...(checkpoint?.permissions && { checkpoint: checkpoint.permissions }),
        root: resolvePath(
          permissionService.settingsOptions?.root ?? workspaceOf(active)?.root ?? process.cwd()
        ),
        record: async (event) => {
          notify('onPermissionDecision', () => options.onPermissionDecision?.(event));
          await runMemory.event(
            active.id,
            { type: 'approval', event: { ...event } },
            `${event.decision} ${event.toolName}: ${event.reason}`
          );
        },
      });
      control.modes?.attach(permissions);
      permissions.onModeChange((mode) => {
        runMemory
          .event(
            active.id,
            { type: 'custom', event: { kind: 'permission_mode', mode } },
            `The run switched to ${mode} mode`
          )
          .catch(() => undefined);
      });
      const planTool = permissions.active ? exitPlanModeTool(permissions) : undefined;
      const buildRegistry = (owner: Agent) => {
        const ownerRegistry = new ToolRegistry();
        const handoff = handoffTools(owner);
        const own = new Set([...owner.tools, ...handoff.tools].map((t) => t.name));
        ownerRegistry.registerMany(this.builtinTools(owner).filter((t) => !own.has(t.name)));
        ownerRegistry.registerMany(this.tools.getAll().filter((t) => !own.has(t.name)));
        ownerRegistry.registerMany(owner.tools);
        ownerRegistry.registerMany(handoff.tools);
        harness.addTools(owner, ownerRegistry);
        if (planTool && !ownerRegistry.has(planTool.name)) ownerRegistry.register(planTool);
        return { registry: ownerRegistry, targets: handoff.targets };
      };
      let { registry, targets: handoffTargets } = buildRegistry(active);
      const requestedToolChoice = options.toolChoice;
      const forcedTool =
        typeof requestedToolChoice === 'object' ? requestedToolChoice.function.name : undefined;
      if (
        typeof requestedToolChoice === 'object' &&
        !registry.get(requestedToolChoice.function.name)
      ) {
        throw new CogitatorError({
          message: `toolChoice names "${requestedToolChoice.function.name}", which agent "${active.name}" does not have`,
          code: ErrorCode.VALIDATION_ERROR,
        });
      }

      let effectiveModel = agentModel;
      let routeProvider = agent.config.provider;
      let backend: LLMBackend;
      let model: string;
      let input: string;
      let messages: Message[];
      let contextPartitions: BuiltContext['partitions'] | undefined;
      let sentItemIds: string[] = [];

      if (checkpoint) {
        input = checkpoint.input;
        effectiveModel = checkpoint.model;
        routeProvider = checkpoint.provider;
        ({ backend, model } = this.turnRoute(effectiveModel, routeProvider));
        messages = [...checkpoint.messages];
      } else {
        input = await buildInputWithAudio(options.input, options.audio, {
          apiKey:
            this.config.llm?.providers?.openai?.apiKey ??
            (options.audio?.length ? readEnv('OPENAI_API_KEY') : undefined),
          signal: abortController.signal,
        });
        const runOptions: RunOptions = input === options.input ? options : { ...options, input };

        const costRouter = this.state.costRouter;
        const recommendation =
          costRouter && this.config.costRouting?.autoSelectModel
            ? await costRouter.recommendAvailableModel(input, (provider) =>
                this.servesProvider(provider, agentModel, agent.config.provider)
              )
            : undefined;

        if (recommendation) {
          effectiveModel = `${recommendation.provider}/${recommendation.modelId}`;
          routeProvider = undefined;
        }
        ({ backend, model } = this.turnRoute(effectiveModel, routeProvider));

        if (costRouter) {
          const budgetCheck = recommendation
            ? costRouter.checkBudget(recommendation.estimatedCost)
            : costRouter.checkRunBudget(input, this.pricedModel(effectiveModel, routeProvider));
          if (!budgetCheck.allowed) {
            throw new CogitatorError({
              message: `Budget exceeded: ${budgetCheck.reason}`,
              code: ErrorCode.BUDGET_EXCEEDED,
            });
          }
        }

        if (!runMemory.aside) await this.abandonPausedRun(agent, runOptions, threadId);
        const budgetTools = harness.schemas(registry, options.history ?? [], forcedTool);
        messages = await this.prepareMessages(
          agent,
          harness.systemPrompt(agent),
          runOptions,
          threadId,
          runMemory,
          this.historyBudget(agent, effectiveModel, routeProvider, budgetTools),
          (initial) =>
            waitForAbortable(
              pipeline.beforeRun({ input, messages: initial }, middlewareContext()),
              abortController.signal
            ),
          (built) => {
            contextPartitions = built.partitions;
            sentItemIds = [
              ...built.facts.map((fact) => fact.id),
              ...(built.recalled?.items.map((item) => item.id) ?? []),
            ];
          }
        );
        const historyTools = harness.schemas(registry, messages, forcedTool);
        if (
          historyTools.length > budgetTools.length &&
          this.state.contextBuilder &&
          this.config.memory?.contextBuilder?.maxTokens === undefined
        ) {
          messages = await this.fitToModel(messages, effectiveModel, agent, historyTools);
        }
      }

      if (active.config.todos) {
        const restored = await harness.restoreTodos(messages, () =>
          this.keptTodos(threadId, options, runMemory)
        );
        if (restored?.from === 'kept' && !checkpoint) {
          messages.push(...todosRecall(restored.todos));
        }
        if (restored) reportTodos(restored.todos);
      }

      let candidates = this.modelCandidates(active, effectiveModel, routeProvider, {
        backend,
        model,
      });
      let fellBackTo: string | undefined;
      const allToolCalls: ToolCall[] = [...(checkpoint?.toolCalls ?? [])];
      let totalInputTokens = checkpoint?.usage.inputTokens ?? 0;
      let totalOutputTokens = checkpoint?.usage.outputTokens ?? 0;
      let cachedInputTokens = checkpoint?.usage.cachedInputTokens ?? 0;
      let cacheWriteTokens = checkpoint?.usage.cacheWriteTokens ?? 0;
      let reasoningTokens = checkpoint?.usage.reasoningTokens ?? 0;
      const costMeter = new RunCostMeter(this.pricer, checkpoint?.usage.cost, checkpoint?.usage);
      const costModel = this.pricedModel(effectiveModel, routeProvider);
      usageSoFar = () => ({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: costMeter.total(costModel),
        duration: Date.now() - startTime,
        ...(reasoningTokens > 0 && { reasoningTokens }),
        ...(cachedInputTokens > 0 && { cachedInputTokens }),
        ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
      });
      const budgetConfig = mergeBudgets(this.config.budget, options.budget);
      const interruptLimits = this.config.limits?.onExceeded === 'interrupt';
      const maxTokensPerRun = this.config.limits?.maxTokensPerRun;
      const agentBudgets = new Map<string, BudgetLimits | undefined>([
        [agent.id, agent.config.budget],
        [active.id, active.config.budget],
      ]);
      const costRouter = this.state.costRouter;
      const runBudget = new RunBudget(
        {
          runId,
          threadId,
          config: budgetConfig,
          agentLimits: (id) => agentBudgets.get(id),
          ...(interruptLimits && maxTokensPerRun !== undefined && { maxTokensPerRun }),
          ...(interruptLimits &&
            costRouter && { costLimits: (cost: number) => costRouter.spentAgainstLimits(cost) }),
          ...(options.onBudgetWarning && { onWarning: options.onBudgetWarning }),
        },
        budgetConfig.session || budgetConfig.agent
          ? await this.loadSessionSpend(threadId, options)
          : readSessionSpend(undefined),
        checkpoint?.budget
      );
      budget = runBudget;
      let budgetStop: BudgetUsage | undefined;
      for (const entry of answeredNow) {
        if (entry.kind !== 'budget') continue;
        const usage = usageOf(entry);
        const response = readBudgetResponse(entry.response);
        if (usage && response && runBudget.answer(usage, response) === 'stop') budgetStop = usage;
      }
      const reasoningParts: string[] = [...(checkpoint?.reasoning ?? [])];
      let reasoning = options.reasoning ?? active.config.reasoning;
      const promptCache = this.config.llm?.promptCache ?? {};
      const maxIterations = agent.config?.maxIterations ?? 10;
      let iterationCap = checkpoint?.iterationLimit ?? maxIterations;
      const answerAtLimit = (agent.config?.onIterationLimit ?? 'answer') === 'answer';
      const limit = { reached: false, closingTurn: false };
      let lastToolCallSig = checkpoint?.lastToolCallSignature ?? '';
      let pausedTurn: PausedTurn | undefined;
      let responseFormat = toLLMResponseFormat(active.config.responseFormat);

      const allReflections: Reflection[] = [];
      const allActions: ReflectionAction[] = [];
      const agentContext: AgentContext = {
        agentId: agent.id,
        agentName: agent.name,
        runId,
        threadId,
        goal: input,
        iterationIndex: 0,
        previousActions: [],
        availableTools: registry.getNames(),
      };

      if (!checkpoint && this.state.reflectionEngine && this.config.reflection?.enabled) {
        await enrichMessagesWithInsights(messages, this.state.reflectionEngine, agentContext);
      }

      const memoryNotes: Promise<void>[] = [];
      const switchTo = async (target: Agent, reason: unknown) => {
        await harness.prepare(target);
        const kept = harness.forHandoff(target, messages);
        if (kept.length !== messages.length) {
          messages.length = 0;
          messages.push(...kept);
        }
        const event: HandoffEvent = {
          from: active.name,
          to: target.name,
          ...(typeof reason === 'string' && reason && { reason }),
        };
        handoffs.push(event);
        options.onHandoff?.(event);
        const system = messages[0];
        const fromPrompt = harness.systemPrompt(active);
        const toPrompt = harness.systemPrompt(target);
        const content =
          system?.role === 'system' &&
          typeof system.content === 'string' &&
          system.content.startsWith(fromPrompt)
            ? toPrompt + system.content.slice(fromPrompt.length)
            : toPrompt;
        if (system?.role === 'system') messages[0] = { role: 'system', content };
        else messages.unshift({ role: 'system', content });
        spans.push(
          createSpan(
            'agent.handoff',
            traceId,
            rootSpanId,
            Date.now(),
            Date.now(),
            { 'handoff.from': event.from, 'handoff.to': event.to },
            'ok',
            'internal',
            options.onSpan
          )
        );
        active = target;
        agentBudgets.set(target.id, target.config.budget);
        if (this.state.memoryAdapter && options.useMemory !== false) {
          memoryNotes.push(
            noteThreadRun(
              this.state.memoryAdapter,
              threadId,
              {
                memoryId: memoryAgentId(target),
                ...(options.userId !== undefined && { userId: options.userId }),
              },
              options.onMemoryError
            ).catch((error: unknown) =>
              getLogger().warn('Could not note the agent a run handed over to', {
                threadId,
                error: error instanceof Error ? error.message : String(error),
              })
            )
          );
        }
        pipeline = pipelineFor(target);
        ({ registry, targets: handoffTargets } = buildRegistry(target));
        effectiveModel = this.resolveModel(target);
        routeProvider = target.config.provider;
        ({ backend, model } = this.turnRoute(effectiveModel, routeProvider));
        candidates = this.modelCandidates(target, effectiveModel, routeProvider, {
          backend,
          model,
        });
        reasoning = options.reasoning ?? target.config.reasoning;
        responseFormat = toLLMResponseFormat(target.config.responseFormat);
        lastToolCallSig = '';
      };

      const passesChecks = async (item: QueuedRunMessage): Promise<boolean> => {
        try {
          await waitForAbortable(
            pipeline.beforeRun(
              {
                input: getTextContent(item.content),
                messages: [...messages, { role: 'user', content: item.content }],
              },
              middlewareContext()
            ),
            abortController.signal
          );
          return true;
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          queue?.refuse(item, error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      };
      /** Delivers what passes the checks, and counts the steering and follow-up messages of it */
      const deliver = async (queued: readonly QueuedRunMessage[]): Promise<number> => {
        let wakes = 0;
        for (const item of queued) {
          if (!(await passesChecks(item)) || !queue?.settle(item)) continue;
          const message: Message = { role: 'user', content: item.content };
          messages.push(message);
          if (item.kind !== 'inject') {
            wakes++;
            lastToolCallSig = '';
          }
          await runMemory.save(active.id, message, undefined, undefined, { queued: item.kind });
        }
        return wakes;
      };

      const permissionCall = (
        tool: Tool,
        toolCall: ToolCall,
        needsApproval: boolean
      ): PermissionCall => ({
        toolCallId: toolCall.id,
        needsApproval,
        ...(workspaceOf(active) && { workspace: workspaceOf(active) }),
        skillRules: harness.activeSkillRules(
          active,
          messages,
          permissionService.settingsOptions?.trusted !== false
        ),
        classifierInput: () => ({
          toolName: tool.name,
          description: tool.description,
          arguments: toolCall.arguments,
          request: input,
          transcript: transcriptOf(messages, classifierTranscriptLength(this.config.permissions)),
          signal: abortController.signal,
        }),
      });
      const decisionEvent = (
        toolCall: ToolCall,
        decision: PermissionDecision
      ): PermissionDecisionEvent => ({
        ...decision,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });

      const handleToolTurn = async (
        toolCalls: ToolCall[],
        resumed?: {
          decisions: Record<string, ToolApprovalDecision>;
          fallback?: ToolApprovalDecision;
          interrupts?: readonly RunInterrupt[];
          completed?: readonly string[];
          denied?: Record<string, string>;
          /** Decisions a person gave with the resume, not before the pause */
          fresh?: readonly string[];
        }
      ): Promise<PausedTurn | undefined> => {
        const done = new Set(resumed?.completed ?? []);
        const open = toolCalls.filter((call) => !done.has(call.id));
        if (!resumed) {
          const currentSig = toolCalls
            .map(
              (tc) =>
                `${tc.name}:${tc.argumentsError === undefined ? JSON.stringify(tc.arguments) : `unreadable ${tc.argumentsError}`}`
            )
            .join('|');
          if (currentSig === lastToolCallSig) {
            for (const tc of toolCalls) {
              const errorResult: ToolResult = {
                callId: tc.id,
                name: tc.name,
                result: null,
                error: 'Duplicate tool call detected. Try a different approach.',
              };
              options.onToolCall?.(tc);
              options.onToolResult?.(errorResult);
              const duplicateMessage = createToolMessage(tc, errorResult);
              messages.push(duplicateMessage);
              await runMemory.save(active.id, duplicateMessage, undefined, [errorResult]);
            }
            lastToolCallSig = '';
            return undefined;
          }
          lastToolCallSig = currentSig;

          for (const toolCall of toolCalls) {
            allToolCalls.push(toolCall);
            options.onToolCall?.(toolCall);
          }
        }

        const toolBudget = runBudget.beforeTools(active.id, open.length);
        if (toolBudget) {
          return {
            toolCalls,
            decisions: { ...resumed?.decisions },
            ...(resumed?.denied && { denied: { ...resumed.denied } }),
            pending: [],
            interrupts: [
              ...(resumed?.interrupts ?? []).filter(
                (entry) => entry.kind !== 'budget' && entry.kind !== 'approval' && isAnswered(entry)
              ),
              budgetInterrupt(toolBudget),
            ],
            completed: [...done],
          };
        }

        const decisions = new Map(Object.entries(resumed?.decisions ?? {}));
        const denied = new Map(Object.entries(resumed?.denied ?? {}));
        const fresh = new Set(resumed?.fresh ?? []);
        const runArguments = new Map<string, ToolCall>();
        const pending: ToolApprovalRequest[] = [];
        for (const toolCall of open) {
          const tool = registry.get(toolCall.name);
          if (
            !tool ||
            toolCall.argumentsError !== undefined ||
            decisions.has(toolCall.id) ||
            denied.has(toolCall.id)
          ) {
            continue;
          }
          const needs =
            needsApproval(tool, toolCall.arguments) ||
            this.state.constitutionalAI?.toolNeedsApproval(tool, toolCall.arguments) === true;
          const verdict = await permissions.decide(
            tool,
            toolCall.arguments,
            permissionCall(tool, toolCall, needs)
          );
          if (verdict.decision !== 'ask') {
            if (verdict.decision === 'deny') denied.set(toolCall.id, verdict.reason);
            else if (verdict.decidedBy !== 'default')
              decisions.set(toolCall.id, { approved: true });
            await permissions.record(decisionEvent(toolCall, verdict));
            continue;
          }
          const suggestedRule = permissions.suggest(tool, toolCall.arguments, workspaceOf(active));
          const request: ToolApprovalRequest = {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            description: tool.description,
            ...(tool.sideEffects && { sideEffects: [...tool.sideEffects] }),
            ...(permissions.active && {
              reason: verdict.reason,
              ...(verdict.rule && { rule: verdict.rule }),
              ...(suggestedRule !== undefined && { suggestedRule }),
              mode: verdict.mode,
            }),
          };
          const decision =
            resumed?.fallback ?? (await this.decideApproval(request, options.onApproval));
          if (decision === 'pause') {
            pending.push(request);
          } else {
            decisions.set(toolCall.id, decision);
            fresh.add(toolCall.id);
          }
        }

        for (const toolCall of open) {
          const decision = decisions.get(toolCall.id);
          const tool = registry.get(toolCall.name);
          if (!decision || !tool) continue;
          const answered = fresh.has(toolCall.id);
          let event: PermissionDecisionEvent | undefined = answered
            ? {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                decision: decision.approved ? 'allow' : 'deny',
                decidedBy: 'user',
                mode: permissions.mode,
                reason: decision.approved
                  ? 'Approved by the user'
                  : `Declined by the user${decision.reason ? `: ${decision.reason}` : ''}`,
              }
            : undefined;
          if (decision.approved && decision.updatedArguments) {
            const checked = await this.checkUpdatedArguments(
              tool,
              decision.updatedArguments,
              permissions,
              permissionCall(tool, { ...toolCall, arguments: decision.updatedArguments }, false)
            );
            if ('error' in checked) {
              decisions.delete(toolCall.id);
              denied.set(toolCall.id, checked.error);
              if (event) event = { ...event, decision: 'deny', reason: checked.error };
            } else {
              runArguments.set(toolCall.id, { ...toolCall, arguments: checked.args });
              if (event) event = { ...event, updatedArguments: checked.args };
            }
          }
          if (answered && decision.approved && decision.remember && !denied.has(toolCall.id)) {
            const remembered = await permissions.remember(
              tool,
              (runArguments.get(toolCall.id) ?? toolCall).arguments,
              decision.remember,
              workspaceOf(active)
            );
            if (remembered && event) event = { ...event, remembered };
          }
          if (event) await permissions.record(event);
        }

        if (pending.length > 0) {
          return {
            toolCalls,
            decisions: Object.fromEntries(
              [...decisions].map(([id, decision]) => [id, withoutRemember(decision)])
            ),
            ...(denied.size > 0 && { denied: Object.fromEntries(denied) }),
            pending,
            interrupts: pending.map(approvalInterrupt),
            completed: [...done],
          };
        }
        const askedBefore = (resumed?.interrupts ?? []).filter(
          (entry) => entry.kind === 'input' || entry.kind === 'plan'
        );
        const stillAsking = new Map(
          askedBefore
            .filter((entry) => !isAnswered(entry) && entry.toolCallId !== undefined)
            .map((entry) => [entry.toolCallId, entry])
        );
        if (resumed) checkpointKept = false;
        if (resumed && !runMemory.aside) await this.runCheckpointStore().delete(threadId);

        const executeToolCall = async (toolCall: ToolCall): Promise<ToolOutcome> => {
          const toolSpanStart = Date.now();
          const toolSpanId = newSpanId();
          const decision = decisions.get(toolCall.id);
          const refusal = denied.get(toolCall.id);
          if (refusal !== undefined) {
            return {
              toolCall,
              result: {
                callId: toolCall.id,
                name: toolCall.name,
                result: null,
                error: `Permission denied: ${refusal}`,
                errorCode: 'PERMISSION_DENIED',
              },
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: Date.now(),
            };
          }
          if (decision?.approved === false) {
            const declined: ToolResult = {
              callId: toolCall.id,
              name: toolCall.name,
              result: null,
              error: `The user declined this tool call${decision.reason ? `: ${decision.reason}` : ''}`,
            };
            return {
              toolCall,
              result: declined,
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: Date.now(),
            };
          }
          const unanswered = stillAsking.get(toolCall.id);
          if (unanswered && isExpired(unanswered, Date.now())) {
            return {
              toolCall,
              result: {
                callId: toolCall.id,
                name: toolCall.name,
                result: null,
                error: `Nobody answered "${unanswered.message}" before it expired at ${unanswered.expiresAt ?? 'its deadline'}`,
              },
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: Date.now(),
            };
          }
          if (unanswered) {
            return {
              toolCall,
              interrupt: unanswered,
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: toolSpanStart,
            };
          }
          let result: ToolResult;
          try {
            result = await waitForAbortable(
              withTraceContext({ traceId, parentSpanId: toolSpanId }, () =>
                insideToolOf(runId, () =>
                  runToolCall({
                    registry,
                    toolCall: runArguments.get(toolCall.id) ?? toolCall,
                    runId,
                    agentId: active.id,
                    sandboxManager: this.state.sandboxManager,
                    initializeSandbox: () => initializeSandbox(this.config, this.state),
                    signal: abortController.signal,
                    extraContext: {
                      threadId,
                      userId: options.userId,
                      channelType: options.channelType,
                      channelId: options.channelId,
                      topicId: options.topicId,
                      conversationId: options.conversationId,
                      ...(options.deps !== undefined && { deps: options.deps }),
                      ...(workspaceOf(active) && { workspace: workspaceOf(active) }),
                      interrupt: toolInterrupter(toolCall, askedBefore, (id, schema) =>
                        this.interruptSchemas.remember(runId, id, schema)
                      ),
                      ...(permissions.view() && { permissions: permissions.view() }),
                    },
                    approved: decision?.approved === true,
                    allowNativeFallback: this.config.sandbox?.allowNativeFallback !== false,
                    middleware: pipeline,
                    context: middlewareContext(),
                    ...(timeouts.toolMs !== undefined && { defaultTimeout: timeouts.toolMs }),
                    ...(stepGate && { step: { gate: stepGate, alone: runsAlone(toolCall) } }),
                    ...(options.onToolUpdate && {
                      onUpdate: (progress: ToolProgress) =>
                        options.onToolUpdate?.({
                          ...progress,
                          callId: toolCall.id,
                          name: toolCall.name,
                        }),
                    }),
                  })
                )
              ),
              abortController.signal
            );
          } catch (error) {
            if (!isToolInterrupt(error) || abortController.signal.aborted) throw error;
            return {
              toolCall,
              interrupt: error.interrupt,
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: Date.now(),
            };
          }
          runBudget.noteToolCalls(active.id, 1);
          const toolSpanEnd = Date.now();
          return { toolCall, result, toolSpanId, toolSpanStart, toolSpanEnd };
        };

        const maxLengthOf = (toolCall: ToolCall): number =>
          registry.get(toolCall.name)?.maxResultLength ??
          this.config.limits?.maxToolResultLength ??
          DEFAULT_TOOL_RESULT_MAX_LENGTH;
        const dispatched = new Set<string>();
        const finished = new Map<string, ToolResult>();
        const dispatch = async (toolCall: ToolCall): Promise<ToolOutcome> => {
          throwIfAborted(abortController.signal);
          dispatched.add(toolCall.id);
          const outcome = await executeToolCall(toolCall);
          if (outcome.result && !abortController.signal.aborted) {
            finished.set(toolCall.id, outcome.result);
          }
          return outcome;
        };
        const recordAbortedTurn = async () => {
          for (const toolCall of open) {
            const ran = finished.get(toolCall.id);
            if (!ran && dispatched.has(toolCall.id)) continue;
            const result: ToolResult = ran ?? {
              callId: toolCall.id,
              name: toolCall.name,
              result: null,
              error: ABORTED_BEFORE_DISPATCH,
            };
            const toolMessage = createToolMessage(toolCall, result, maxLengthOf(toolCall));
            messages.push(toolMessage);
            await runMemory.save(active.id, toolMessage, undefined, ...savedToolResult(result));
          }
        };

        const stepGate = parallelToolCalls ? new StepGate() : undefined;
        const runsAlone = (toolCall: ToolCall): boolean => {
          if (!parallelToolCalls) return true;
          const tool = registry.get(toolCall.name);
          if (
            !tool ||
            toolCall.argumentsError !== undefined ||
            decisions.get(toolCall.id)?.approved === false ||
            denied.has(toolCall.id) ||
            stillAsking.has(toolCall.id)
          ) {
            return false;
          }
          return !isConcurrencySafe(tool, toolCall.arguments);
        };
        let outcomes: ToolOutcome[];
        try {
          outcomes = await scheduleToolCalls({
            count: open.length,
            safe: (index) => !runsAlone(open[index]),
            maxParallel: maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
            run: (index) => dispatch(open[index]),
            stops: (outcome) => outcome.interrupt !== undefined,
          });
        } catch (error) {
          if (abortController.signal.aborted) await recordAbortedTurn();
          throw error;
        }

        const reflectionMessages: Message[] = [];
        const asked: ToolOutcome[] = [];

        for (const outcome of outcomes) {
          const { toolCall, result, toolSpanId, toolSpanStart, toolSpanEnd } = outcome;
          if (!result) {
            asked.push(outcome);
            continue;
          }
          const toolSpan = createSpan(
            `tool.${toolCall.name}`,
            traceId,
            rootSpanId,
            toolSpanStart,
            toolSpanEnd,
            {
              'tool.name': toolCall.name,
              'tool.call_id': toolCall.id,
              'tool.arguments': JSON.stringify(toolCall.arguments),
              'tool.success': !result.error,
              'tool.error': result.error,
              [GEN_AI.operationName]: 'execute_tool',
              [GEN_AI.toolName]: toolCall.name,
              [GEN_AI.toolCallId]: toolCall.id,
              [GEN_AI.toolType]: 'function',
              [GEN_AI.agentName]: active.name,
              ...(conversationId && { [GEN_AI.conversationId]: conversationId }),
              ...(result.error && { [GEN_AI.errorType]: result.errorCode ?? TOOL_ERROR_TYPE }),
              ...(captureContent && {
                [GEN_AI.toolCallArguments]: safeJson(toolCall.arguments),
                ...(!result.error && {
                  [GEN_AI.toolCallResult]: toolResultContent(result.result, maxLengthOf(toolCall)),
                }),
              }),
            },
            result.error ? 'error' : 'ok',
            'internal',
            options.onSpan,
            toolSpanId
          );
          spans.push(toolSpan);

          options.onToolResult?.(result);

          const offloadTo = offloadWorkspace(registry, workspaceOf(active));
          const toolMessage = await createToolMessageWithOffload(
            toolCall,
            result,
            maxLengthOf(toolCall),
            offloadTo
              ? {
                  workspace: offloadTo,
                  runId,
                  retention: this.config.limits?.toolResultRetention,
                }
              : undefined
          );
          messages.push(toolMessage);

          await runMemory.save(active.id, toolMessage, undefined, ...savedToolResult(result));

          const action: ReflectionAction = {
            type: 'tool_call',
            toolName: toolCall.name,
            input: toolCall.arguments,
            output: result.result,
            error: result.error,
            duration: toolSpanEnd - toolSpanStart,
          };
          allActions.push(action);

          const reflection = this.config.reflection;
          const reflectOnFailure = action.error !== undefined && !!reflection?.reflectAfterError;
          if (
            this.state.reflectionEngine &&
            reflection?.enabled &&
            (reflectOnFailure || reflection.reflectAfterToolCall)
          ) {
            try {
              const reflectionResult = reflectOnFailure
                ? await this.state.reflectionEngine.reflectOnError(action, agentContext)
                : await this.state.reflectionEngine.reflectOnToolCall(action, agentContext);
              allReflections.push(reflectionResult.reflection);

              if (reflectionResult.shouldAdjustStrategy && reflectionResult.suggestedAction) {
                reflectionMessages.push({
                  role: 'system',
                  content: `Reflection: ${reflectionResult.reflection.analysis.reasoning}. Consider: ${reflectionResult.suggestedAction}`,
                });
              }
            } catch (reflectionError) {
              getLogger().warn('Reflection failed', {
                error:
                  reflectionError instanceof Error
                    ? reflectionError.message
                    : String(reflectionError),
              });
            }
          }
        }
        messages.push(...reflectionMessages);
        if (asked.length > 0) {
          const ran = [...done, ...finished.keys()];
          const left = new Set(
            open.filter((call) => !finished.has(call.id)).map((call) => call.id)
          );
          const deniedLeft = [...denied].filter(([id]) => left.has(id));
          return {
            toolCalls,
            decisions: Object.fromEntries(
              [...decisions]
                .filter(([id]) => left.has(id))
                .map(([id, decision]) => [id, withoutRemember(decision)])
            ),
            ...(deniedLeft.length > 0 && { denied: Object.fromEntries(deniedLeft) }),
            pending: [],
            interrupts: [
              ...new Map(
                [
                  ...askedBefore.filter(
                    (entry) =>
                      entry.toolCallId !== undefined &&
                      left.has(entry.toolCallId) &&
                      isAnswered(entry)
                  ),
                  ...asked.flatMap((outcome) => (outcome.interrupt ? [outcome.interrupt] : [])),
                ].map((entry) => [entry.id, entry])
              ).values(),
            ],
            completed: ran,
          };
        }
        const handoff = toolCalls.find((call) => handoffTargets.has(call.name));
        const target = handoff && handoffTargets.get(handoff.name);
        if (handoff && target) await switchTo(target, handoff.arguments.reason);
        return undefined;
      };

      const closeTurnAtBudget = async (
        toolCalls: readonly ToolCall[],
        completed: readonly string[]
      ): Promise<void> => {
        const ran = new Set(completed);
        for (const toolCall of toolCalls) {
          if (ran.has(toolCall.id)) continue;
          const result: ToolResult = {
            callId: toolCall.id,
            name: toolCall.name,
            result: null,
            error: STOPPED_AT_BUDGET,
          };
          options.onToolResult?.(result);
          const toolMessage = createToolMessage(toolCall, result);
          messages.push(toolMessage);
          await runMemory.save(active.id, toolMessage, undefined, [result]);
        }
      };

      const reachedLimit = (): boolean => {
        if (iterations < iterationCap) return false;
        limit.reached = true;
        if (!answerAtLimit) return true;
        limit.closingTurn = true;
        messages.push({ role: 'user', content: ITERATION_LIMIT_PROMPT });
        return false;
      };

      if (checkpoint && resumeFrom) {
        if (answeredNow.length > 0) {
          await runMemory.event(
            active.id,
            {
              type: 'interrupt',
              event: {
                status: 'resumed',
                interrupts: answeredNow.map((entry) => ({
                  id: entry.id,
                  kind: entry.kind,
                  reason: entry.reason,
                  response: entry.response,
                })),
              },
            },
            `Resumed with the answers to ${answeredNow.map((entry) => entry.reason).join(', ')}`
          );
        }
        if (budgetStop) {
          await closeTurnAtBudget(checkpoint.turn.toolCalls, checkpoint.turn.completed ?? []);
        } else {
          pausedTurn = await handleToolTurn(checkpoint.turn.toolCalls, {
            decisions: {
              ...checkpoint.turn.decisions,
              ...answeredDecisions,
              ...resumeFrom.decisions,
            },
            fallback: resumeFrom.defaultDecision,
            interrupts: resumedInterrupts,
            ...(checkpoint.turn.completed && { completed: checkpoint.turn.completed }),
            ...(checkpoint.turn.denied && { denied: checkpoint.turn.denied }),
            fresh: [...Object.keys(answeredDecisions), ...Object.keys(resumeFrom.decisions)],
          });
          if (!pausedTurn) reachedLimit();
        }
      }

      let lastFinishReason: ChatResponse['finishReason'] | undefined;
      const streamsText = Boolean(options.stream && (options.onToken ?? options.onReasoning));
      const onToken = options.onToken ?? (() => undefined);
      let structuredRepaired = false;
      let emptyAnswerRetries = 0;

      let deliveredAtStop = false;
      while (!pausedTurn && !budgetStop && (iterations < iterationCap || limit.closingTurn)) {
        throwIfAborted(abortController.signal);
        const steering = queue?.takeForTurn(deliveredAtStop) ?? [];
        deliveredAtStop = false;
        if (steering.length > 0) await deliver(steering);
        if (!interruptLimits) {
          this.assertTokenBudget(totalInputTokens + totalOutputTokens);
          this.assertCostBudget(costMeter.total(costModel));
        }
        const reachedBudget = runBudget.beforeModel(
          active.id,
          costMeter.total(costModel),
          totalInputTokens + totalOutputTokens
        );
        if (reachedBudget) {
          pausedTurn = {
            toolCalls: [],
            decisions: {},
            pending: [],
            interrupts: [budgetInterrupt(reachedBudget)],
            completed: [],
          };
          break;
        }

        iterations++;
        const changed = await waitForAbortable(
          pipeline.beforeModel({ messages, model: effectiveModel }, middlewareContext()),
          abortController.signal
        );
        if (changed) {
          messages.length = 0;
          messages.push(...changed);
        }

        agentContext.iterationIndex = iterations - 1;
        agentContext.previousActions = [...allActions];

        const recordFailedCall = (
          error: unknown,
          candidate: ModelCandidate,
          sentRequest: ChatRequest,
          startedAt: number,
          timing?: StreamTiming
        ): void => {
          const cause = abortController.signal.aborted ? abortController.signal.reason : error;
          spans.push(
            createSpan(
              'llm.chat',
              traceId,
              rootSpanId,
              startedAt,
              Date.now(),
              {
                'llm.model': sentRequest.model,
                'llm.iteration': iterations,
                'llm.failure': cause instanceof Error ? failureReason(cause) : '_OTHER',
                [GEN_AI.operationName]: 'chat',
                [GEN_AI.providerName]: genAiProviderName(candidate.backend.provider),
                ...chatRequestAttributes(sentRequest),
                ...(timing && { [GEN_AI.requestStream]: true }),
                ...(conversationId && { [GEN_AI.conversationId]: conversationId }),
                [GEN_AI.errorType]: errorType(cause),
              },
              'error',
              'client',
              options.onSpan
            )
          );
        };

        const recordCall = (
          answer: ChatResponse,
          candidate: ModelCandidate,
          sentRequest: ChatRequest,
          startedAt: number,
          timing?: StreamTiming
        ): void => {
          const sentModel = sentRequest.model;
          const rerouted = sentModel !== candidate.model;
          const priced = rerouted ? sentModelName(candidate, sentModel) : candidate.name;
          const spentBefore = costMeter.total(costModel);
          costMeter.add(answer.usage, priced);
          const callCost = costMeter.total(costModel) - spentBefore;
          if (!abortController.signal.aborted)
            spans.push(
              createSpan(
                'llm.chat',
                traceId,
                rootSpanId,
                startedAt,
                Date.now(),
                {
                  'llm.model': sentModel,
                  'llm.iteration': iterations,
                  'llm.input_tokens': answer.usage.inputTokens,
                  'llm.output_tokens': answer.usage.outputTokens,
                  'llm.cost': callCost,
                  ...(answer.usage.cachedInputTokens && {
                    'llm.cached_input_tokens': answer.usage.cachedInputTokens,
                  }),
                  ...(answer.usage.reasoningTokens && {
                    'llm.reasoning_tokens': answer.usage.reasoningTokens,
                  }),
                  'llm.finish_reason': answer.finishReason,
                  [GEN_AI.operationName]: 'chat',
                  [GEN_AI.providerName]: genAiProviderName(candidate.backend.provider),
                  ...chatRequestAttributes(sentRequest),
                  ...(timing && { [GEN_AI.requestStream]: true }),
                  ...chatResponseAttributes(answer),
                  ...(conversationId && { [GEN_AI.conversationId]: conversationId }),
                  ...(answer.finishReason === 'error' && {
                    [GEN_AI.errorType]: ErrorCode.LLM_INVALID_RESPONSE,
                  }),
                  ...(timing?.firstChunkAt !== undefined && {
                    [GEN_AI.responseTimeToFirstChunk]: (timing.firstChunkAt - startedAt) / 1000,
                  }),
                  ...(captureContent && chatContentAttributes(sentRequest, answer)),
                },
                answer.finishReason === 'error' ? 'error' : 'ok',
                'client',
                options.onSpan
              )
            );
          totalInputTokens += answer.usage.inputTokens;
          totalOutputTokens += answer.usage.outputTokens;
          cachedInputTokens += answer.usage.cachedInputTokens ?? 0;
          cacheWriteTokens += answer.usage.cacheWriteTokens ?? 0;
          reasoningTokens += answer.usage.reasoningTokens ?? 0;
          runBudget.noteModel(
            active.id,
            callCost,
            answer.usage.inputTokens + answer.usage.outputTokens
          );
          runBudget.warn(
            active.id,
            costMeter.total(costModel),
            totalInputTokens + totalOutputTokens
          );
          if (answer.usage.cost === undefined) this.pricer.noteUnpriced(priced);
          this.state.costRouter?.recordCost({
            runId,
            agentId: agent.id,
            threadId,
            model: candidate === candidates[0] && !rerouted ? effectiveModel : priced,
            inputTokens: answer.usage.inputTokens,
            outputTokens: answer.usage.outputTokens,
            cost: callCost,
          });
        };
        const turnToolChoice = limit.closingTurn
          ? 'none'
          : toolChoiceForTurn(requestedToolChoice, allToolCalls.length > 0, registry);
        const turnTools = harness
          .schemas(
            registry,
            messages,
            typeof turnToolChoice === 'object' ? turnToolChoice.function.name : undefined
          )
          .filter(
            (schema) =>
              schema.name !== EXIT_PLAN_MODE ||
              registry.get(EXIT_PLAN_MODE) !== planTool ||
              permissions.mode === 'plan'
          );

        const streamsToolInput = Boolean(options.stream) && listensToToolInput(options, registry);
        const streaming = streamsText || streamsToolInput;
        const holdsStream = streaming && pipeline.holdsStream;
        let streamed = false;
        let streamedText = false;
        let reachedModel = false;
        shown.text = '';
        shown.agentId = active.id;
        const turnStream = holdsStream
          ? () => undefined
          : (token: string) => {
              streamed = true;
              streamedText = true;
              shown.text += token;
              onToken(token);
            };
        const onReasoning = options.onReasoning;
        const turnRegistry = registry;
        const inputLedger = new ToolInputLedger((event) => {
          notify('onToolInputAbandoned', () => options.onToolInputAbandoned?.(event));
          notify('onInputAbandoned', () =>
            turnRegistry.get(event.toolName)?.onInputAbandoned?.(event)
          );
        });
        const toolInputSink: Pick<
          ModelStreamSink,
          'onToolInputStart' | 'onToolInputDelta' | 'onToolInputAvailable'
        > =
          holdsStream || !streamsToolInput
            ? {}
            : {
                onToolInputStart: (event) => {
                  streamed = true;
                  inputLedger.started(event);
                  notify('onToolInputStart', () => options.onToolInputStart?.(event));
                  notify('onInputStart', () =>
                    turnRegistry.get(event.toolName)?.onInputStart?.(event)
                  );
                },
                onToolInputDelta: (event) => {
                  notify('onToolInputDelta', () => options.onToolInputDelta?.(event));
                  notify('onInputDelta', () =>
                    turnRegistry.get(event.toolName)?.onInputDelta?.(event)
                  );
                },
                onToolInputAvailable: (event) => {
                  inputLedger.available(event);
                  notify('onToolInputAvailable', () => options.onToolInputAvailable?.(event));
                  notify('onInputAvailable', () =>
                    turnRegistry.get(event.toolName)?.onInputAvailable?.(event)
                  );
                },
              };
        const abandonInputs = (error: unknown): never => {
          inputLedger.abandonAll();
          throw error;
        };
        const turnPipeline = pipeline;
        const stage = turnStage(abortController.signal, timeouts);
        const turn = await stage
          .run(() =>
            waitForAbortable(
              this.fallbackChain().run<ChatResponse>(
                candidates,
                async (candidate) => {
                  reachedModel = false;
                  const turnMessages =
                    candidate === candidates[0]
                      ? messages
                      : await this.fitToModel(messages, candidate.name, active, turnTools);
                  const request: ChatRequest = {
                    model: candidate.model,
                    messages: turnMessages,
                    tools: turnTools,
                    ...(turnToolChoice && { toolChoice: turnToolChoice }),
                    temperature: active.config.temperature,
                    topP: active.config.topP,
                    maxTokens: active.config.maxTokens,
                    stop: active.config.stopSequences,
                    responseFormat,
                    reasoning,
                    cache: promptCache,
                    cachePrefix: harness.systemPrompt(active),
                    signal: stage.signal,
                  };
                  const call: ModelCallRequest = {
                    request,
                    model: candidate.name,
                    ...(streaming && {
                      stream: {
                        onToken: turnStream,
                        ...(onReasoning && {
                          onReasoning: (delta: string) => {
                            streamed = true;
                            onReasoning(delta);
                          },
                        }),
                        ...toolInputSink,
                      },
                    }),
                  };
                  const answer = normalizeTurn(
                    await turnPipeline.callModel(
                      call,
                      async (sent) => {
                        const startedAt = Date.now();
                        const timing: StreamTiming | undefined = sent.stream ? {} : undefined;
                        let sentAnswer: ChatResponse;
                        try {
                          sentAnswer = normalizeTurn(
                            sent.stream
                              ? await streamChatRequest(
                                  candidate.backend,
                                  sent.request,
                                  sent.stream,
                                  timing,
                                  { chunkTimeout: timeouts.chunkMs }
                                )
                              : await candidate.backend.chat(sent.request)
                          );
                        } catch (error) {
                          recordFailedCall(error, candidate, sent.request, startedAt, timing);
                          throw error;
                        }
                        reachedModel = true;
                        recordCall(sentAnswer, candidate, sent.request, startedAt, timing);
                        return sentAnswer;
                      },
                      middlewareContext()
                    )
                  );
                  if (answer.finishReason !== 'error') return answer;
                  throw llmInvalidResponse(
                    { provider: candidate.backend.provider, model: candidate.model },
                    `The model ended its turn with an error${answer.finishMessage ? `: ${answer.finishMessage}` : ''}`
                  );
                },
                {
                  signal: stage.signal,
                  canSwitch: () => !streamed,
                  onFallback: (event) => {
                    const reason = failureReason(event.error);
                    getLogger().warn('Model failed, falling back to the next model', {
                      from: event.from,
                      to: event.to,
                      reason,
                    });
                    spans.push(
                      createSpan(
                        'llm.fallback',
                        traceId,
                        rootSpanId,
                        Date.now(),
                        Date.now(),
                        {
                          'llm.fallback.from': event.from,
                          'llm.fallback.to': event.to,
                          'llm.fallback.reason': reason,
                        },
                        'error',
                        'internal',
                        options.onSpan
                      )
                    );
                    options.onModelFallback?.(event);
                    runMemory
                      .event(
                        active.id,
                        { type: 'model_change', event: { from: event.from, to: event.to, reason } },
                        `The turn moved from ${event.from} to ${event.to}`
                      )
                      .catch(() => undefined);
                  },
                }
              ),
              stage.signal
            )
          )
          .catch(abandonInputs);
        const answeredBy = turn.candidate;
        fellBackTo = answeredBy === candidates[0] ? undefined : answeredBy.name;
        let response = turn.result;
        lastFinishReason = response.finishReason;
        if (response.reasoning) reasoningParts.push(response.reasoning);

        response = await waitForAbortable(
          turnPipeline.afterModel(
            { response, messages, model: answeredBy.name },
            middlewareContext()
          ),
          abortController.signal
        ).catch(abandonInputs);
        inputLedger.settle(limit.closingTurn ? [] : (response.toolCalls ?? []));

        if (
          isEmptyAnswer(response) &&
          emptyAnswerRetries < MAX_EMPTY_ANSWER_RETRIES &&
          iterations < iterationCap
        ) {
          emptyAnswerRetries++;
          getLogger().warn('Model returned an empty answer, asking again', {
            model: answeredBy.model,
            iteration: iterations,
            attempt: emptyAnswerRetries,
          });
          continue;
        }

        const outputContent = response.content;
        const answeredAlone = !reachedModel && !streamedText;
        if (streaming && outputContent && (holdsStream || answeredAlone)) onToken(outputContent);

        const requestsTools = !limit.closingTurn && Boolean(response.toolCalls?.length);
        const assistantMessage = requestsTools
          ? ({
              role: 'assistant',
              content: outputContent,
              toolCalls: response.toolCalls,
            } as Message & { toolCalls: ToolCall[] })
          : ({ role: 'assistant', content: outputContent } as Message);
        messages.push(assistantMessage);

        const finalAnswer = !requestsTools;
        const structuredProblem =
          finalAnswer &&
          !streamsText &&
          !structuredRepaired &&
          !blockReasonOf(response.finishReason) &&
          iterations < iterationCap
            ? structuredOutputProblem(active.config.responseFormat, outputContent)
            : undefined;

        if (structuredProblem) {
          structuredRepaired = true;
          messages.push({
            role: 'user',
            content: `Your answer does not match the required response format (${structuredProblem}). Reply again with only the corrected JSON.`,
          });
          continue;
        }

        options.onModelTurn?.({
          content: outputContent,
          toolCalls: requestsTools ? (response.toolCalls ?? []) : [],
          model: answeredBy.name,
        });

        await runMemory.save(
          active.id,
          assistantMessage,
          requestsTools ? response.toolCalls : undefined
        );
        shown.text = '';

        if (!requestsTools || !response.toolCalls) {
          let delivered = 0;
          for (let next = queue?.takeAtStop() ?? []; next.length > 0 && delivered === 0;) {
            delivered = await deliver(next);
            if (delivered === 0) next = queue?.takeAtStop() ?? [];
          }
          if (delivered === 0) break;
          deliveredAtStop = true;
          iterationCap = iterations + maxIterations;
          limit.reached = false;
          limit.closingTurn = false;
          emptyAnswerRetries = 0;
          structuredRepaired = false;
          continue;
        }
        pausedTurn = await handleToolTurn(response.toolCalls);
        runBudget.warn(active.id, costMeter.total(costModel), totalInputTokens + totalOutputTokens);
        if (pausedTurn) break;
        if (reachedLimit()) break;
      }

      queue?.close();

      if (pausedTurn) {
        const pausedSpend = await this.keepSessionSpend(threadId, options, runBudget);
        const permissionState = permissions.state();
        const pausedCheckpoint: RunCheckpoint = {
          version: 1,
          runId,
          agentId: active.id,
          threadId,
          ...(options.userId !== undefined && { userId: options.userId }),
          model: effectiveModel,
          ...(routeProvider !== undefined && { provider: routeProvider }),
          input,
          messages: restoreClearedOutputs(messages, middlewareState),
          toolCalls: allToolCalls,
          ...(prompt && { prompt }),
          ...(active !== agent && { activeAgent: active.name }),
          ...(handoffs.length > 0 && { handoffs }),
          turn: {
            toolCalls: pausedTurn.toolCalls,
            decisions: pausedTurn.decisions,
            ...(pausedTurn.completed.length > 0 && { completed: pausedTurn.completed }),
            ...(pausedTurn.denied &&
              Object.keys(pausedTurn.denied).length > 0 && { denied: pausedTurn.denied }),
          },
          interrupts: pausedTurn.interrupts,
          iterations,
          ...(iterationCap !== maxIterations && { iterationLimit: iterationCap }),
          lastToolCallSignature: lastToolCallSig,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens,
            cacheWriteTokens,
            reasoningTokens,
            cost: costMeter.state(),
          },
          reasoning: reasoningParts,
          startedAt: checkpoint?.startedAt ?? startTime,
          trace: { traceId, rootSpanId },
          ...((parallelToolCalls !== undefined ||
            maxParallelToolCalls !== undefined ||
            Object.keys(ownTimeouts).length > 0) && {
            toolExecution: {
              ...(parallelToolCalls !== undefined && { parallelToolCalls }),
              ...(maxParallelToolCalls !== undefined && { maxParallelToolCalls }),
              ...(Object.keys(ownTimeouts).length > 0 && { timeouts: { ...ownTimeouts } }),
            },
          }),
          ...(permissionState && { permissions: permissionState }),
          ...(runBudget.configured && { budget: runBudget.state() }),
        };
        const waitingOn = pausedTurn.interrupts.filter((entry) => !isAnswered(entry));
        if (pausedTurn.pending.length > 0) {
          await runMemory.event(
            active.id,
            {
              type: 'approval',
              event: {
                pending: pausedTurn.pending.map((request) => ({
                  toolCallId: request.toolCallId,
                  toolName: request.toolName,
                })),
              },
            },
            `Paused for approval of ${pausedTurn.pending.map((request) => request.toolName).join(', ')}`
          );
        } else {
          await runMemory.event(
            active.id,
            {
              type: 'interrupt',
              event: {
                status: 'paused',
                interrupts: waitingOn.map((entry) => ({
                  id: entry.id,
                  kind: entry.kind,
                  reason: entry.reason,
                  message: entry.message,
                  ...(entry.toolCallId !== undefined && { toolCallId: entry.toolCallId }),
                  ...(entry.expiresAt !== undefined && { expiresAt: entry.expiresAt }),
                })),
              },
            },
            `Paused for ${waitingOn.map((entry) => entry.reason).join(', ')}`
          );
        }
        const placement = runMemory.placement;
        if (placement) pausedCheckpoint.branch = placement;
        if (!runMemory.aside) await this.runCheckpointStore().save(pausedCheckpoint);
        spans.unshift(
          createSpan(
            'agent.run',
            traceId,
            parentSpanId,
            startTime,
            Date.now(),
            {
              'agent.id': agent.id,
              'agent.name': agent.name,
              'agent.model': effectiveModel,
              'run.id': runId,
              'run.thread_id': threadId,
              'run.status': 'paused',
              'run.iterations': iterations,
              'run.tool_calls': allToolCalls.length,
              'run.input_tokens': totalInputTokens,
              'run.output_tokens': totalOutputTokens,
              ...invokeAgentAttributes(agent, conversationId, effectiveModel),
              [GEN_AI.usageInputTokens]: totalInputTokens,
              [GEN_AI.usageOutputTokens]: totalOutputTokens,
            },
            'unset',
            'internal',
            options.onSpan,
            rootSpanId
          )
        );
        const lastAssistant = messages.filter((message) => message.role === 'assistant').pop();
        const paused: RunResult = {
          output: getTextContent(lastAssistant?.content ?? ''),
          runId,
          agentId: agent.id,
          threadId,
          status: 'paused',
          pendingApprovals: pausedTurn.pending,
          interrupts: waitingOn,
          ...(queue && queue.pending.length > 0 && { undelivered: queue.pending }),
          ...(runMemory.summary() && { memory: runMemory.summary() }),
          ...(handoffs.length > 0 && { handoffs, finalAgent: active.name }),
          ...(harness.todos && { todos: harness.todos }),
          ...(pausedSpend && { sessionSpend: pausedSpend }),
          checkpoint: pausedCheckpoint,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            cost: costMeter.total(costModel),
            duration: Date.now() - startTime,
          },
          ...(reasoningParts.length > 0 && { reasoning: reasoningParts.join('\n\n') }),
          toolCalls: allToolCalls,
          messages: restoreClearedOutputs(messages, middlewareState),
          trace: { traceId, spans: publicSpans() },
        };
        if (sentItemIds.length > 0) this.noteRetrieved(sentItemIds, runId);
        options.onRunComplete?.(paused);
        pausedOut = true;
        return paused;
      }

      const kept = runMemory.enabled && runMemory.isOpen;
      for (const item of queue?.pending ?? []) {
        if (item.kind !== 'inject' || !kept || !(await passesChecks(item))) continue;
        if (!queue?.claim(item)) continue;
        await runMemory.save(
          active.id,
          { role: 'user', content: item.content },
          undefined,
          undefined,
          { queued: item.kind }
        );
      }
      const endTime = Date.now();
      const lastAssistantMessage = messages.filter((m) => m.role === 'assistant').pop();
      const finalOutput = lastAssistantMessage ? getTextContent(lastAssistantMessage.content) : '';
      const structured = parseStructuredOutput(active.config.responseFormat, finalOutput);
      const structuredError =
        structured === undefined
          ? structuredOutputProblem(active.config.responseFormat, finalOutput)
          : undefined;

      if (
        this.state.reflectionEngine &&
        this.config.reflection?.enabled &&
        this.config.reflection.reflectAtEnd
      ) {
        try {
          const runReflection = await this.state.reflectionEngine.reflectOnRun(
            agentContext,
            allActions,
            finalOutput,
            true
          );
          allReflections.push(runReflection.reflection);
        } catch (reflectionError) {
          getLogger().warn('End-of-run reflection failed', {
            error:
              reflectionError instanceof Error ? reflectionError.message : String(reflectionError),
          });
        }
      }

      const rootSpan = createSpan(
        'agent.run',
        traceId,
        parentSpanId,
        startTime,
        endTime,
        {
          'agent.id': agent.id,
          'agent.name': agent.name,
          'agent.model': agentModel,
          'run.id': runId,
          'run.thread_id': threadId,
          'run.iterations': iterations,
          'run.tool_calls': allToolCalls.length,
          'run.input_tokens': totalInputTokens,
          'run.output_tokens': totalOutputTokens,
          ...clearedToolOutputsAttributes(middlewareState),
          ...contextPartitionAttributes(contextPartitions),
          ...invokeAgentAttributes(agent, conversationId, agentModel),
          [GEN_AI.usageInputTokens]: totalInputTokens,
          [GEN_AI.usageOutputTokens]: totalOutputTokens,
          ...(cachedInputTokens > 0 && { [GEN_AI.usageCacheReadInputTokens]: cachedInputTokens }),
          ...(cacheWriteTokens > 0 && { [GEN_AI.usageCacheWriteInputTokens]: cacheWriteTokens }),
          ...(reasoningTokens > 0 && { [GEN_AI.usageReasoningOutputTokens]: reasoningTokens }),
        },
        'ok',
        'internal',
        options.onSpan,
        rootSpanId
      );
      spans.unshift(rootSpan);

      const runCost = costMeter.total(costModel);
      const blocked = blockReasonOf(lastFinishReason);
      const sessionSpend = await this.keepSessionSpend(threadId, options, runBudget);

      const result: RunResult = {
        output: finalOutput,
        ...(structured !== undefined && { structured }),
        ...(structuredError && { structuredError }),
        status: 'completed',
        ...(limit.reached && { iterationLimitReached: true }),
        ...(prompt && { prompt }),
        ...(handoffs.length > 0 && { handoffs, finalAgent: active.name }),
        runId,
        agentId: agent.id,
        threadId,
        modelUsed: fellBackTo ?? (this.config.costRouting?.enabled ? effectiveModel : undefined),
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          cost: runCost,
          duration: endTime - startTime,
          ...(reasoningTokens > 0 && { reasoningTokens }),
          ...(cachedInputTokens > 0 && { cachedInputTokens }),
          ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
        },
        ...(reasoningParts.length > 0 && { reasoning: reasoningParts.join('\n\n') }),
        ...(lastFinishReason === 'length' && { truncated: true }),
        ...(blocked && { blocked }),
        toolCalls: allToolCalls,
        messages: restoreClearedOutputs(messages, middlewareState),
        trace: {
          traceId,
          spans: publicSpans(),
        },
        reflections: allReflections.length > 0 ? allReflections : undefined,
        reflectionSummary: this.state.reflectionEngine
          ? await this.state.reflectionEngine.getSummary(agent.id)
          : undefined,
        ...(runMemory.summary() && { memory: runMemory.summary() }),
        ...(harness.todos && { todos: harness.todos }),
        ...(queue && queue.pending.length > 0 && { undelivered: queue.pending }),
        ...(budgetStop && { budgetStop }),
        ...(sessionSpend && { sessionSpend }),
      };

      if (prompt) await this.recordPrompt(prompt, result, Date.now() - startTime);

      await runMemory.settled();
      await Promise.all(memoryNotes);
      if (sentItemIds.length > 0) this.noteRetrieved(sentItemIds, runId);
      await pipeline.afterRun(
        {
          result,
          model: fellBackTo ?? this.pricedModel(effectiveModel, routeProvider),
          memoryAgentId: memoryAgentId(agent),
        },
        middlewareContext()
      );
      const afterRun = this.afterRunSpend.get(runId);
      this.afterRunSpend.delete(runId);
      const finished: RunResult = afterRun
        ? {
            ...result,
            usage: {
              ...result.usage,
              inputTokens: result.usage.inputTokens + afterRun.inputTokens,
              outputTokens: result.usage.outputTokens + afterRun.outputTokens,
              totalTokens: result.usage.totalTokens + afterRun.inputTokens + afterRun.outputTokens,
              cost: result.usage.cost + afterRun.cost,
            },
          }
        : result;

      options.onRunComplete?.(finished);

      return finished;
    } catch (error) {
      queue?.close();
      if (budget) await this.keepSessionSpend(threadId, options, budget).catch(() => undefined);
      if (prompt) await this.recordPrompt(prompt, undefined, Date.now() - startTime);
      if (abortController.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        if (shown.text && options.saveInterruptedReply !== false) {
          await runMemory.save(
            shown.agentId,
            { role: 'assistant', content: shown.text },
            undefined,
            undefined,
            { interrupted: true }
          );
        }
        await runMemory.event(
          agent.id,
          { type: 'interrupt', event: { reason } },
          `The run was interrupted: ${reason}`
        );
      } else {
        await runMemory.settled();
      }
      const endTime = Date.now();

      const errorSpan = createSpan(
        'agent.run',
        traceId,
        parentSpanId,
        startTime,
        endTime,
        {
          'agent.id': agent.id,
          'agent.name': agent.name,
          'agent.model': agent.model ?? this.config.llm?.defaultModel,
          'run.id': runId,
          error:
            error instanceof LLMError
              ? failureReason(error)
              : error instanceof Error
                ? error.message
                : String(error),
          ...invokeAgentAttributes(
            agent,
            conversationId,
            agent.model ?? this.config.llm?.defaultModel
          ),
          [GEN_AI.errorType]: errorType(error),
        },
        'error',
        'internal',
        options.onSpan,
        rootSpanId
      );
      spans.unshift(errorSpan);

      options.onRunError?.(
        error instanceof Error ? error : new Error(String(error)),
        runId,
        usageSoFar()
      );

      throw error;
    } finally {
      if (!pausedOut && !checkpointKept) this.interruptSchemas.forgetRun(runId);
      if (this.runMemories.get(runId) === runMemory) this.runMemories.delete(runId);
      this.afterRunSpend.delete(runId);
      releaseRunSlot?.();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      removeParentAbortListener?.();
    }
  }

  /**
   * The messages a new run starts with: `systemPrompt` (the agent's instructions with what the
   * run adds to them), the thread's history and the input,
   * once the input passed `checkInput` (the `beforeRun` hooks), with the
   * input saved to memory. `historyBudget` is the context builder's budget
   * for this run, when `memory.contextBuilder.maxTokens` sets none.
   */
  private async prepareMessages(
    agent: Agent,
    systemPrompt: string,
    options: RunOptions,
    threadId: string,
    runMemory: RunMemory,
    historyBudget: number | undefined,
    checkInput: (messages: readonly Message[]) => Promise<void>,
    onContext?: (built: BuiltContext) => void
  ): Promise<Message[]> {
    const messages = await buildInitialMessages(
      { id: agent.id, name: agent.name, config: agent.config, instructions: systemPrompt },
      options,
      threadId,
      this.state.memoryAdapter,
      this.state.contextBuilder,
      historyBudget,
      onContext,
      this.memoryFilesIndex(agent, options)
    );
    runMemory.open();

    await checkInput(messages);

    if (options.context) {
      addContextToMessages(messages, options.context);
    }

    await runMemory.save(agent.id, {
      role: 'user',
      content: buildUserContent(options.input, options.images),
    });

    return messages;
  }

  /**
   * Keeps `todos` in the metadata of thread `threadId` (`todos`), with the entry of the run's
   * branch they were written at, so a later run on that branch finds the list after its
   * `write_todos` calls left the history. Only for a run that saves to memory on the thread's
   * active branch. A failed write is logged, the run goes on.
   */
  private async keepTodos(
    threadId: string,
    todos: readonly TodoItem[],
    runMemory: RunMemory
  ): Promise<void> {
    const memory = this.state.memoryAdapter;
    if (!memory || !runMemory.enabled || !runMemory.isOpen || runMemory.aside) return;
    try {
      await runMemory.settled();
      const entryId = runMemory.conversation?.leafId ?? undefined;
      const kept: KeptTodos = { items: [...todos], ...(entryId && { entryId }) };
      const updated = await memory.updateThread(threadId, { [TODOS_METADATA_KEY]: kept });
      if (!updated.success) throw new Error(updated.error);
    } catch (error) {
      getLogger().warn('Could not keep the todo list in the thread metadata', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The todo list kept in the metadata of thread `threadId`, for a run that reads memory: only
   * when the entry it was written at is on the run's branch (a memory without branches has one).
   * A failed read is logged and gives none.
   */
  private async keptTodos(
    threadId: string,
    options: RunOptions,
    runMemory: RunMemory
  ): Promise<TodoItem[] | undefined> {
    const memory = this.state.memoryAdapter;
    if (!memory || options.useMemory === false || !runMemory.isOpen) return undefined;
    try {
      const thread = await memory.getThread(threadId);
      if (!thread.success || !thread.data) return undefined;
      const kept = parseKeptTodos(thread.data.metadata[TODOS_METADATA_KEY]);
      if (!kept) return undefined;
      if (kept.entryId === undefined || !memory.getPath) return kept.items;
      await runMemory.settled();
      const leafId = runMemory.conversation?.leafId;
      if (leafId === null) return undefined;
      const path = await memory.getPath({
        threadId,
        ...(leafId !== undefined && { leafId }),
        types: 'all',
      });
      return path.success && path.data.some((entry) => entry.id === kept.entryId)
        ? kept.items
        : undefined;
    } catch (error) {
      getLogger().warn('Could not read the todo list kept in the thread metadata', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Versioned instructions and A/B tests of this Cogitator's agents
   * (`prompts` config, in process memory by default).
   */
  get prompts(): PromptRegistry {
    this.promptRegistry ??= new PromptRegistry(this.config.prompts);
    return this.promptRegistry;
  }

  private async recordPrompt(
    prompt: RunPrompt,
    result: RunResult | undefined,
    durationMs: number
  ): Promise<void> {
    try {
      await this.prompts.record(prompt, { result, durationMs });
    } catch (error) {
      getLogger().warn('Could not record the outcome of a run against its instructions', {
        prompt: prompt.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private runCheckpointStore(): RunCheckpointStore {
    if (this.config.runCheckpoints) return this.config.runCheckpoints;
    const memory = this.state.memoryAdapter;
    if (memory) {
      if (this.threadCheckpoints?.memory !== memory) {
        this.threadCheckpoints = { memory, store: new ThreadRunCheckpointStore(memory) };
      }
      return this.threadCheckpoints.store;
    }
    this.processCheckpoints ??= new InMemoryRunCheckpointStore();
    return this.processCheckpoints;
  }

  /**
   * A new run on a thread whose run is waiting for approvals means the user
   * moved on: the waiting calls are answered as declined, so the thread's
   * history stays whole, and the pause is dropped.
   */
  private async abandonPausedRun(
    agent: Agent,
    options: RunOptions,
    threadId: string
  ): Promise<void> {
    if (options.threadId === undefined) return;
    const store = this.runCheckpointStore();
    const paused = await store.load(threadId).catch((error: unknown) => {
      getLogger().warn('Could not read the paused run of a thread', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!paused) return;
    if (options.threadAccess !== 'shared' && paused.userId !== options.userId) return;
    await this.closePause(paused, options, threadId, agent.id, 'moved on');
  }

  /**
   * Answers the waiting calls of `paused` so the thread's history stays whole and drops the
   * pause: the user `moved on` with a new message, or `cancelled` the pause
   */
  private async closePause(
    paused: RunCheckpoint,
    options: RunOptions,
    threadId: string,
    agentId: string,
    how: 'moved on' | 'cancelled',
    reason?: string
  ): Promise<void> {
    const pausedMemory = new RunMemory(
      () => this.state.memoryAdapter,
      threadId,
      () => ({ ...options, branch: undefined })
    );
    pausedMemory.open(paused.branch);
    const asked = (paused.interrupts ?? []).filter(
      (entry) => entry.kind === 'input' && !isAnswered(entry)
    );
    this.interruptSchemas.forgetRun(paused.runId);
    const completed = new Set(paused.turn.completed ?? []);
    const because = reason ? `: ${reason}` : '';
    for (const toolCall of paused.turn.toolCalls) {
      if (completed.has(toolCall.id)) continue;
      const question = asked.find((entry) => entry.toolCallId === toolCall.id);
      const error =
        how === 'moved on'
          ? question
            ? `The user moved on without answering: ${question.message}`
            : asked.length > 0
              ? NOT_STARTED_MOVED_ON
              : 'The user moved on without approving this tool call'
          : question
            ? `The user declined to answer "${question.message}"${because}`
            : asked.length > 0
              ? `Not started: the user cancelled while an earlier tool call of this step waited for an answer${because}`
              : `The user declined this tool call${because}`;
      const result: ToolResult = { callId: toolCall.id, name: toolCall.name, result: null, error };
      await pausedMemory.save(agentId, createToolMessage(toolCall, result), undefined, [result]);
    }
    await this.runCheckpointStore().delete(threadId);
  }

  /**
   * The run paused in thread `threadId`, when one waits there: its id, the user it belongs to and
   * what it waits on (approvals and questions of its tools), from the checkpoint store, so it is
   * found after a restart too
   */
  async pausedRun(
    threadId: string
  ): Promise<{ runId: string; userId?: string; interrupts: RunInterrupt[] } | undefined> {
    await this.getMemory();
    const paused = await this.runCheckpointStore().load(threadId);
    if (!paused) return undefined;
    return {
      runId: paused.runId,
      ...(paused.userId !== undefined && { userId: paused.userId }),
      interrupts: checkpointInterrupts(paused).filter((entry) => !isAnswered(entry)),
    };
  }

  /**
   * Ends the run paused in thread `threadId` without going on: its waiting calls get a declined
   * result (a question "The user declined to answer", an approval "The user declined this tool
   * call", with `reason`), so the next run of the thread reads a whole history, and the pause is
   * dropped. False when no run waits there
   *
   * @throws CogitatorError `THREAD_ACCESS_DENIED` when `userId` is not the user the run belongs
   * to, unless `threadAccess` is `'shared'`
   */
  async cancelPause(
    threadId: string,
    options: { userId?: string; threadAccess?: 'owner' | 'shared'; reason?: string } = {}
  ): Promise<boolean> {
    await this.getMemory();
    const paused = await this.runCheckpointStore().load(threadId);
    if (!paused) return false;
    if (options.threadAccess !== 'shared' && paused.userId !== options.userId) {
      throw new CogitatorError({
        message: `The paused run in thread ${threadId} belongs to another user`,
        code: ErrorCode.THREAD_ACCESS_DENIED,
      });
    }
    await this.closePause(
      paused,
      { input: '', threadId, ...(paused.userId !== undefined && { userId: paused.userId }) },
      threadId,
      paused.agentId,
      'cancelled',
      options.reason
    );
    return true;
  }

  /** The permissions of this runtime's runs, made on first use */
  private permissionsOf(): PermissionService {
    this.permissionService ??= new PermissionService(this.config.permissions, (config) => {
      if (!config) return undefined;
      if (isPermissionClassifier(config)) return config;
      this.classifier ??= modelClassifier(async (messages, signal) => {
        const { backend, model } = this.route(config.model);
        const response = await backend.chat({ model, messages, temperature: 0, signal });
        return response.content;
      }, config);
      return this.classifier;
    });
    return this.permissionService;
  }

  /**
   * The arguments an approval changed a call to, once they pass the tool's schema and the
   * permission rules again (asking counts as allowed: a person approved them)
   */
  private async checkUpdatedArguments(
    tool: Tool,
    updated: Record<string, unknown>,
    permissions: RunPermissions,
    call: PermissionCall
  ): Promise<{ args: Record<string, unknown> } | { error: string }> {
    if (typeof tool.parameters.safeParse === 'function') {
      const parsed = tool.parameters.safeParse(updated);
      if (!parsed.success) {
        return {
          error: `the arguments the approval changed the call to do not match the tool's schema: ${parsed.error.message}`,
        };
      }
    }
    const verdict = await permissions.decide(tool, updated, call);
    if (verdict.decision === 'deny') {
      return { error: `the arguments the approval changed the call to: ${verdict.reason}` };
    }
    return { args: updated };
  }

  /** What the session of thread `threadId` spent, from its metadata or this process */
  private async loadSessionSpend(threadId: string, options: RunOptions): Promise<SessionSpend> {
    const memory = this.state.memoryAdapter;
    if (memory && options.useMemory !== false) {
      try {
        const thread = await memory.getThread(threadId);
        const kept = thread.success ? thread.data?.metadata[SESSION_BUDGET_KEY] : undefined;
        if (kept !== undefined) return readSessionSpend(kept);
      } catch (error) {
        getLogger().warn('Could not read what the session spent', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return readSessionSpend(this.sessionSpends.get(threadId));
  }

  /**
   * Adds what the run spent since it last did to what its session spent, in the thread's metadata
   * (or this process, for a thread memory does not keep), and gives back the new total. Nothing
   * for a run without session or agent budgets
   */
  private async keepSessionSpend(
    threadId: string,
    options: RunOptions,
    budget: RunBudget
  ): Promise<SessionSpend | undefined> {
    if (!budget.keepsSession) return undefined;
    const { spend, raised } = budget.pendingRecord();
    const total = addToSession(await this.loadSessionSpend(threadId, options), spend, raised);
    const memory = this.state.memoryAdapter;
    let kept = false;
    if (memory && options.useMemory !== false) {
      try {
        const updated = await memory.updateThread(threadId, { [SESSION_BUDGET_KEY]: total });
        kept = updated.success;
      } catch (error) {
        getLogger().warn('Could not keep what the session spent', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!kept) this.sessionSpends.set(threadId, total);
    budget.markRecorded(total);
    return total;
  }

  /**
   * The decision for a call that needs approval: the run's `onApproval`, else
   * `guardrails.onToolApproval`, else a pause.
   */
  private async decideApproval(
    request: ToolApprovalRequest,
    onApproval: RunOptions['onApproval']
  ): Promise<ToolApprovalDecision | 'pause'> {
    const decided = await onApproval?.(request);
    if (decided !== undefined) return decided;
    const legacy = this.config.guardrails?.onToolApproval;
    if (legacy) {
      const approved = await legacy(request.toolName, request.arguments, request.sideEffects ?? []);
      return approved ? { approved: true } : { approved: false };
    }
    return 'pause';
  }

  private async acquireRunSlot(signal: AbortSignal): Promise<(() => void) | undefined> {
    const max = this.config.limits?.maxConcurrentRuns;
    if (max === undefined) return undefined;
    this.runLimiter ??= new RunLimiter(max);
    return this.runLimiter.acquire(signal);
  }

  /**
   * Stops a decision before it is sent when spending already reached a
   * cost-routing budget, or its estimated cost would take spending past one.
   */
  private assertDecisionBudget(estimatedCost: number): void {
    const router = this.getCostRouter();
    if (!router) return;
    for (const check of [router.checkSpent(0), router.checkBudget(estimatedCost)]) {
      if (check.allowed) continue;
      throw new CogitatorError({
        message: `Budget exceeded: ${check.reason}`,
        code: ErrorCode.BUDGET_EXCEEDED,
        details: { estimatedCost },
      });
    }
  }

  /** Stops a run whose real spending reached a cost-routing budget, before its next model call. */
  private assertCostBudget(runCost: number): void {
    const check = this.state.costRouter?.checkSpent(runCost);
    if (!check || check.allowed) return;
    throw new CogitatorError({
      message: `Budget exceeded: ${check.reason}`,
      code: ErrorCode.BUDGET_EXCEEDED,
      details: { runCost },
    });
  }

  private assertTokenBudget(used: number): void {
    const max = this.config.limits?.maxTokensPerRun;
    if (max === undefined || used < max) return;
    throw new CogitatorError({
      message: `Run used ${used} tokens, which reaches limits.maxTokensPerRun (${max})`,
      code: ErrorCode.RUN_TOKEN_LIMIT_EXCEEDED,
      details: { used, max },
    });
  }

  /**
   * The model a run of `agent` uses: the agent's own, or `llm.defaultModel`.
   *
   * @throws CogitatorError (`CONFIGURATION_ERROR`) when neither is set
   */
  resolveModel(agent: Agent): string {
    const model = agent.model || this.config.llm?.defaultModel;
    if (!model) {
      throw new CogitatorError({
        message: `Agent "${agent.name}" has no model and llm.defaultModel is not set`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    return model;
  }

  private async initializeAll(agentModel: string): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this._doInitializeAll(agentModel).catch((error: unknown) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async _doInitializeAll(agentModel: string): Promise<void> {
    await this.getMemory();

    if (this.config.reflection?.enabled && !this.state.reflectionInitialized) {
      await initializeReflection(this.config, this.state, agentModel, (model) => this.route(model));
    }

    this.ensureGuardrails(agentModel);
    this.ensureCostRouting();

    if (this.config.security?.promptInjection && !this.state.securityInitialized) {
      initializeSecurity(this.config, this.state, agentModel, (model) => this.route(model));
    }

    if (this.config.context && !this.state.contextManagerInitialized) {
      initializeContextManager(this.config, this.state, (model) => this.route(model));
    }
  }

  /**
   * Guardrails need a model, which a run takes from its agent. `invokeTool` without `agent` has
   * none, so without `guardrails.model` or `llm.defaultModel`, and before a run built them with its
   * agent's model, its calls skip the guardrails: say so once.
   */
  private warnGuardrailsWithoutModel(): void {
    if (this.warnedGuardrailsWithoutModel) return;
    if (!this.config.guardrails || this.config.guardrails.enabled === false) return;
    this.warnedGuardrailsWithoutModel = true;
    getLogger().warn(
      'Guardrails are enabled but tool calls made with invokeTool skip them: set guardrails.model or llm.defaultModel, or pass the agent'
    );
  }

  /**
   * Builds the guardrails once their model is known: `guardrails.model`, else
   * the model of the agent being run, else `llm.defaultModel` — so they exist
   * before the first run whenever one of the configured models names them.
   */
  private ensureGuardrails(agentModel?: string): void {
    if (this.state.guardrailsInitialized || !this.config.guardrails) return;
    const model = agentModel ?? this.config.guardrails.model ?? this.config.llm?.defaultModel;
    if (!model) return;
    initializeGuardrails(
      this.config,
      this.state,
      model,
      (target) => this.route(target),
      this.constitution
    );
  }

  private ensureCostRouting(): void {
    if (this.config.costRouting?.enabled && !this.state.costRoutingInitialized) {
      initializeCostRouting(this.config, this.state, (model) => this.pricer.pricing(model));
    }
  }

  /**
   * The context builder's budget for a run of `agent` on `modelString`, when
   * `memory.contextBuilder.maxTokens` sets none: the model's context window,
   * minus room for the answer (`agent.maxTokens`, else 15% of the window, at
   * most half of it) and the tool schemas, and no more than the context
   * manager lets a turn grow before it compresses. The builder counts the input
   * in it and keeps no reserve of its own. A model on Ollama
   * gets at most the 4096 tokens Ollama serves by default, unless it runs on
   * Ollama Cloud.
   */
  private historyBudget(
    agent: Agent,
    modelString: string,
    explicitProvider: string | undefined,
    tools: readonly ToolSchema[]
  ): number | undefined {
    if (!this.state.contextBuilder || this.config.memory?.contextBuilder?.maxTokens !== undefined) {
      return undefined;
    }
    const window = this.servedWindow(modelString, explicitProvider);
    const answer = answerRoom(agent, window);
    const fixed = countTokens(JSON.stringify(tools));
    const compressAt = this.state.contextManager?.compressionThreshold(modelString);
    const budget = Math.floor(Math.min(window - answer, compressAt ?? Infinity) - fixed);
    if (budget > MIN_HISTORY_BUDGET) return budget;
    getLogger().warn(
      'No room for conversation history: the answer, the tools and the input take the context ' +
        'window. Set memory.contextBuilder.maxTokens, or lower the agent maxTokens.',
      { agent: agent.name, model: modelString, window, answer, fixed }
    );
    return MIN_HISTORY_BUDGET;
  }

  /** The context window `modelString` runs with: its own, or Ollama's default context. */
  private servedWindow(modelString: string, explicitProvider?: string): number {
    const known = modelContextWindow(modelString);
    return this.servesFullWindow(modelString, explicitProvider)
      ? known
      : Math.min(known, OLLAMA_DEFAULT_CONTEXT);
  }

  /**
   * `messages` cut to what a fallback model has room for, its context window minus the answer
   * and the tool schemas, when they are more: the system prompt and the newest messages stay,
   * and no tool result is left without its call. A turn that falls back to a model with a
   * smaller window than the agent's model, whose history was sized to the latter, still fits.
   */
  private async fitToModel(
    messages: Message[],
    modelString: string,
    agent: Agent,
    tools: readonly ToolSchema[]
  ): Promise<Message[]> {
    const window = this.servedWindow(modelString);
    const room = window - answerRoom(agent, window) - countTokens(JSON.stringify(tools));
    const current = countMessagesTokens(messages);
    if (current <= room) return messages;
    const cut = await new TruncateStrategy().compress({
      messages,
      targetTokens: Math.max(room, 1),
      currentTokens: current,
      windowSize: window,
    });
    return sanitizeToolHistory(cut.messages);
  }

  /**
   * Whether `modelString` runs with its whole context window: anything but a model on Ollama,
   * which serves a model with its default context, except Ollama Cloud (`https://ollama.com` as
   * `llm.providers.ollama.baseUrl`, or a model tagged `cloud`).
   */
  private servesFullWindow(modelString: string, explicitProvider: string | undefined): boolean {
    const { provider, model } = this.resolveRoute(modelString, explicitProvider);
    const custom = Object.hasOwn(this.config.llm?.backends ?? {}, provider)
      ? this.config.llm?.backends?.[provider]
      : undefined;
    if ((custom?.provider ?? provider) !== 'ollama' || model.endsWith('cloud')) return true;
    if (custom) return false;
    const baseUrl = this.config.llm?.providers?.ollama?.baseUrl;
    return baseUrl !== undefined && isOllamaCloud(baseUrl);
  }

  /**
   * The models a turn of `owner` runs on: its model as already routed, then its
   * `fallbackModels`, each once. Every fallback is routed here, so a misconfigured
   * one fails the run at its start rather than in the middle of an outage.
   */
  private modelCandidates(
    owner: Agent,
    modelString: string,
    explicitProvider: string | undefined,
    primary: ModelRoute
  ): ModelCandidate[] {
    const candidates: ModelCandidate[] = [
      { name: this.pricedModel(modelString, explicitProvider), ...primary },
    ];
    for (const fallback of owner.config.fallbackModels ?? []) {
      const [fallbackModel, fallbackProvider] =
        typeof fallback === 'string' ? [fallback, undefined] : [fallback.model, fallback.provider];
      const name = this.pricedModel(fallbackModel, fallbackProvider);
      if (candidates.some((candidate) => candidate.name === name)) continue;
      candidates.push({ name, ...this.turnRoute(fallbackModel, fallbackProvider) });
    }
    return candidates;
  }

  private fallbackChain(): ModelFallbackChain {
    this.modelChain ??= new ModelFallbackChain(this.config.llm?.modelCircuitBreaker);
    return this.modelChain;
  }

  private getBackend(modelString: string, explicitProvider?: string): LLMBackend {
    return this.route(modelString, explicitProvider).backend;
  }

  /**
   * The backend a model string runs on, and the model name to send it.
   *
   * `provider/model` picks the provider when `provider` is a backend in
   * `llm.backends`, a built-in provider or a registered plugin; anything else
   * runs on `llm.defaultProvider` (Ollama when unset) with the whole string.
   * An explicit provider keeps the model string as it is.
   */
  route(modelString: string, explicitProvider?: string): ModelRoute {
    const { provider, model } = this.chatRoute(modelString, explicitProvider);
    return { backend: this.backendFor(provider), model };
  }

  /**
   * The route of an agent turn on `modelString`: as {@link route}, on a backend without PII
   * masking, which the turn's middleware does instead.
   */
  private turnRoute(modelString: string, explicitProvider?: string): ModelRoute {
    const { provider, model } = this.chatRoute(modelString, explicitProvider);
    return { backend: this.turnBackendFor(provider), model };
  }

  private chatRoute(
    modelString: string,
    explicitProvider?: string
  ): { provider: string; model: string } {
    const route = this.resolveRoute(modelString, explicitProvider);
    if (isDecisionModel(`${route.provider}/${route.model}`)) {
      throw new CogitatorError({
        message: `${route.provider}/${route.model} is a decision model: it answers typed questions through cog.decide(), not chat`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    return route;
  }

  /**
   * Asks a decision model typed questions about `state`, such as TypeSafe's
   * Jev on OpenRouter (`openrouter/typesafe/jev-1.13`), and returns typed
   * answers with probabilities instead of text: a yes or no question answers
   * with how likely it holds, a choice with one of its options, a score with
   * a position on its scale. The call is retried like LLM calls, priced, and
   * reported to the observers as a run with one `llm.decide` span.
   *
   * @throws CogitatorError (`VALIDATION_ERROR`) for questions no model can answer,
   *   (`CONFIGURATION_ERROR`) for a provider without decision models or a key
   */
  async decide<const TQuestions extends DecisionQuestions>(
    options: DecideOptions<TQuestions>
  ): Promise<DecisionResult<TQuestions>> {
    validateDecision(options);
    const { provider, model } = this.resolveRoute(options.model);
    return runDecision(
      {
        backend: withPiiDecisions(this.decisionBackendFor(provider), this.config.security?.pii),
        provider,
        model,
        retry: this.config.llm?.retry,
        observers: this.watchers(),
        recordCost: (record) => this.getCostRouter()?.recordCost(record),
        price: (qualified, usage) => this.pricer.costOrNull(qualified, usage),
        checkBudget: (estimatedCost) => this.assertDecisionBudget(estimatedCost),
      },
      options
    );
  }

  private decisionBackendFor(provider: string): DecisionBackend {
    const custom = this.config.llm?.decisionBackends?.[provider];
    if (custom) return custom;
    const cached = this.decisionBackends.get(provider);
    if (cached) return cached;
    if (provider !== 'openrouter') {
      throw new CogitatorError({
        message: `There are no decision models on provider "${provider}": they run on OpenRouter (openrouter/typesafe/jev-1.13), or set llm.decisionBackends.${provider}`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    const config = this.config.llm?.providers?.openrouter;
    if (!config?.apiKey) {
      throw new CogitatorError({
        message:
          'Decision models on OpenRouter need llm.providers.openrouter.apiKey (OPENROUTER_API_KEY)',
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    const backend = new OpenRouterDecisionBackend({
      apiKey: config.apiKey,
      url: decisionsUrlFor(config.baseUrl),
    });
    this.decisionBackends.set(provider, backend);
    return backend;
  }

  /**
   * The model string a call to `modelString` is priced by: the provider it routes to, by the
   * name it is registered under (`llm.backends`, a plugin, a built-in provider), and the model,
   * so a bare `llama3.3` on Ollama is `ollama/llama3.3` and a backend of your own registered as
   * `vllm` prices as `vllm/...` whatever provider name it reports. A model on an Ollama or vLLM
   * backend registered under a name of your own (`gpu2/llama3.3`) is free like `ollama/...`.
   */
  pricedModel(modelString: string, explicitProvider?: string): string {
    const { provider, model } = this.resolveRoute(modelString, explicitProvider);
    return `${provider}/${model}`;
  }

  private resolveRoute(
    modelString: string,
    explicitProvider?: string
  ): { provider: string; model: string } {
    if (explicitProvider) return { provider: explicitProvider, model: modelString };
    return resolveModelRoute(modelString, {
      defaultProvider: this.config.llm?.defaultProvider,
      knowsProvider: (name) => this.knowsProvider(name),
    });
  }

  /**
   * Whether runs can be sent to `provider`: a backend in `llm.backends`, a
   * registered plugin, `llm.defaultProvider`, the provider the agent's own
   * model runs on, or a built-in provider configured in `llm.providers` with
   * the credentials it needs.
   */
  private servesProvider(provider: string, agentModel: string, agentProvider?: string): boolean {
    const llm = this.config.llm;
    if (Object.hasOwn(llm?.backends ?? {}, provider) || hasLLMPlugin(provider)) return true;
    if (provider === llm?.defaultProvider) return true;
    if (provider === this.resolveRoute(agentModel, agentProvider).provider) return true;
    if (!isLLMProvider(provider) || !Object.hasOwn(llm?.providers ?? {}, provider)) return false;
    try {
      this.backendFor(provider);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether `name` is a provider this instance routes to: a backend in
   * `llm.backends` or `llm.decisionBackends`, a built-in provider or a
   * registered plugin. A model string `name/model` runs on that provider
   * (see {@link route}), any other prefix stays part of the model name on
   * `llm.defaultProvider`.
   *
   * Credentials are not checked: a built-in provider counts even when
   * `llm.providers` has no key for it, as a run would still be sent there.
   */
  knowsProvider(name: string): boolean {
    return (
      Object.hasOwn(this.config.llm?.backends ?? {}, name) ||
      Object.hasOwn(this.config.llm?.decisionBackends ?? {}, name) ||
      isLLMProvider(name) ||
      hasLLMPlugin(name)
    );
  }

  private backendFor(name: string): LLMBackend {
    const cached = this.backends.get(name);
    if (cached) return cached;
    const backend = withPiiMasking(this.turnBackendFor(name), this.config.security?.pii);
    this.backends.set(name, backend);
    return backend;
  }

  private turnBackendFor(name: string): LLMBackend {
    const cached = this.turnBackends.get(name);
    if (cached) return cached;
    const backend = withLLMRetry(this.createBackend(name), this.config.llm?.retry);
    this.turnBackends.set(name, backend);
    return backend;
  }

  private createBackend(name: string): LLMBackend {
    const custom = this.config.llm?.backends;
    if (custom && Object.hasOwn(custom, name)) return custom[name];
    if (isLLMProvider(name)) return createLLMBackend(name, this.config.llm);
    if (hasLLMPlugin(name)) {
      return createLLMBackendFromPlugin(name, this.config.llm?.plugins?.[name]);
    }
    throw new CogitatorError({
      message: `Unknown LLM provider "${name}": not a built-in provider, a backend in llm.backends or a registered plugin`,
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  }

  /**
   * Get accumulated insights from reflection for an agent.
   *
   * Insights are learnings derived from past runs that can help
   * improve future agent performance.
   *
   * @param agentId - ID of the agent to get insights for
   * @returns Array of insights, empty if reflection is not enabled
   */
  async getInsights(agentId: string) {
    if (!this.state.insightStore) return [];
    return this.state.insightStore.getAll(agentId);
  }

  /**
   * Get reflection summary for an agent.
   *
   * Summary includes statistics about total runs, successful tool calls,
   * common patterns, and accumulated learnings.
   *
   * @param agentId - ID of the agent to get summary for
   * @returns Reflection summary, null if reflection is not enabled
   */
  async getReflectionSummary(agentId: string) {
    if (!this.state.reflectionEngine) return null;
    return this.state.reflectionEngine.getSummary(agentId);
  }

  /**
   * Get the constitutional AI guardrails instance.
   *
   * Built on first use from `guardrails.model` or `llm.defaultModel`; when
   * neither is set, the first run builds it with its agent's model.
   *
   * @returns ConstitutionalAI instance, undefined if guardrails are not
   *   configured (or are disabled), or no model for them is known yet
   */
  getGuardrails() {
    this.ensureGuardrails();
    return this.state.constitutionalAI;
  }

  /**
   * Set or update the constitution for guardrails.
   *
   * The constitution defines principles and rules that the agent
   * must follow, filtering both input and output. It takes effect at once,
   * or — when the guardrails are built later — as soon as they are, and
   * stays in force after {@link close}. Has no effect without `guardrails`
   * in the config.
   *
   * @param constitution - New constitution to apply
   */
  setConstitution(constitution: Constitution): void {
    if (!this.config.guardrails || this.config.guardrails.enabled === false) {
      getLogger().warn('setConstitution has no effect: guardrails are not enabled in the config');
      return;
    }
    this.constitution = constitution;
    if (this.state.constitutionalAI) this.state.constitutionalAI.setConstitution(constitution);
    else this.ensureGuardrails();
  }

  /**
   * Get cost tracking summary across all runs.
   *
   * @returns Cost summary with total spent, runs count, and per-model breakdown,
   *   undefined if cost routing is not enabled
   */
  getCostSummary(): CostSummary | undefined {
    this.ensureCostRouting();
    return this.state.costRouter?.getCostSummary();
  }

  /**
   * Get the cost-aware router instance for advanced cost management.
   *
   * @returns CostAwareRouter instance, undefined if cost routing not enabled
   */
  getCostRouter() {
    this.ensureCostRouting();
    return this.state.costRouter;
  }

  /**
   * Estimate the cost of running an agent before execution.
   *
   * Returns min/max/expected cost estimates based on:
   * - Model pricing (from registry)
   * - Task complexity analysis
   * - Tool usage patterns
   * - Estimated iterations
   *
   * @param params - Estimation parameters
   * @param params.agent - Agent to estimate cost for
   * @param params.input - User input/prompt
   * @param params.options - Optional estimation overrides
   * @returns Cost estimate with breakdown and confidence score
   *
   * @example
   * ```ts
   * const estimate = await cog.estimateCost({
   *   agent,
   *   input: 'Analyze this document and summarize key points',
   *   options: { assumeIterations: 3, assumeToolCalls: 5 }
   * });
   *
   * console.log(`Expected cost: $${estimate.expectedCost.toFixed(4)}`);
   * console.log(`Confidence: ${(estimate.confidence * 100).toFixed(0)}%`);
   *
   * if (estimate.expectedCost > 0.10) {
   *   console.log('Warning: This may be an expensive operation');
   * }
   * ```
   */
  async estimateCost(params: {
    agent: Agent;
    input: string;
    options?: EstimateOptions;
    model?: string;
  }): Promise<CostEstimate> {
    if (!this.costEstimator) {
      this.costEstimator = new CostEstimator({
        ownPricing: (model) => this.pricer.ownPricing(model),
        pricing: (model) => this.pricer.pricing(model),
      });
    }
    return this.costEstimator.estimate({
      ...params,
      model: this.pricedModel(
        params.model ?? this.resolveModel(params.agent),
        params.model ? undefined : params.agent.config.provider
      ),
    });
  }

  /**
   * The memory adapter, connecting it on first use when `memory` is
   * configured, so threads can be read before any agent has run. `undefined`
   * when memory is not configured or could not connect (it is tried again
   * on the next call).
   */
  async getMemory(): Promise<MemoryAdapter | undefined> {
    if (!this.state.memoryInitialized && this.config.memory?.adapter) {
      this.memoryInit ??= initializeMemory(this.config, this.state).finally(() => {
        this.memoryInit = undefined;
      });
      await this.memoryInit;
    }
    return this.state.memoryAdapter;
  }

  /**
   * The memory search tools (`search_memory`, `open_turns`, `list_entities`) over this runtime's
   * memory, for the agent whose memory id is `memoryAgentId` (its configured `id`, else its
   * name): they read the same thread store, memory items, embeddings and message index the
   * runs do. Pair them with the `memoryCitations()` middleware to keep answers to what a run
   * opened.
   *
   * @throws CogitatorError when no memory is configured
   */
  async memorySearchTools(memoryAgentId: string): Promise<Tool[]> {
    const memory = await this.getMemory();
    if (!memory) {
      throw new CogitatorError({
        message: 'memorySearchTools needs memory: set memory.adapter in the Cogitator config',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return createMemorySearchTools({
      memory,
      agentId: memoryAgentId,
      ...(this.state.memoryItems && { items: this.state.memoryItems }),
      ...(this.state.embeddingService && { embedding: this.state.embeddingService }),
      ...(this.state.messageIndex && { messageIndex: this.state.messageIndex }),
      ...((this.config.memory?.contextBuilder?.timeZone ??
        this.config.memory?.extraction?.timeZone) !== undefined && {
        timeZone:
          this.config.memory?.contextBuilder?.timeZone ?? this.config.memory?.extraction?.timeZone,
      }),
      placeOf: (runId) => this.runMemories.get(runId)?.conversation,
    });
  }

  /**
   * Runs a pass over the memory of `agent` now, as `memory.consolidation` and
   * `memory.observations` set it up: repeats and contradictions marked as stale, new lessons
   * folded into the playbook, then the observations whose facts changed written again. The
   * memory is the one the agent's runs for `userId` (or, for a run without a user, in
   * `threadId`) write their items to, as `memory.extraction.scope` says. Call it from a worker
   * or a timer while the agent is idle. A pass of the same memory under way is waited for first.
   * The look for repeats asks about `memory.consolidation.maxSubjects` subjects at most: when the
   * report's `dedupe.complete` is false, pass its `dedupe.through` as `since` to go on.
   *
   * @throws CogitatorError when neither `memory.consolidation` nor `memory.observations` is set,
   * when memory keeps no memory items, or when `run` does not name the memory: a `userId` or a
   * `threadId` for the `user` scope (the default), a `threadId` for the `thread` scope, nothing
   * for the `agent` scope
   */
  async consolidateMemory(
    agent: Agent,
    run: { userId?: string; threadId?: string; since?: Date } = {}
  ): Promise<MemoryConsolidationReport> {
    const memory = await this.getMemory();
    this.builtinMiddleware();
    const upkeep = this.memoryUpkeepLayer;
    if (!upkeep || !memory || !isMemoryItemAdapter(memory)) {
      throw new CogitatorError({
        message:
          'consolidateMemory needs memory.consolidation or memory.observations, and a memory adapter that keeps memory items',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const scope = this.config.memory?.extraction?.scope;
    if (
      (scope === 'thread' && run.threadId === undefined) ||
      (scope !== 'agent' && run.userId === undefined && run.threadId === undefined)
    ) {
      throw new CogitatorError({
        message:
          'consolidateMemory needs a userId, or a threadId for memory kept for a run without a user',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const threadId = run.threadId ?? '';
    const runId = `consolidation_${nanoid(12)}`;
    return upkeep.consolidate({
      scope: upkeepScope(memoryAgentId(agent), scope, {
        ...(run.userId !== undefined && { userId: run.userId }),
        threadId,
      }),
      model: this.resolveModel(agent),
      run: { runId, agentId: agent.id, threadId },
      ...(run.since && { since: run.since }),
    });
  }

  /**
   * Forgets what a conversation established, in every store memory keeps: `{ entryIds }` deletes
   * those entries (a user message with the entries that answer it, unless `keepReplies`),
   * `{ threadId }` the thread, `{ userId }` every thread of the user (by its
   * `metadata.userId`) and everything kept for the user. With them goes all memory derived from
   * them: compaction summaries that cover them (the next compaction writes them again), memory
   * items, facts, graph nodes and edges that stand only on them (those that stand on more lose the
   * quotes of them), their vectors, memory file versions written at them, and every version of an
   * observation or a playbook that names an item that went, the playbook in front losing those
   * rules in a new version. See `MemoryCascade` and the report it returns.
   *
   * Items, files, facts and the graph are kept by the memory id of an agent. Each thread names the
   * agents that ran in it (`metadata.memoryAgentIds`), and their memory is gone through: `agents`
   * adds others, and is needed for a thread written before threads named them and for a user
   * without threads. `graph` is a knowledge graph of your own to go through too.
   *
   * Paused runs of the threads it touches are dropped, as their messages would bring back what
   * was forgotten on resume.
   *
   * @throws CogitatorError when no memory is configured, or the agents to go through are not known
   * (a thread that names none, or a user without threads, and no `agents`). A store that fails
   * part of the way throws its own error, and the call can be made again.
   */
  async forget(
    target: { entryIds: readonly string[] } | { threadId: string } | { userId: string },
    options: MemoryCascadeCall = {}
  ): Promise<MemoryCascadeReport> {
    const { cascade, agentIds } = await this.cascadeFor('forget', options);
    if ('userId' in target) {
      const users = await this.withUserAgents(agentIds, target.userId);
      if (users.length === 0) {
        throw new CogitatorError({
          message: 'forget({ userId }) needs the agents whose memory to go through: pass agents',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      const report = await cascade.deleteUser(target.userId, { agentIds: users });
      await this.dropPausedRuns([...report.threads, ...report.threadsChanged]);
      return report;
    }
    if ('threadId' in target) {
      const report = await cascade.deleteThread(target.threadId, {
        agentIds: await this.withThreadAgents(agentIds, [target.threadId]),
      });
      await this.dropPausedRuns([target.threadId, ...report.threadsChanged]);
      return report;
    }
    const threads = await this.threadsOf(target.entryIds);
    const report = await cascade.deleteEntries(target.entryIds, {
      agentIds: await this.withThreadAgents(agentIds, threads),
      ...(options.keepReplies && { keepReplies: true }),
    });
    await this.dropPausedRuns([...threads, ...report.threadsChanged]);
    return report;
  }

  /**
   * Redacts `entryIds` in place: what they said becomes `[redacted]` while their place in the
   * thread stays (`MemoryAdapter.redactEntry`), and all memory derived from what they said goes as
   * with {@link forget}. A compaction entry among them is deleted.
   *
   * @throws CogitatorError when no memory is configured, the adapter cannot redact, or a thread
   * names no agents and `agents` is not passed. A store that fails part of the way throws its own
   * error, and the call can be made again.
   */
  async redactEntries(
    entryIds: readonly string[],
    options: MemoryCascadeCall & { reason?: string } = {}
  ): Promise<MemoryCascadeReport> {
    const { cascade, agentIds } = await this.cascadeFor('redactEntries', options);
    const memory = this.state.memoryAdapter;
    if (!memory?.redactEntry) {
      throw new CogitatorError({
        message: `The ${memory?.provider ?? 'configured'} memory adapter cannot redact entries`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const threads = await this.threadsOf(entryIds);
    const report = await cascade.redactEntries(
      entryIds,
      { at: new Date(), ...(options.reason !== undefined && { reason: options.reason }) },
      {
        agentIds: await this.withThreadAgents(agentIds, threads),
        ...(options.keepReplies && { keepReplies: true }),
      }
    );
    await this.dropPausedRuns([...threads, ...report.threadsChanged]);
    return report;
  }

  /**
   * Rewinds `threadId` to `toEntryId`, an entry of its active branch: new entries go after it,
   * and the entries after it stay on a branch of their own. The memory items that stood only on
   * those entries become `stale` (`staleBecause: { reason: 'rewound' }`), so later runs no longer
   * take them for what holds. Summaries and memory files of the branch left behind are not seen
   * from the new one already.
   *
   * @throws CogitatorError when no memory is configured, the adapter has no branches, or the thread
   * names no agents and `agents` is not passed. A store that fails throws its own error, and the
   * rewind can be made again.
   */
  async rewind(
    threadId: string,
    toEntryId: string,
    options: Pick<MemoryCascadeCall, 'agents'> = {}
  ): Promise<MemoryCascadeReport> {
    const { cascade, agentIds } = await this.cascadeFor('rewind', options);
    const memory = this.state.memoryAdapter;
    if (!memory?.rewind || !memory.getPath) {
      throw new CogitatorError({
        message: `The ${memory?.provider ?? 'configured'} memory adapter has no branches to rewind`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return cascade.rewind(threadId, toEntryId, {
      agentIds: await this.withThreadAgents(agentIds, [threadId]),
    });
  }

  /** The cascade over this runtime's memory stores, and the memory ids of `options.agents` */
  private async cascadeFor(
    method: string,
    options: MemoryCascadeCall
  ): Promise<{ cascade: MemoryCascade; agentIds: string[] }> {
    const memory = await this.getMemory();
    if (!memory) {
      throw new CogitatorError({
        message: `${method} needs memory: set memory.adapter in the Cogitator config`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const embeddings =
      this.state.embeddingStore ?? (isEmbeddingAdapter(memory) ? memory : undefined);
    const cascade = new MemoryCascade({
      memory,
      ...(isMemoryItemAdapter(memory) && { items: memory }),
      ...(isMemoryFileAdapter(memory) && { files: memory }),
      ...(isFactAdapter(memory) && { facts: memory }),
      ...(embeddings && { embeddings }),
      ...(options.graph && { graph: options.graph }),
    });
    const agentIds = [
      ...new Set([
        ...(options.agents ?? []).flatMap((agent) =>
          typeof agent === 'string' ? [agent] : [memoryAgentId(agent), agent.id]
        ),
      ]),
    ];
    return { cascade, agentIds };
  }

  /**
   * Drops the paused runs of `threadIds`: a checkpoint keeps the messages of the run, which would
   * bring what was forgotten back on resume
   */
  private async dropPausedRuns(threadIds: readonly string[]): Promise<void> {
    const store = this.runCheckpointStore();
    for (const threadId of new Set(threadIds)) {
      if (await store.load(threadId)) await store.delete(threadId);
    }
  }

  /** The threads `entryIds` are in */
  private async threadsOf(entryIds: readonly string[]): Promise<string[]> {
    const memory = this.state.memoryAdapter;
    if (!memory) return [];
    const threads = new Set<string>();
    for (const entryId of entryIds) {
      const entry = await memory.getEntry(entryId);
      if (entry.success && entry.data) threads.add(entry.data.threadId);
    }
    return [...threads];
  }

  /**
   * `agentIds` with the agents of `threadIds` and of the threads forked from them (in turn): the
   * memory ids the threads name (`metadata.memoryAgentIds`) and their owners. A thread that names
   * none, written before threads named them, needs `agentIds` from the caller.
   */
  private async withThreadAgents(
    agentIds: readonly string[],
    threadIds: readonly string[]
  ): Promise<string[]> {
    const memory = this.state.memoryAdapter;
    const all = new Set(agentIds);
    const queue = [...threadIds];
    const seen = new Set(queue);
    for (let threadId = queue.pop(); threadId !== undefined; threadId = queue.pop()) {
      const thread = await memory?.getThread(threadId);
      if (!thread?.success || !thread.data) continue;
      this.addThreadAgents(all, thread.data, agentIds.length === 0);
      for (const fork of stringsOf(thread.data.metadata[FORKS_KEY])) {
        if (seen.has(fork)) continue;
        seen.add(fork);
        queue.push(fork);
      }
    }
    return [...all];
  }

  /**
   * `agentIds` with the agents of every thread `userId` wrote in: the user's own threads, those
   * that list the user in `metadata.memoryUserIds`, and the threads forked from them. Every
   * thread is listed to find them.
   */
  private async withUserAgents(agentIds: readonly string[], userId: string): Promise<string[]> {
    const memory = this.state.memoryAdapter;
    const touched: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await memory?.listThreads({
        limit: 500,
        ...(cursor !== undefined && { cursor }),
      });
      if (!page?.success) break;
      for (const thread of page.data.threads) {
        const wrote =
          thread.metadata.userId === userId ||
          stringsOf(thread.metadata[MEMORY_USERS_KEY]).includes(userId);
        if (wrote) touched.push(thread.id);
      }
      cursor = page.data.nextCursor;
    } while (cursor !== undefined);
    return this.withThreadAgents(agentIds, touched);
  }

  /**
   * Adds to `all` the owner of `thread` and the memory ids it names, refusing a thread that names
   * none when `required`
   */
  private addThreadAgents(all: Set<string>, thread: Thread, required: boolean): void {
    all.add(thread.agentId);
    const named = memoryAgentsOf(thread.metadata);
    if (named.length === 0 && required) {
      throw new CogitatorError({
        message: `Thread ${thread.id} does not name the agents whose memory stands on it: pass agents`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    for (const id of named) all.add(id);
  }

  /**
   * Embeds every entry of `threadId` the memory index has not embedded yet and waits until their
   * vectors are stored, such as after a conversation was imported, so the first search of the
   * thread already sees all of it. With an adapter that reads a thread in pages (`getPath`) the
   * thread is read and embedded a page at a time, so a long one is never held whole, else it is
   * read at once and embedded a page at a time. Does nothing when memory keeps no index (the
   * `recent` strategy or no embedding service). Fails when the embedding store refuses a vector.
   */
  async indexMemory(threadId: string): Promise<void> {
    const memory = await this.getMemory();
    const index = this.state.messageIndex;
    if (!memory || !index) return;
    let before: string | undefined;
    for (;;) {
      const seenAt = index.mark();
      const page = memory.getPath
        ? await memory.getPath({
            threadId,
            limit: INDEX_PAGE,
            ...(before !== undefined && { before }),
          })
        : await memory.getEntries({ threadId });
      if (!page.success) throw new Error(page.error);
      const texts: IndexedText[] = page.data.flatMap((entry) => indexedText(entry) ?? []);
      for (let start = 0; start < texts.length; start += INDEX_PAGE) {
        await index.index(texts.slice(start, start + INDEX_PAGE), seenAt);
        await index.flush();
      }
      const first = page.data[0];
      if (!memory.getPath || !first || page.data.length < INDEX_PAGE) break;
      before = first.id;
    }
    await index.flush();
  }

  /**
   * The memory adapter once connected: by a run, by {@link getMemory}, or
   * set here. `undefined` before then — use `getMemory()` to connect it.
   */
  get memory(): MemoryAdapter | undefined {
    return this.state.memoryAdapter;
  }

  set memory(adapter: MemoryAdapter | undefined) {
    this.state.memoryAdapter = adapter;
    this.state.memoryInitialized = !!adapter;
  }

  getLLMBackend(modelString: string, explicitProvider?: string): LLMBackend {
    return this.getBackend(modelString, explicitProvider);
  }

  get reflectionEngine() {
    return this.state.reflectionEngine;
  }

  /**
   * Counts the memory items a run sent in the background, one count after another, so the run
   * returns without waiting on the writes; `close` waits for them
   */
  private noteRetrieved(itemIds: readonly string[], runId: string): void {
    const items = this.state.memoryItems;
    if (!items) return;
    this.state.retrievalCounts = (this.state.retrievalCounts ?? Promise.resolve())
      .then(() => items.noteRetrieved(itemIds))
      .catch((error: unknown) =>
        getLogger().warn('Could not count the memory items a run sent', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
  }

  /**
   * Close all connections and release resources.
   *
   * Should be called when done using the Cogitator instance to properly
   * disconnect from memory adapters, shut down sandbox containers, and
   * clean up internal state.
   *
   * @example
   * ```ts
   * const cog = new Cogitator({ ... });
   * try {
   *   await cog.run(agent, { input: 'Hello' });
   * } finally {
   *   await cog.close();
   * }
   * ```
   */
  async close(): Promise<void> {
    this.interruptSchemas.clear();
    await this.memoryUpkeepLayer?.close();
    this.memoryUpkeepLayer = undefined;
    await this.closeObservers();
    this.memoryFileTools.clear();
    this.memoryFilesService = undefined;
    await cleanupState(this.state);
    this.backends.clear();
    this.turnBackends.clear();
    this.initPromise = undefined;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw toAbortError(signal.reason, 'Run aborted');
  }
}

/**
 * `provider/model` of a call a middleware sent to `model` instead of `candidate`'s model, on the
 * candidate's provider: `candidate.name` is `provider/model` of the candidate.
 */
function sentModelName(candidate: ModelCandidate, model: string): string {
  const suffix = `/${candidate.model}`;
  return candidate.name.endsWith(suffix)
    ? `${candidate.name.slice(0, -suffix.length)}/${model}`
    : model;
}

/** Whether a streamed run reports tool input: a run callback for it, or a tool with input hooks */
function listensToToolInput(options: RunOptions, registry: ToolRegistry): boolean {
  if (
    options.onToolInputStart ??
    options.onToolInputDelta ??
    options.onToolInputAvailable ??
    options.onToolInputAbandoned
  ) {
    return true;
  }
  return registry
    .getAll()
    .some(
      (tool) =>
        tool.onInputStart ?? tool.onInputDelta ?? tool.onInputAvailable ?? tool.onInputAbandoned
    );
}

/** Calls a callback of the run, logging what it throws instead of failing the run */
function notify(callback: string, call: () => void): void {
  try {
    call();
  } catch (error) {
    getLogger().warn(`${callback} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * How a tool result is saved with its message: the result the model read in `toolResults`, its
 * `details` and `presentation` in the entry's metadata, never in what a model reads back.
 */
function savedToolResult(
  result: ToolResult
): [toolResults: ToolResult[], metadata?: Record<string, unknown>] {
  const { details, presentation, ...read } = result;
  if (details === undefined && presentation === undefined) return [[result]];
  return [
    [read],
    {
      ...(details !== undefined && { details }),
      ...(presentation !== undefined && { presentation }),
    },
  ];
}

/** The signal a model turn runs with, and how the turn is held to `timeouts.stepMs` */
interface TurnStage {
  signal: AbortSignal;
  /** Runs the turn: one that fails aborts the signal, so a stream it left open is closed */
  run<T>(turn: () => Promise<T>): Promise<T>;
}

/**
 * The stage of one model turn: the run's own signal when neither `stepMs` nor `chunkMs` is set,
 * else one that follows it and is aborted with `RUN_STEP_TIMEOUT` once the turn, retries and
 * fallback models included, outlasts `stepMs`.
 */
function turnStage(run: AbortSignal, timeouts: RunTimeouts): TurnStage {
  const { stepMs, chunkMs } = timeouts;
  if (!stepMs && !chunkMs) return { signal: run, run: (turn) => turn() };
  const controller = new AbortController();
  const follow = () => controller.abort(run.reason);
  if (run.aborted) follow();
  else run.addEventListener('abort', follow, { once: true });
  const timer =
    stepMs && stepMs > 0 && stepMs <= MAX_TIMER_DELAY_MS
      ? setTimeout(
          () =>
            controller.abort(
              new CogitatorError({
                message: `A model call took longer than ${stepMs}ms`,
                code: ErrorCode.RUN_STEP_TIMEOUT,
                details: { stepMs },
              })
            ),
          stepMs
        )
      : undefined;
  return {
    signal: controller.signal,
    async run(turn) {
      try {
        return await turn();
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timer);
        run.removeEventListener('abort', follow);
      }
    },
  };
}

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(toAbortError(signal.reason, 'Run aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(toAbortError(signal.reason, 'Run aborted'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * The options of `resume()`: optional, unless the agent declares its deps type, whose runs must
 * pass `deps` again (a checkpoint never holds them).
 */
type ResumeArgs<TDeps> = unknown extends TDeps
  ? [options?: ResumeOptions]
  : [options: ResumeOptions<TDeps> & { deps: TDeps }];

/** The options of `invokeTool()`: optional, unless the tool reads typed `deps`. */
type InvocationArgs<TDeps> = unknown extends TDeps
  ? [options?: ToolInvocationOptions]
  : [options: ToolInvocationOptions & { deps: TDeps }];

/**
 * Why a model failed, for logs and spans: its error kind or code, never the error's text, which
 * may carry what a backend put in it.
 */
function failureReason(error: Error): string {
  if (error instanceof LLMError && error.kind) return error.kind;
  return error instanceof CogitatorError ? error.code : error.name;
}

/** The context Ollama serves a model with unless its server is told otherwise (`OLLAMA_CONTEXT_LENGTH`). */
const OLLAMA_DEFAULT_CONTEXT = 4096;

/** The smallest history budget a run hands the context builder, which keeps the instructions anyway. */
const MIN_HISTORY_BUDGET = 256;

/** Tokens of a context window kept for the answer: the agent's `maxTokens`, else 15%, at most half. */
function answerRoom(agent: Agent, window: number): number {
  return Math.min(agent.config.maxTokens ?? Math.floor(window * 0.15), window / 2);
}

function isOllamaCloud(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'ollama.com' || host.endsWith('.ollama.com');
  } catch {
    return false;
  }
}

interface PausedTurn {
  toolCalls: ToolCall[];
  decisions: Record<string, ToolApprovalDecision>;
  /** Calls the permissions refused, with why */
  denied?: Record<string, string>;
  pending: ToolApprovalRequest[];
  /** What the turn waits on: its approvals, or the questions its tools asked and their answers */
  interrupts: RunInterrupt[];
  /** Calls of the turn that already ran */
  completed: string[];
}

/** What a resumed run goes on with */
interface ResumeFrom {
  checkpoint?: RunCheckpoint;
  decisions: Record<string, ToolApprovalDecision>;
  defaultDecision?: ToolApprovalDecision;
  responses?: Record<string, unknown>;
  checkUser: boolean;
}

/** How a run is steered from outside: its queued messages and its seat on its thread */
interface RunControl {
  queue?: RunQueue;
  seat?: ThreadSeat;
  /** The permission mode the run's handle sets */
  modes?: PermissionModeControl;
}

/** A tool call of a turn, done (`result`) or waiting for an answer it asked for (`interrupt`) */
type ToolOutcome = {
  toolCall: ToolCall;
  toolSpanId: string;
  toolSpanStart: number;
  toolSpanEnd: number;
} & (
  { result: ToolResult; interrupt?: undefined } | { result?: undefined; interrupt: RunInterrupt }
);

function isArgumentRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Where long tool results of a turn are saved: the workspace the agent's `read_file` reads, so
 * the path in the note is one the model can open. That is its bound workspace when
 * `workspaceTools(workspace)` made it, else the run's. A `read_file` of another origin (or none)
 * means the reach cannot be told, and results are only cut.
 */
function offloadWorkspace(
  registry: ToolRegistry,
  runWorkspace: Workspace | undefined
): Workspace | undefined {
  const reader = registry.get('read_file');
  if (!reader) return undefined;
  const binding = readFileBinding(reader);
  if (!binding) return undefined;
  return binding.workspace ?? runWorkspace;
}
