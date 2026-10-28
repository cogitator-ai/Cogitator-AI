import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { nanoid } from 'nanoid';
import type {
  BuiltContext,
  CogitatorConfig,
  DurableQueuedMessage,
  DurableRunHolder,
  DurableRunInfo,
  DurableRunLease,
  DurableRunRecord,
  DurableRunStore,
  DurableRunSummary,
  DurableRunsConfig,
  RecoveredAgentRuns,
  RecoverRunOptions,
  RecoverRunsOptions,
  DelegatedResume,
  DefinitionFileOptions,
  ExpandedCommand,
  SubagentCatalog,
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
  MemoryEntry,
  WorkspaceSnapshot,
  WorkspaceRestoreResult,
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
  RunNotification,
  ModelCallRequest,
  ModelStreamSink,
  RunMiddleware,
  TodoItem,
  ToolSchema,
  QueuedRunMessage,
  RunHandle,
  RunInterrupt,
  StartOptions,
  StartResumeOptions,
  CogitatorListThreadsOptions,
  ThreadPage,
  PermissionClassifier,
  PermissionDecision,
  PermissionDecisionEvent,
  PermissionsConfig,
  PermissionMode,
  SessionBudgetConfig,
  SessionSpend,
  BudgetLimits,
  BudgetUsage,
  HookMcpCaller,
  HookSettingsOptions,
  HooksConfig,
  ProjectInstructionsOptions,
  ToolCallVerdict,
  LLMPlugin,
} from '@cogitator-ai/types';
import { memoryAgentId, type Agent } from './agent';
import { ToolRegistry } from './registry';
import { readFileBinding } from './tools/workspace-tools';
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
import { experimental_PluginHost } from './plugins/host';
import { corePlugin } from './plugins/core-plugin';
import { experimental_TriggerManager, type TriggerNotifyScope } from './triggers/manager';
import type { PluginHookSet, PluginLease, PluginSnapshot } from './plugins/contributions';
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

/** Thread forks and entry copies a checkpoint check follows back at most */
const LINEAGE_HOPS = 64;

/** What a rewind or a fork with files would race, see `Cogitator.goingOn` */
interface GoingOn {
  thread: { count: number; runIds: string[] };
  inWorkspace: WorkspaceRun[];
  held: { runId: string; foreign: boolean; expiresAt?: number }[];
  /** Every run in the way, each once */
  ids: string[];
  /** Tool executions in the workspace that have not settled, of runs going on or ended */
  tools: number;
}

/** Where the entries a rewind cuts start in the branch it read */
function cutFrom(state: { index: number }): number {
  return state.index + 1;
}

/** Milliseconds a forced rewind or fork waits for the tool calls of the runs it stopped */
const TOOL_SETTLE_MS = 10_000;

/** The refusal of a restore while tool calls in the workspace have not ended */
function toolsBusy(what: 'rewind' | 'fork', threadId: string, count: number): CogitatorError {
  return new CogitatorError({
    message: `${count} tool call(s) in the workspace the ${what} would restore have not ended, also of runs that stopped: they may still write the files. Wait for them, then ${what} again`,
    code: ErrorCode.WORKSPACE_BUSY,
    details: { threadId, toolCalls: count },
  });
}

/** The refusal of a restore while commands the workspace started still run */
function workspaceBusy(
  what: 'rewind' | 'fork',
  threadId: string,
  plan: WorkspaceRestoreResult
): CogitatorError {
  return new CogitatorError({
    message: `The workspace the ${what} would restore still runs commands (or processes they left in the background): wait for them, or dispose the workspace`,
    code: ErrorCode.WORKSPACE_BUSY,
    details: { threadId, snapshotId: plan.snapshotId },
  });
}

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
import { leavesOut } from './workspace/snapshot-store';
import {
  WorkspaceRuns,
  type WorkspaceRegistration,
  type WorkspaceRun,
} from './cogitator/workspace-runs';
import {
  checkpointAt,
  checkpointSettings,
  checkpointsOn,
  forkPointMetadata,
  emptyCascadeReport,
  fileRestorePlan,
  takeFileCheckpoint,
  unwrapMemory,
  type FileRestorePlan,
  type FileRewindReport,
  type ForkThreadOptions,
  type ForkThreadPlan,
  type ForkThreadResult,
  type RewindOptions,
  type RewindReport,
} from './cogitator/file-checkpoints';
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
  ToolInterruptSignal,
} from './cogitator/interrupts';
import { MEMORY_AGENTS, noteThreadRun } from './cogitator/message-builder';
import { normalizeTurn } from './llm/turn';
import { withPiiDecisions, withPiiMasking } from './security/pii';
import { canonicalArguments, MiddlewarePipeline, middlewareStop } from './middleware/pipeline';
import {
  compactionMiddleware,
  guardrailsMiddleware,
  piiMiddleware,
  promptInjectionMiddleware,
  type CompactionNotices,
} from './middleware/builtins';
import { hooksMiddleware } from './hooks/middleware';
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
import {
  CogitatorError,
  ErrorCode,
  resolveModelRoute,
  WORKSPACE_SNAPSHOT_MAX_FILE_BYTES,
  WorkspaceError,
} from '@cogitator-ai/types';
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
import { RunHarness, todosRecall, touchedPaths } from './cogitator/harness';
import { SubagentService } from './subagents/service';
import { copyToolFilter, setToolFilter, toolFilterOf, workspaceSwapOf } from './subagents/marker';
import { reboundWorkspaceTool } from './tools/workspace-tools';
import { resolveDefinitionModel } from './subagents/models';
import { toolPolicy } from './subagents/tool-policy';
import { CommandFinder, type CommandCatalog } from './subagents/catalog';
import { commandInvocation, expandCommand } from './commands/expand';
import { definitionFileOptions } from './subagents/definitions';
import type { HookModelAsker, HooksMiddlewareDeps } from './hooks/middleware';
import {
  answersUnder,
  delegatedStream,
  isDelegatePause,
  nestApprovals,
  nestInterrupts,
} from './subagents/delegate';
import { parseKeptTodos, TODOS_METADATA_KEY, type KeptTodos } from './tools/write-todos';
import { createSpan, getTextContent } from './cogitator/span-factory';
import {
  runToolCall,
  createToolMessage,
  createToolMessageWithOffload,
  isConcurrencySafe,
  needsApproval,
  type ChangedCallPermit,
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
import { InMemoryDurableRunStore, ThreadDurableRunStore } from './cogitator/durable-stores';
import {
  DURABLE_FENCE,
  DURABLE_FENCE_KEY_PREFIX,
  durableFencesOf,
  type DurableFence,
} from '@cogitator-ai/memory';
import {
  DEFAULT_DURABLE_LEASE_MS,
  DEFAULT_STORE_RETRIES,
  DurableRunKeeper,
  rebuildDurableRun,
  type RebuiltRun,
} from './cogitator/durable-runs';
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
  ClassifierBudgetReached,
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
  freshestSpend,
  RunBudget,
  SessionLedger,
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
  const allowRaise = base?.allowRaise ?? own?.allowRaise;
  return {
    ...(Object.keys(session).length > 0 && { session }),
    ...(Object.keys(agentLimits).length > 0 && { agent: agentLimits }),
    ...(warnAt !== undefined && { warnAt }),
    ...(onWarning && { onWarning }),
    ...(allowRaise !== undefined && { allowRaise }),
  };
}

/** A run's budgets as a checkpoint keeps them: plain JSON, without the listener */
function withoutWarning(budget: SessionBudgetConfig): Omit<SessionBudgetConfig, 'onWarning'> {
  const { onWarning: _listener, allowRaise: _raise, ...rest } = budget;
  return rest;
}

/** Budgets a checkpoint kept, without the permission to raise them: only the host grants that */
function withoutRaise(
  budget: Omit<SessionBudgetConfig, 'onWarning'> | undefined
): SessionBudgetConfig | undefined {
  if (!budget) return undefined;
  const { allowRaise: _raise, ...rest } = budget;
  return rest;
}

/**
 * The key an agent's spending and `budget` go by: its `config.id`, else its name, so a new
 * instance of the same agent (a resume, another process) keeps counting against its budget.
 * Agents with budgets of their own need unique names, or ids
 */
function budgetKey(agent: Agent): string {
  return agent.config.id ?? agent.name;
}

/** The agents `agent` can hand the conversation over to */
function handoffAgentsOf(agent: Agent): Agent[] {
  return (agent.config.handoffs ?? []).map((entry) => ('agent' in entry ? entry.agent : entry));
}

/** `starts` and every agent a chain of handoffs from them reaches, each once */
function reachableAgents(starts: readonly Agent[]): Agent[] {
  const seen = new Set<Agent>();
  const queue = [...starts];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    queue.push(...handoffAgentsOf(next));
  }
  return [...seen];
}

/** How many newest messages the `auto` classifier reads */
function classifierTranscriptLength(config: PermissionsConfig | undefined): number {
  const classifier = config?.classifier;
  if (!classifier || isPermissionClassifier(classifier)) return DEFAULT_CLASSIFIER_TRANSCRIPT;
  return classifier.transcriptMessages ?? DEFAULT_CLASSIFIER_TRANSCRIPT;
}

const TRANSCRIPT_MESSAGE_CHARS = 1000;

/**
 * The newest `count` user and assistant messages, as `role: text` lines for the classifier. Tool
 * results are left out: they come from outside and could talk the classifier into a decision
 */
function transcriptOf(messages: readonly Message[], count: number): string[] {
  if (count <= 0) return [];
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
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

/** A decision given for every waiting call at once, without arguments meant for one call */
function forEveryCall(decision: ToolApprovalDecision): ToolApprovalDecision {
  if (!decision.approved || decision.updatedArguments === undefined) return decision;
  const { updatedArguments: _oneCall, ...rest } = decision;
  return rest;
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

/**
 * The tool choice a turn sends with the tools it offers: a forced tool the permissions took out of
 * the list (a bare deny) is not forced, and nothing is required of a turn without tools. Both are
 * logged, as the run asked for them
 */
function offeredToolChoice(
  choice: ToolChoice | undefined,
  tools: readonly { name: string }[]
): ToolChoice | undefined {
  if (typeof choice === 'object' && !tools.some((tool) => tool.name === choice.function.name)) {
    getLogger().warn('The forced tool is not offered to the model, the turn does not force it', {
      tool: choice.function.name,
    });
    return tools.length > 0 ? undefined : 'none';
  }
  if (choice === 'required' && tools.length === 0) {
    getLogger().warn('The run requires a tool call, but no tool is offered to the model');
    return 'none';
  }
  return choice;
}

/**
 * The permission decision for a call with what the `beforeToolCall` middleware said about it: a
 * deny stays, `ask` and `defer` make an allowed call ask. An `allow` was decided by the
 * permissions already (`PermissionCall.allowedByHook`)
 */
function hookedVerdict(
  decision: PermissionDecision,
  hooked: ToolCallVerdict | undefined
): PermissionDecision {
  const said = hooked?.decision;
  if (!said || said === 'deny' || decision.decision === 'deny') return decision;
  if (said === 'allow') return decision;
  if (decision.decision === 'ask' && said === 'ask') return decision;
  return {
    decision: 'ask',
    decidedBy: 'hook',
    mode: decision.mode,
    reason:
      hooked.reason ??
      (said === 'defer' ? 'A hook deferred the call' : 'A hook asks for approval of this call'),
  };
}

/** Who answered an approval and how, for its record: a person, or a hook */
function answeredBy(
  byHook: boolean,
  decision: ToolApprovalDecision
): { decidedBy: 'user' | 'hook'; reason: string } {
  const who = byHook ? 'a hook' : 'the user';
  return {
    decidedBy: byHook ? 'hook' : 'user',
    reason: decision.approved
      ? `Approved by ${who}`
      : `Declined by ${who}${decision.reason ? `: ${decision.reason}` : ''}`,
  };
}

/** What the model reads for a call an approval declined */
function declinedError(byHook: boolean, reason: string | undefined): string {
  return `${byHook ? 'A hook' : 'The user'} declined this tool call${reason ? `: ${reason}` : ''}`;
}

/** A tool result as the conversation holds it, for a call that ran before a pause */
function resultOfMessage(call: ToolCall, message: Message): ToolResult {
  const text = getTextContent(message.content);
  if (text.startsWith('{"error"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
        return { callId: call.id, name: call.name, result: null, error: String(parsed.error) };
      }
    } catch {
      return { callId: call.id, name: call.name, result: text };
    }
  }
  return { callId: call.id, name: call.name, result: text };
}

/** What a call of a step gets when a middleware stopped the run before the call started */
function notStartedAtStop(toolCall: ToolCall): ToolResult {
  return {
    callId: toolCall.id,
    name: toolCall.name,
    result: null,
    error: 'Not started: the run was stopped',
  };
}

const STOPPED_TURN_ID = 'cogitator:stopped';

/**
 * What a model call answers when a middleware stopped the run before it was sent: nothing, at no
 * cost, so the run ends without the call
 */
function stoppedTurn(): ChatResponse {
  return {
    id: STOPPED_TURN_ID,
    content: '',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function isStoppedTurn(response: ChatResponse): boolean {
  return response.id === STOPPED_TURN_ID;
}

/** Puts `notes` as system messages right after the system prompt (and the system notes after it) */
function afterSystemPrompt(messages: Message[], notes: readonly string[]): void {
  if (notes.length === 0) return;
  let at = 0;
  while (at < messages.length && messages[at]?.role === 'system') at++;
  messages.splice(at, 0, ...notes.map((content): Message => ({ role: 'system', content })));
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
/** The version of the core, which plugins' `engines.cogitator` ranges are checked against */
const CORE_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version;

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
  private hooksLayer?: RunMiddleware;
  /** The subagents of `subagents`, once the runtime has them */
  private readonly subagentService?: SubagentService;
  /** Finds the commands of `commands` */
  private readonly commandFinder?: CommandFinder;
  /** Where the command files are read */
  private readonly commandFiles?: DefinitionFileOptions;
  /** The middleware of each run going on and the context they get, for compaction notices */
  private readonly runPipelines = new Map<
    string,
    () => { pipeline: MiddlewarePipeline; context: RunMiddlewareContext }
  >();
  /** Approvals a `decideApproval` middleware or a hook gave, not a person */
  private readonly hookDecisions = new WeakSet<ToolApprovalDecision>();
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
  /** The runs going on in each workspace, which file restores of rewinds and forks look at */
  private readonly workspaceRuns = new WorkspaceRuns();
  private processDurableRuns?: InMemoryDurableRunStore;
  private threadDurableRuns?: { memory: MemoryAdapter; store: ThreadDurableRunStore };
  /** Who this runtime's durable runs are held by, see `DurableRunsConfig.owner` */
  private readonly durableOwner: string;
  /** Who this runtime's durable runs are held by: its owner and this instance of it */
  private readonly durableHolder: DurableRunHolder;
  /** The durable runs this runtime has going, by run id */
  private readonly durableRunsGoing = new Set<string>();
  /** The Zod schemas of the questions tools of this process's runs wait on */
  private readonly interruptSchemas = new InterruptSchemas();
  /** Permission rules, settings files and session rules of this runtime's runs */
  private permissionService?: PermissionService;
  private classifier?: PermissionClassifier;
  /** What the model calls of the `auto` classifier cost, charged to the run, by its abort signal */
  private readonly classifierCharges = new WeakMap<
    AbortSignal,
    (usage: ChatResponse['usage'], model: string) => void
  >();
  /** What each session spent, for threads without memory to keep it in */
  private readonly sessionSpends = new Map<string, SessionSpend>();
  /** The live spending of each session with runs going on in this process, by thread */
  private readonly sessionLedgers = new Map<string, SessionLedger>();
  /** The write of each thread's spending going on, so concurrent runs add up instead of overwriting */
  private readonly spendWrites = new Map<string, Promise<void>>();
  /** The budgets of the runs going on, so a run started from a tool charges its caller's too */
  private readonly runBudgets = new Map<string, { budget: RunBudget; agentId: () => string }>();
  /** Global tool registry shared across all runs */
  public readonly tools: ToolRegistry = new ToolRegistry();
  /** The plugins of this runtime: the core's own, and those of `experimental_plugins` */
  private readonly pluginHost: experimental_PluginHost;
  /** The routines and triggers of `experimental_triggers` */
  private readonly triggerManager?: experimental_TriggerManager;
  /**
   * The hooks middleware of each hook set a plugin registered, per snapshot it runs in: its
   * `mcp_tool` hooks call the MCP servers of that snapshot
   */
  private readonly pluginHookLayers = new WeakMap<
    PluginSnapshot,
    WeakMap<PluginHookSet, RunMiddleware>
  >();
  /** Backends a run builds from the plugin of a generation a reload replaced, by that plugin */
  private readonly heldBackends = new WeakMap<LLMPlugin, LLMBackend>();
  /** The plugin each cached backend was built from, so a reload builds it again */
  private readonly backendPlugins = new Map<string, unknown>();

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
    const durable = typeof config.durable === 'object' ? config.durable : undefined;
    if (
      durable?.leaseMs !== undefined &&
      !(durable.leaseMs > 0 && Number.isFinite(durable.leaseMs))
    ) {
      throw new CogitatorError({
        message: `durable.leaseMs must be a positive number of milliseconds, got ${String(durable.leaseMs)}`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    this.durableOwner = durable?.owner ?? `${hostname()}:${process.pid}:${nanoid(8)}`;
    this.durableHolder = { owner: this.durableOwner, instance: `instance_${nanoid(16)}` };
    LIVE_INSTANCES.add(this.durableHolder.instance);
    const retries = durable?.storeRetries;
    if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0)) {
      throw new CogitatorError({
        message: `durable.storeRetries must be 0 or a whole number, got ${String(retries)}`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    this.pricer = new CallPricer(config.llm?.pricing, (name) =>
      Object.hasOwn(config.llm?.backends ?? {}, name)
        ? config.llm?.backends?.[name]?.provider
        : undefined
    );
    this.observers = [...(config.observers ?? [])];
    if (config.logging) setLogger(createLoggerFromConfig(config.logging));
    const pluginSettings = this.pluginSettings();
    this.pluginHost = new experimental_PluginHost({
      ...(config.experimental_plugins && { config: config.experimental_plugins }),
      root: config.experimental_plugins?.root ?? pluginSettings?.root ?? this.permissionRoot(),
      ...(pluginSettings && { settings: pluginSettings }),
      core: [corePlugin(() => this.config.llm)],
      cogitatorVersion: CORE_VERSION,
    });
    this.pluginHost.onChange(() => this.forgetPluginBackends());
    const plugins = config.experimental_plugins !== undefined;
    if (config.subagents || plugins) {
      const subagents = config.subagents ?? {};
      const files = definitionFileOptions(subagents.files, config.permissions?.settings);
      this.subagentService = new SubagentService(this, {
        config: subagents,
        ...(files && { files }),
        ...(config.llm?.modelAliases && { modelAliases: config.llm.modelAliases }),
        hooks: () => this.frontmatterHookSetup(),
        modelProblem: (model) => this.unpricedUnderBudget(model),
        plugins: () => this.pluginHost.snapshot().agents,
      });
    }
    if (config.commands || plugins) {
      const commands = config.commands ?? {};
      const files = definitionFileOptions(commands.files, config.permissions?.settings);
      this.commandFinder = new CommandFinder(commands, () => this.pluginHost.snapshot().commands);
      this.commandFiles = files;
    }
    if (config.experimental_triggers) {
      this.triggerManager = new experimental_TriggerManager(config.experimental_triggers, {
        start: (agent, options) => this.start(agent, options),
        resume: async (agent, threadId, runId, options) => {
          await this.getMemory();
          const checkpoint = await this.runCheckpointStore().load(threadId);
          if (!checkpoint) {
            throw new CogitatorError({
              message: `Thread ${threadId} has no paused run`,
              code: ErrorCode.RUN_NOT_PAUSED,
            });
          }
          if (checkpoint.runId !== runId) {
            throw new CogitatorError({
              message: `The run paused in thread ${threadId} is ${checkpoint.runId}, not ${runId}`,
              code: ErrorCode.RUN_NOT_FOUND,
            });
          }
          if (options.responses) {
            answerInterrupts(
              checkpointInterrupts(checkpoint),
              options.responses,
              Date.now(),
              (id) => this.interruptSchemas.get(checkpoint.runId, id)
            );
          }
          return { result: this.resume(agent, checkpoint, options) };
        },
        notify: (notification, scope) => this.notifyRoutine(notification, scope),
        recoverRuns: async (filter, agentOf) => {
          const recovered = await this.recoverRuns({
            agents: (run) => agentOf(run.agentName, run.agentId),
            filter: (run) => filter(run.runId),
          });
          return {
            resumed: recovered.resumed.map(({ run, handle }) => ({ runId: run.runId, handle })),
            kept: (await this.durableRuns()).map((run) => run.runId),
          };
        },
        durableLeaseMs: this.durableConfig()?.leaseMs ?? DEFAULT_DURABLE_LEASE_MS,
        plugins: {
          routines: () => this.pluginHost.snapshot().routines,
          lease: () => this.pluginHost.lease(),
          onChange: (listener) => this.pluginHost.onChange(listener),
        },
        durable: this.durableByDefault,
      });
    }
  }

  /**
   * Experimental. The routines of `experimental_triggers` and what starts them: start it with
   * `start()`, fire a trigger by hand, answer a trigger's HTTP request (the server adapters do),
   * read the inbox. Undefined without `experimental_triggers`
   */
  get experimental_triggers(): experimental_TriggerManager | undefined {
    return this.triggerManager;
  }

  /**
   * Runs the `Notification` hooks and middleware for a routine's run that ended: the runtime's
   * hooks, its middleware, the plugins' and the agent's, as the run itself had them
   */
  private async notifyRoutine(
    notification: RunNotification,
    scope: TriggerNotifyScope
  ): Promise<void> {
    const snapshot = this.pluginHost.snapshot();
    const pipeline = new MiddlewarePipeline([
      ...this.hooksMiddlewareLayers(snapshot),
      ...(this.config.middleware ?? []),
      ...snapshot.middleware,
      ...(scope.agent?.config.middleware ?? []),
    ]);
    const context: RunMiddlewareContext = {
      runId: scope.runId,
      agentId: scope.agent?.id ?? `routine:${scope.routineId}`,
      agentName: scope.agent?.name ?? scope.routineName,
      iteration: 0,
      signal: new AbortController().signal,
      state: new Map(),
      ...(scope.threadId !== undefined && { threadId: scope.threadId }),
      ...(scope.userId !== undefined && { userId: scope.userId }),
    };
    await pipeline.onNotification(notification, context);
  }

  /**
   * Experimental. The plugins of this runtime: list them, reload one (a new generation replaces
   * the old only once it loaded), enable or disable one, read what they add. The core's own plugin
   * (the built-in LLM providers) is always there, the rest come from `experimental_plugins` and
   * load before the first run
   */
  get experimental_plugins(): experimental_PluginHost {
    return this.pluginHost;
  }

  /** Waits for the plugins of `experimental_plugins` to load, once */
  private async pluginsReady(): Promise<PluginSnapshot> {
    if (this.config.experimental_plugins) await this.pluginHost.load();
    return this.pluginHost.snapshot();
  }

  /** The project root of the permission settings, else the working directory */
  private permissionRoot(): string {
    const settings = this.config.permissions?.settings;
    return resolvePath((typeof settings === 'object' ? settings.root : undefined) ?? process.cwd());
  }

  /**
   * Where the plugins' settings files are read, see `PluginsConfig.settings`: by default (and with
   * `true`) the places of `permissions.settings`, whose `trusted: true` trusts its root for plugin
   * settings too. Undefined with `settings: false`
   */
  private pluginSettings(): HookSettingsOptions | undefined {
    const own = this.config.experimental_plugins?.settings ?? true;
    if (own === false) return undefined;
    const permission = this.config.permissions?.settings;
    const shared = typeof permission === 'object' ? permission : undefined;
    const inherited = shared?.trusted === true ? [shared.root ?? process.cwd()] : [];
    if (own === true) {
      const { trusted: _trusted, ...places } = shared ?? {};
      return { ...places, ...(inherited.length > 0 && { trustedRoots: inherited }) };
    }
    const roots = [...(own.trustedRoots ?? []), ...(own.trusted === undefined ? inherited : [])];
    return { ...own, ...(roots.length > 0 && { trustedRoots: roots }) };
  }

  /** Forgets the backends built from a plugin's provider that changed, so the next call builds it anew */
  private forgetPluginBackends(): void {
    const backends = this.pluginHost.snapshot().backends;
    for (const [name, plugin] of this.backendPlugins) {
      if (backends.get(name) === plugin) continue;
      this.backendPlugins.delete(name);
      this.backends.delete(name);
      this.turnBackends.delete(name);
    }
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
  ): RunHandle & Required<Pick<RunHandle, 'setPermissionMode'>> {
    return this.startWith(agent, options);
  }

  /** A run's handle, as `start()` gives it: also of a recovered run, its queue holding `queued` */
  private startWith(
    agent: Agent,
    options: StartOptions,
    resumeFrom?: ResumeFrom,
    queued: readonly DurableQueuedMessage[] = []
  ): RunHandle & Required<Pick<RunHandle, 'setPermissionMode'>> {
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
    for (const item of queued) queue.push(item.kind, item.content, item.id);
    const result = this.launch(agent, { ...runOptions, signal }, resumeFrom, queue, modes).finally(
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
      get permissionMode(): PermissionMode | undefined {
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
    const resumed = resumeLaunch(target, options);
    return this.launch(agent, resumed.options, resumed.from);
  }

  /**
   * {@link resume} with a handle, as {@link start} gives one: the resumed run takes steering,
   * follow-up and injected messages while it goes on, and stops with `abort()`. The handle's
   * `result` is what `resume()` returns.
   *
   * @throws CogitatorError (`VALIDATION_ERROR`) at once for a checkpoint `resume()` refuses: a
   * durable run left running, or an unsupported checkpoint version
   *
   * @example
   * ```ts
   * const handle = cog.startResume(agent, threadId, { defaultDecision: { approved: true } });
   * handle.steer('Use the staging database');
   * const result = await handle.result;
   * ```
   */
  startResume<TDeps = unknown>(
    agent: Agent<TDeps>,
    target: RunCheckpoint | string,
    ...[options = {}]: StartResumeArgs<TDeps>
  ): RunHandle & Required<Pick<RunHandle, 'setPermissionMode'>> {
    const { queue, onRefusedMessage, ...rest } = options;
    const resumed = resumeLaunch(target, rest);
    return this.startWith(
      agent,
      {
        ...resumed.options,
        ...(queue && { queue }),
        ...(onRefusedMessage && { onRefusedMessage }),
      },
      resumed.from
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
    const lease = this.pluginHost.lease();
    try {
      return await this.invokeToolIn(lease.snapshot, tool, args, options);
    } finally {
      lease.release();
    }
  }

  /** {@link invokeTool} with the plugins of `snapshot`, which the call holds while it runs */
  private async invokeToolIn<TParams, TResult, TDeps>(
    snapshot: PluginSnapshot,
    tool: Tool<TParams, TResult, TDeps>,
    args: unknown,
    options: ToolInvocationOptions & { deps?: TDeps }
  ): Promise<ToolInvocationResult> {
    let toolCall: ToolCall = {
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
    /** The decision recorded last for the call: what `result.permission` reports */
    let lastDecision: PermissionDecision | undefined;
    const permissions = await RunPermissions.create({
      service: permissionService,
      threadId: options.threadId ?? `invoke_${toolCall.id}`,
      runtime: { options: this.config.permissions, origin: 'runtime' },
      agent: { options: agent?.config.permissions, origin: `agent:${agent?.name ?? agentId}` },
      run: options.permissions,
      root: resolvePath(
        permissionService.settingsOptions?.root ?? workspace?.root ?? process.cwd()
      ),
      record: async (event) => {
        lastDecision = {
          decision: event.decision,
          reason: event.reason,
          ...(event.rule && { rule: event.rule }),
          decidedBy: event.decidedBy,
          mode: event.mode,
        };
        notify('onPermissionDecision', () => options.onPermissionDecision?.(event));
      },
    });
    const baseTool: Tool = tool;
    let reported: PermissionDecision | undefined;
    const withPermission = (result: ToolInvocationResult): ToolInvocationResult => {
      const permission = lastDecision ?? reported;
      return permissions.active && permission ? { ...result, permission } : result;
    };
    const runId = options.runId ?? `run_${nanoid(12)}`;
    const middleware = new MiddlewarePipeline([
      ...this.hooksMiddlewareLayers(snapshot),
      ...(this.config.middleware ?? []),
      ...snapshot.middleware,
      ...(agent?.config.middleware ?? []),
      ...this.builtinMiddleware(),
    ]);
    const middlewareContext: RunMiddlewareContext = {
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
      ...(workspace && { workspace }),
      ...(permissions.active && { permissionMode: permissions.mode }),
    };
    const hooked = middleware.checksToolCalls
      ? await middleware.beforeToolCall(
          { toolCall, tool: baseTool, resumed: false },
          middlewareContext
        )
      : undefined;
    const refusedByHook = async (reason: string): Promise<ToolInvocationResult> => {
      await permissions.record({
        toolCallId: toolCall.id,
        toolName: tool.name,
        decision: 'deny',
        decidedBy: 'hook',
        mode: permissions.mode,
        reason,
      });
      return withPermission({
        callId: toolCall.id,
        name: tool.name,
        result: null,
        error: `Permission denied: ${reason}`,
        errorCode: 'PERMISSION_DENIED',
      });
    };
    if (hooked?.decision === 'deny') {
      return refusedByHook(hooked.reason ?? 'a hook refused the call');
    }
    if (hooked?.updatedArguments) {
      const parsed =
        typeof baseTool.parameters.safeParse === 'function'
          ? baseTool.parameters.safeParse(hooked.updatedArguments)
          : undefined;
      if (parsed && !parsed.success) {
        return refusedByHook(
          `the arguments a hook changed the call to do not match the tool's schema: ${parsed.error.message}`
        );
      }
      toolCall = { ...toolCall, arguments: hooked.updatedArguments };
    }
    const permissionCall: PermissionCall = {
      toolCallId: toolCall.id,
      ...(hooked?.decision === 'allow' && { allowedByHook: true }),
      needsApproval:
        needsApproval(baseTool, toolCall.arguments) ||
        constitutionalAI?.toolNeedsApproval(baseTool, toolCall.arguments) === true,
      ...(workspace && { workspace }),
      classifierInput: () => ({
        toolName: tool.name,
        description: tool.description,
        arguments: toolCall.arguments,
        request: 'A direct call of the tool by the application, outside an agent run',
        transcript: [],
        ...(signal && { signal }),
      }),
    };
    const verdict = hookedVerdict(
      await permissions.decide(baseTool, toolCall.arguments, permissionCall),
      hooked
    );
    reported = verdict;
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
    let personApproved = verdict.decision === 'allow' && verdict.decidedBy === 'hook';
    let changedJudged = false;
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
      const deciding =
        hooked?.decision === 'defer'
          ? Promise.resolve('pause' as const)
          : this.decideApproval(request, options.onApproval, {
              pipeline: middleware,
              context: middlewareContext,
              tool: baseTool,
            });
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
      const answer = answeredBy(this.hookDecisions.has(decision), decision);
      if (!decision.approved) {
        await permissions.record({ ...event(verdict), decision: 'deny', ...answer });
        return withPermission({
          callId: toolCall.id,
          name: tool.name,
          result: null,
          error: declinedError(this.hookDecisions.has(decision), decision.reason),
        });
      }
      let answered: PermissionDecisionEvent = {
        ...event(verdict),
        decision: 'allow',
        ...answer,
      };
      const updated = this.acceptedUpdate(decision, permissions);
      if (updated) {
        const checked = await this.checkUpdatedArguments(baseTool, updated, permissions, {
          ...permissionCall,
          needsApproval: false,
        });
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
      personApproved = true;
    }

    const registry = new ToolRegistry();
    registry.register(tool);
    let changedRequest: ToolApprovalRequest | undefined;
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
        ...(permissions.view(workspace) && { permissions: permissions.view(workspace) }),
      },
      approved: approvedByUser,
      allowNativeFallback: this.config.sandbox?.allowNativeFallback !== false,
      ...(constitutionalAI && { guardrails: constitutionalAI }),
      ...(permissions.active && {
        permit: async (changedTool: Tool, changedArgs: Record<string, unknown>) => {
          const changed = { ...toolCall, arguments: changedArgs };
          const outcome = await this.permitChangedArguments({
            tool: changedTool,
            toolCall: changed,
            permissions,
            call: {
              ...permissionCall,
              needsApproval:
                needsApproval(changedTool, changedArgs) ||
                constitutionalAI?.toolNeedsApproval(changedTool, changedArgs) === true,
              classifierInput: () => ({
                toolName: tool.name,
                description: tool.description,
                arguments: changedArgs,
                request: 'A direct call of the tool by the application, outside an agent run',
                transcript: [],
                ...(signal && { signal }),
              }),
            },
            request: {
              ...((options.agentId !== undefined || agent) && { agentId }),
              ...(options.threadId !== undefined && { threadId: options.threadId }),
              ...(options.userId !== undefined && { userId: options.userId }),
            },
            decide: (request) => {
              const deciding = this.decideApproval(request, options.onApproval, {
                pipeline: middleware,
                context: middlewareContext,
                tool: changedTool,
              });
              return signal ? waitForAbortable(deciding, signal) : deciding;
            },
          });
          if (!('pause' in outcome)) {
            if (outcome.allowed && outcome.byPerson) personApproved = true;
            if (outcome.allowed && outcome.byClassifier) changedJudged = true;
            return outcome;
          }
          changedRequest = outcome.pause;
          return {
            allowed: false,
            reason: `the arguments a middleware changed the call to need approval, and nobody approved them`,
          };
        },
        recheck: (finalTool: Tool, finalArgs: Record<string, unknown>) =>
          this.finalCheck({
            tool: finalTool,
            toolCall,
            args: finalArgs,
            permissions,
            call: {
              ...permissionCall,
              needsApproval:
                !personApproved &&
                (needsApproval(finalTool, finalArgs) ||
                  constitutionalAI?.toolNeedsApproval(finalTool, finalArgs) === true),
              classifierInput: () => ({
                toolName: tool.name,
                description: tool.description,
                arguments: finalArgs,
                request: 'A direct call of the tool by the application, outside an agent run',
                transcript: [],
                ...(signal && { signal }),
              }),
            },
            human: personApproved,
            judged: verdict.decidedBy === 'classifier' || changedJudged,
          }),
      }),
      ...(options.onUpdate && {
        onUpdate: (progress: ToolProgress) =>
          options.onUpdate?.({ ...progress, callId: toolCall.id, name: tool.name }),
      }),
      middleware,
      context: middlewareContext,
    });
    return withPermission(
      changedRequest && result.errorCode === 'PERMISSION_DENIED'
        ? { ...result, pendingApproval: changedRequest }
        : result
    );
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
    const subagents = this.subagentService ? [this.subagentService.middleware] : [];
    return [...subagents, ...this.otherBuiltinMiddleware()];
  }

  private otherBuiltinMiddleware(): RunMiddleware[] {
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
          notices: this.compactionNotices(),
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
      ...(contextManager ? [compactionMiddleware(contextManager, this.compactionNotices())] : []),
      ...(this.memoryExtractionLayer ? [this.memoryExtractionLayer] : []),
      ...(this.memoryCompactionLayer ? [this.memoryCompactionLayer] : []),
      ...(this.memoryUpkeepLayer ? [this.memoryUpkeepLayer] : []),
      ...(this.memoryBriefLayer ? [this.memoryBriefLayer] : []),
    ];
  }

  /**
   * How the runtime's compactions ask the run's middleware first (`beforeCompaction`) and tell them
   * after (`afterCompaction`): the middleware of the run named by the context's `runId`
   */
  private compactionNotices(): CompactionNotices {
    return {
      before: async (context, event) => {
        const run = this.runPipelines.get(context.runId)?.();
        if (!run) return { skip: false };
        const decided = await run.pipeline.beforeCompaction(event, run.context);
        return decided.skip
          ? { skip: true, ...(decided.reason !== undefined && { reason: decided.reason }) }
          : { skip: false };
      },
      after: async (context, event) => {
        const run = this.runPipelines.get(context.runId)?.();
        if (run) await run.pipeline.afterCompaction(event, run.context);
      },
    };
  }

  /**
   * The middleware the hooks of `hooks` become, outermost in every run: the hooks in code and
   * those of the settings files, read where the permission settings are read unless `hooks.settings`
   * names other places, a project's own only once it is trusted. None without `hooks`
   */
  private hooksMiddlewareLayers(snapshot: PluginSnapshot): RunMiddleware[] {
    const plugins = this.pluginHooksLayers(snapshot);
    const hooks = this.config.hooks;
    if (!hooks) return plugins;
    const settings = this.hookSettings();
    this.hooksLayer ??= hooksMiddleware(hooks, {
      ...(settings && { settings }),
      ...(this.config.llm?.defaultModel !== undefined && {
        defaultModel: this.config.llm.defaultModel,
      }),
      ask: this.hookAsker(),
    });
    return [this.hooksLayer, ...plugins];
  }

  /**
   * The middleware of the hooks plugins registered, one per hook set, after the runtime's own: each
   * runs only its plugin's hooks, with the plugin's variables in their environment, while the
   * settings files still decide whether hooks may run at all (`disableAllHooks`,
   * `allowManagedHooksOnly`), as for a subagent's frontmatter hooks
   */
  private pluginHooksLayers(snapshot: PluginSnapshot): RunMiddleware[] {
    const sets = snapshot.hooks;
    if (sets.length === 0) return [];
    let layers = this.pluginHookLayers.get(snapshot);
    if (!layers) {
      layers = new WeakMap();
      this.pluginHookLayers.set(snapshot, layers);
    }
    const cache = layers;
    return sets.map((set) => {
      let layer = cache.get(set);
      if (!layer) {
        const { deps, config } = this.frontmatterHookSetup();
        layer = hooksMiddleware(
          { ...config, mcp: this.pluginHookMcp(config.mcp, snapshot) },
          {
            ...deps,
            scoped: {
              hooks: set.hooks,
              layer: set.layer,
              source: `${set.plugin} ${set.source}`,
              env: set.env,
            },
          }
        );
        cache.set(set, layer);
      }
      return layer;
    });
  }

  /**
   * Calls the MCP tools of `mcp_tool` hooks: a tool of a plugin's own MCP server (named
   * `plugin:<plugin>:<server>`) of `snapshot` (the generations the run holds) directly, any other
   * through `hooks.mcp`
   */
  private pluginHookMcp(
    fallback: HookMcpCaller | undefined,
    snapshot: PluginSnapshot
  ): HookMcpCaller {
    return {
      callTool: async (server, name, input, signal) => {
        const found = snapshot.tools.find(
          (candidate) => candidate.mcp?.server === server && candidate.mcp?.tool === name
        );
        if (!found) {
          if (fallback) return fallback.callTool(server, name, input, signal);
          return { text: `No MCP tool ${name} of server ${server} is loaded`, isError: true };
        }
        try {
          const result = await found.execute(input, { agentId: 'hook', runId: 'hook', signal });
          return { text: typeof result === 'string' ? result : JSON.stringify(result) };
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    };
  }

  /**
   * What the hooks of a subagent's frontmatter run with: the places `hooks.settings` reads (only
   * the managed files without it), so the managed `disableAllHooks` and `allowManagedHooksOnly`
   * hold for them, and the HTTP allowlists, environment and limits of `hooks`
   */
  private frontmatterHookSetup(): {
    deps: HooksMiddlewareDeps;
    config: Omit<HooksConfig, 'hooks' | 'settings'>;
  } {
    const permission = this.config.permissions?.settings;
    const shared = typeof permission === 'object' ? permission : undefined;
    const settings: HookSettingsOptions = this.hookSettings() ?? {
      layers: ['managed'],
      ...(shared?.managedDirs !== undefined && { managedDirs: shared.managedDirs }),
    };
    const { hooks: _hooks, settings: _settings, ...config } = this.config.hooks ?? {};
    return {
      deps: {
        settings,
        ask: this.hookAsker(),
        ...(this.config.llm?.defaultModel !== undefined && {
          defaultModel: this.config.llm.defaultModel,
        }),
      },
      config,
    };
  }

  /**
   * Why a subagent may not run on `model`: a cost limit applies to the run that delegates or a run
   * above it (the runtime's, the run's or the agent's budget, a cost routing budget) and no price
   * is known for the model, so its calls would count as nothing against it
   */
  private unpricedUnderBudget(model: string | undefined): string | undefined {
    const limited = currentToolRuns().some((runId) => {
      const run = this.runBudgets.get(runId);
      return run?.budget.limitsCost(run.agentId()) === true;
    });
    if (!limited) return undefined;
    const full = model ?? this.config.llm?.defaultModel;
    if (full === undefined || this.pricer.pricing(full)) return undefined;
    return `no price is known for ${full}, so the cost budget could not count its calls: set its price in llm.pricing`;
  }

  /** Asks a model for `prompt` hooks, charging the run the hook runs in */
  private hookAsker(): HookModelAsker {
    return async ({ model, system, prompt, signal, runSignal }) => {
      const { backend, model: name } = this.route(model);
      const response = await backend.chat({
        model: name,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        signal,
      });
      this.classifierCharges.get(runSignal)?.(response.usage, model);
      return response.content;
    };
  }

  /**
   * Where the hooks' settings files are read, see `HooksConfig.settings`: `true` takes the places
   * of `permissions.settings`, and a `permissions.settings.trusted: true` trusts its root (the
   * process's working directory without one) for hooks too, that root only
   */
  private hookSettings(): HookSettingsOptions | undefined {
    const own = this.config.hooks?.settings;
    if (own === undefined || own === false) return undefined;
    const permission = this.config.permissions?.settings;
    const shared = typeof permission === 'object' ? permission : undefined;
    const inherited = shared?.trusted === true ? [shared.root ?? process.cwd()] : [];
    if (own === true) {
      const { trusted: _trusted, ...places } = shared ?? {};
      return { ...places, ...(inherited.length > 0 && { trustedRoots: inherited }) };
    }
    const roots = [...(own.trustedRoots ?? []), ...(own.trusted === undefined ? inherited : [])];
    return { ...own, ...(roots.length > 0 && { trustedRoots: roots }) };
  }

  /** The project instruction files runs read, see `InstructionsConfig.projectFiles` */
  private projectInstructions(): ProjectInstructionsOptions | undefined {
    const files = this.config.instructions?.projectFiles;
    if (files === undefined || files === false) return undefined;
    return files === true ? {} : files;
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
    let command: ExpandedCommand | undefined;
    await this.pluginsReady();
    if (!resumeFrom) {
      const expanded = await this.expandCommandInput(agent, options);
      if (expanded) ({ agent, options, command } = expanded);
    } else {
      let checkpoint = resumeFrom.checkpoint;
      if (!checkpoint && options.threadId !== undefined) {
        await this.getMemory();
        checkpoint = (await this.runCheckpointStore().load(options.threadId)) ?? undefined;
      }
      if (checkpoint?.command) {
        command = checkpoint.command;
        ({ agent, options } = this.applyCommand(agent, options, command));
        resumeFrom = { ...resumeFrom, checkpoint };
      }
    }
    const threadId = options.threadId;
    const aside =
      options.branch?.activate === false || resumeFrom?.checkpoint?.branch?.activate === false;
    if (threadId === undefined || aside) {
      return this.execute(agent, options, resumeFrom, {
        queue,
        modes,
        ...(command && { command }),
      });
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
        ...(command && { command }),
      });
    } finally {
      admission.release();
    }
  }

  /**
   * The run an input naming a command (`/review src/app.ts`) becomes: the input replaced by the
   * command's expanded template, its `allowed-tools` allowed for the run (when the run has
   * permissions set up, without them nothing asks but tools that need approval) and its model
   * used. Undefined without `commands`, for an input that names no known command, and for a run
   * started from a tool call, which never expands commands
   */
  private async expandCommandInput(
    agent: Agent,
    options: RunOptions
  ): Promise<{ agent: Agent; options: RunOptions; command: ExpandedCommand } | undefined> {
    if (!this.commandFinder || currentToolRuns().length > 0) return undefined;
    const invocation = commandInvocation(options.input);
    if (!invocation) return undefined;
    const root = resolvePath(
      this.commandFiles?.root ??
        options.workspace?.root ??
        agent.config.workspace?.root ??
        process.cwd()
    );
    const workspace = options.workspace ?? agent.config.workspace;
    const catalog = await this.commandFinder.catalog(
      {
        ...(this.commandFiles && { options: this.commandFiles }),
        root,
        ...(workspace && { start: resolvePath(workspace.root, workspace.cwd) }),
      },
      options.signal
    );
    const definition = catalog.get(invocation.name);
    if (!definition) return undefined;
    const input = expandCommand(definition, invocation.arguments, {
      CLAUDE_PROJECT_DIR: root,
      COGITATOR_PROJECT_DIR: root,
      ...(options.threadId !== undefined && { CLAUDE_SESSION_ID: options.threadId }),
    });
    const command: ExpandedCommand = {
      name: definition.name,
      arguments: invocation.arguments,
      input,
      ...(definition.allowedTools && { allowedTools: definition.allowedTools }),
      ...(definition.disallowedTools && { disallowedTools: definition.disallowedTools }),
      ...(definition.model !== undefined && { model: definition.model }),
      ...(definition.effort !== undefined && { effort: definition.effort }),
      source: definition.source,
      ...(definition.path !== undefined && { path: definition.path }),
      ...(definition.plugin !== undefined && { plugin: definition.plugin }),
    };
    const applied = this.applyCommand(agent, { ...options, input }, command);
    return { ...applied, command };
  }

  /**
   * The agent and options of a run `command` started, for its first run and when it resumes: its
   * model (on its own provider) and effort, its `disallowed-tools` taken from the agent's tools,
   * and its `allowed-tools` added to the run's allow rules when permissions are set up
   */
  private applyCommand(
    agent: Agent,
    options: RunOptions,
    command: ExpandedCommand
  ): { agent: Agent; options: RunOptions } {
    const permitted =
      command.allowedTools !== undefined &&
      command.allowedTools.length > 0 &&
      (this.config.permissions !== undefined ||
        agent.config.permissions !== undefined ||
        options.permissions !== undefined);
    let runAgent = agent;
    const resolved = resolveDefinitionModel(command.model, this.config.llm?.modelAliases);
    if (resolved.warning) {
      getLogger().warn(`Command "/${command.name}": ${resolved.warning}`, {
        command: command.name,
      });
    }
    if (!resolved.inherit || command.effort !== undefined) {
      runAgent = agent.clone({
        id: agent.id,
        ...(!resolved.inherit && { model: resolved.model, provider: undefined }),
        ...(command.effort !== undefined && {
          reasoning: { ...agent.config.reasoning, effort: command.effort },
        }),
      });
      copyToolFilter(agent, runAgent);
    }
    if (command.disallowedTools && command.disallowedTools.length > 0) {
      if (runAgent === agent) runAgent = agent.clone({ id: agent.id });
      const above = toolFilterOf(agent);
      const policy = toolPolicy({ disallowedTools: command.disallowedTools });
      setToolFilter(
        runAgent,
        (candidate) => (above?.(candidate) ?? true) && (policy?.allows(candidate) ?? true)
      );
    }
    const allow = options.permissions?.allow ?? [];
    const missing = (command.allowedTools ?? []).filter((rule) => !allow.includes(rule));
    return {
      agent: runAgent,
      options: {
        ...options,
        ...(permitted &&
          missing.length > 0 && {
            permissions: { ...options.permissions, allow: [...allow, ...missing] },
          }),
      },
    };
  }

  /**
   * The commands a run's input may name for a project at `root` (default: the working directory
   * of the process), with the problems found in their files: for a client's `/` menu. Empty
   * without `commands`
   */
  async listCommands(
    options: { root?: string; signal?: AbortSignal } = {}
  ): Promise<CommandCatalog> {
    await this.pluginsReady();
    if (!this.commandFinder) return { commands: [], diagnostics: [], get: () => undefined };
    return this.commandFinder.catalog(
      {
        ...(this.commandFiles && { options: this.commandFiles }),
        root: resolvePath(options.root ?? this.commandFiles?.root ?? process.cwd()),
      },
      options.signal
    );
  }

  /**
   * The subagents runs may delegate to for a project at `root` (default: the root of
   * `subagents.files`, else the working directory of the process), with the problems found in
   * their files. Empty without `subagents`
   */
  async listSubagents(
    options: { root?: string; signal?: AbortSignal } = {}
  ): Promise<SubagentCatalog> {
    await this.pluginsReady();
    if (!this.subagentService) return { agents: [], diagnostics: [], get: () => undefined };
    return this.subagentService.catalogAt(options.root, options.signal);
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
    if (resumeFrom?.recovered) resumeFrom.recovered.entered = true;
    let prompt: RunPrompt | undefined;
    if (!checkpoint && options.runId !== undefined) assertRunId(options.runId);
    let runId = checkpoint?.runId ?? options.runId ?? `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const runMemory = new RunMemory(
      () => this.state.memoryAdapter,
      threadId,
      () => options
    );
    const durableConfig = this.durableConfig();
    const durable =
      resumeFrom?.recovered !== undefined ||
      ((options.durable ??
        agent.config.durable ??
        (durableConfig ? (durableConfig.enabled ?? true) : false)) &&
        currentToolRuns().filter((id) => id !== runId).length === 0);
    /** Names the entries this stretch of a durable run writes, see `RunMemory.tag` */
    const durableStretch = nanoid(8);
    const tagEntries = () => {
      if (durable) runMemory.tag(`${runId}/${durableStretch}`);
    };
    tagEntries();
    let keeper: DurableRunKeeper | undefined;
    /**
     * Set once the run got to its loop: an error from then on is an end of its own (a model or a
     * tool that failed, a cancel), one before it (its configuration, a recovery that gave up) is not
     */
    let loopReached = false;
    /** The durable run this execution holds in `durableRunsGoing` */
    let reservedRun = resumeFrom?.recovered ? checkpoint?.runId : undefined;
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
    let finishRun: () => void = () => undefined;
    const runDone = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    /** The run's place in the workspaces it works in, which file restores look at */
    let workspaceSeat: WorkspaceRegistration | undefined;
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
    let pluginLease: PluginLease | undefined;
    let budget: RunBudget | undefined;
    /** Set once a middleware asked to end the run, see `RunMiddlewareContext.stop` */
    let stopRequest: { reason: string; middleware: string } | undefined;
    /** Set once the run returned or threw: what middleware add then reaches no model call */
    let runEnded = false;
    /** Tells the run's middleware it failed (`afterRun`), once they exist */
    let endFailed: ((error: Error) => Promise<void>) | undefined;
    /** Model calls of hooks before the run's usage is counted (`startRun`, `beforeRun`), charged once it is */
    const earlyCharges: Array<{ usage: ChatResponse['usage']; model: string }> = [];
    options = this.withObservers(options, agent, () => runId);

    try {
      let resumedInterrupts: RunInterrupt[] = [];
      let answeredDecisions: Record<string, ToolApprovalDecision> = {};
      let answeredNow: RunInterrupt[] = [];
      releaseRunSlot = await this.acquireRunSlot(abortController.signal);
      throwIfAborted(abortController.signal);
      this.classifierCharges.set(abortController.signal, (usage, model) => {
        earlyCharges.push({ usage, model });
      });
      if (!checkpoint) {
        options.onRunStart?.({ runId, agentId: agent.id, input: options.input, threadId });
      }

      const agentModel = this.resolveModel(agent);
      await this.initializeAll(agentModel);
      pluginLease = this.pluginHost.lease();
      const pluginSnapshot = pluginLease.snapshot;

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
        tagEntries();
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
      if (durable) {
        if (!resumeFrom?.recovered) {
          if (this.durableRunsGoing.has(runId)) {
            throw new CogitatorError({
              message: `Durable run ${runId} is going on in this runtime already`,
              code: ErrorCode.RUN_LEASED,
              details: { runId },
            });
          }
          this.durableRunsGoing.add(runId);
          reservedRun = runId;
        }
        const store = this.durableStore();
        const owner = {
          runId,
          threadId,
          agentId: agent.id,
          agentName: agent.name,
          ...(options.userId !== undefined && { userId: options.userId }),
        };
        if (!checkpoint && options.runId !== undefined && (await store.load(owner))) {
          throw new CogitatorError({
            message: `A durable run ${runId} is kept already: recover it instead of starting it again`,
            code: ErrorCode.RUN_LEASED,
            details: { runId },
          });
        }
        keeper = new DurableRunKeeper(store, owner, this.durableHolder, {
          leaseMs: durableConfig?.leaseMs ?? DEFAULT_DURABLE_LEASE_MS,
          retries: durableConfig?.storeRetries ?? DEFAULT_STORE_RETRIES,
          onStoreError: durableConfig?.onStoreError ?? 'suspend',
          stop: (error) => {
            if (error.code === ErrorCode.RUN_LEASED) runMemory.seal();
            if (!abortController.signal.aborted) abortController.abort(error);
          },
        });
        await keeper.begin(await this.fencedEpoch(threadId, runId));
        runMemory.epoch(keeper.epoch);
        const recovered = resumeFrom?.recovered;
        if (recovered) {
          recovered.stopHolding();
          if ((await keeper.savedAt()) !== recovered.savedAt) {
            const moved = new CogitatorError({
              message: `Durable run ${runId} went on in another process while this one waited to recover it`,
              code: ErrorCode.RUN_LEASED,
              details: { runId },
            });
            await keeper.abandon(moved);
            throw moved;
          }
        }
        const watched = keeper;
        if (queue) queue.watch((pending) => watched.queued(withQueueIds(queue, pending)));
        runMemory.guard(() => watched.held());
      }
      prompt = checkpoint?.prompt;
      if (!checkpoint && (this.config.prompts || this.promptRegistry)) {
        const resolution = await this.prompts.resolve(agent, threadId);
        prompt = resolution.prompt;
        if (resolution.instructions !== agent.instructions) {
          const original = agent;
          agent = agent.clone({ id: agent.id, instructions: resolution.instructions });
          copyToolFilter(original, agent);
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
      const hookLayers = this.hooksMiddlewareLayers(pluginSnapshot);
      const pluginMiddleware = pluginSnapshot.middleware;
      const pipelineFor = (owner: Agent) =>
        new MiddlewarePipeline([
          ...hookLayers,
          ...(this.config.middleware ?? []),
          ...pluginMiddleware,
          ...(owner.config.middleware ?? []),
          ...(options.middleware ?? []),
          ...builtins,
        ]);
      let pipeline = pipelineFor(active);
      const middlewareState = new Map<string, unknown>();
      const workspaceOf = (owner: Agent): Workspace | undefined =>
        options.workspace ?? owner.config.workspace;
      workspaceSeat = await this.workspaceRuns.enter(
        {
          runId: () => runId,
          threadId,
          abort: (reason) => abortController.abort(reason),
          done: runDone,
        },
        workspaceOf(active),
        abortController.signal
      );
      if (currentToolRuns().filter((id) => id !== runId).length === 0) {
        runMemory.checkpoints(async (entryId) => {
          const settings = checkpointSettings(
            this.config.checkpoints,
            active.config.checkpoints,
            options.checkpoints
          );
          const workspace = workspaceOf(active);
          if (!settings || !workspace) return undefined;
          const ref = await takeFileCheckpoint(workspace, settings, { entryId, threadId, runId });
          return (
            ref && {
              ref,
              discard: async () => {
                await workspace.deleteSnapshot?.(ref.snapshotId).catch(() => undefined);
              },
            }
          );
        });
      }
      const parentRunId = currentToolRuns()
        .filter((id) => id !== runId)
        .at(-1);
      /** What middleware added for the next model call, see `RunMiddlewareContext.addContext` */
      const pendingContext: string[] = [];
      const stopRun = middlewareStop((reason, middleware) => {
        stopRequest ??= { reason, middleware };
      });
      let permissionsRef: RunPermissions | undefined;
      const middlewareContext = (): RunMiddlewareContext => ({
        ...(parentRunId !== undefined && { parentRunId }),
        ...(permissionsRef?.active && { permissionMode: permissionsRef.mode }),
        addContext: (text: string) => {
          if (!runEnded && text.trim() !== '') pendingContext.push(text);
        },
        stop: stopRun,
        logEvent: (event, note) => runMemory.event(active.id, { type: 'custom', event }, note),
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
      this.runPipelines.set(runId, () => ({ pipeline, context: middlewareContext() }));
      const instructionOptions = this.projectInstructions();
      const harness = new RunHarness({
        conversation: () => messages,
        registry: () => registry,
        workspaceOf,
        signal: abortController.signal,
        ...(instructionOptions && { instructions: instructionOptions }),
        ...(pluginSnapshot.skills.length > 0 && { skills: pluginSnapshot.skills }),
        onTodos: async (todos) => {
          reportTodos(todos);
          await this.keepTodos(threadId, todos, runMemory);
        },
      });
      middlewareState.set(PINNED_TOOL_OUTPUTS, harness.pinnedOutputs);
      await harness.prepare(active);
      const subagents = this.subagentService;
      const subagentDepth = currentToolRuns().filter((id) => id !== runId).length;
      let subagentCatalog = subagents
        ? await subagents.catalog(
            workspaceOf(active),
            abortController.signal,
            pluginSnapshot.agents
          )
        : undefined;
      const permissionService = this.permissionsOf();
      const permissionRootOf = (owner: Agent): string =>
        resolvePath(
          permissionService.settingsOptions?.root ?? workspaceOf(owner)?.root ?? process.cwd()
        );
      const permissions = await RunPermissions.create({
        service: permissionService,
        threadId,
        runtime: { options: this.config.permissions, origin: 'runtime' },
        agent: { options: active.config.permissions, origin: `agent:${active.name}` },
        run: options.permissions,
        ...(checkpoint?.permissions && { checkpoint: checkpoint.permissions }),
        root: permissionRootOf(active),
        record: async (event) => {
          notify('onPermissionDecision', () => options.onPermissionDecision?.(event));
          await runMemory.event(
            active.id,
            { type: 'approval', event: { ...event } },
            `${event.decision} ${event.toolName}: ${event.reason}`
          );
        },
      });
      permissionsRef = permissions;
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
      const planTool = exitPlanModeTool(permissions);
      permissions.allowInPlan(planTool);
      permissions.onModeChange((mode) => {
        if (mode === 'plan' && !registry.has(planTool.name)) registry.register(planTool);
      });
      const runToolFilter = toolFilterOf(agent);
      const runSwap = workspaceSwapOf(agent);
      const buildRegistry = (owner: Agent) => {
        const ownerRegistry = new ToolRegistry();
        const handoff = handoffTools(owner);
        const own = new Set([...owner.tools, ...handoff.tools].map((t) => t.name));
        ownerRegistry.registerMany(this.builtinTools(owner).filter((t) => !own.has(t.name)));
        ownerRegistry.registerMany(this.tools.getAll().filter((t) => !own.has(t.name)));
        ownerRegistry.registerMany(
          pluginSnapshot.tools.filter((t) => !own.has(t.name) && !this.tools.has(t.name))
        );
        ownerRegistry.registerMany(owner.tools);
        ownerRegistry.registerMany(handoff.tools);
        harness.addTools(owner, ownerRegistry);
        if (subagents && subagentCatalog) {
          const delegation = subagents.tools(
            {
              owner,
              runId,
              threadId,
              depth: subagentDepth,
              ...(workspaceOf(owner) && { workspace: workspaceOf(owner) }),
              catalog: subagentCatalog,
              tools: () => registry.getAll(),
            },
            (name) => ownerRegistry.has(name)
          );
          for (const delegating of delegation) {
            if (!ownerRegistry.has(delegating.name)) ownerRegistry.register(delegating);
          }
        }
        const swap = workspaceSwapOf(owner) ?? runSwap;
        if (swap) {
          for (const candidate of ownerRegistry.getAll()) {
            const rebound = swap.from
              .map((from) => reboundWorkspaceTool(candidate, from, swap.to))
              .find((made) => made !== undefined);
            if (rebound) ownerRegistry.register(rebound, { replace: true });
          }
        }
        const ownerFilter = toolFilterOf(owner);
        const filters = [
          ...(ownerFilter ? [ownerFilter] : []),
          ...(runToolFilter && runToolFilter !== ownerFilter ? [runToolFilter] : []),
        ];
        if (filters.length > 0) {
          const kept = ownerRegistry
            .getAll()
            .filter((candidate) => filters.every((keep) => keep(candidate)));
          ownerRegistry.clear();
          ownerRegistry.registerMany(kept);
        }
        if (permissions.active && !ownerRegistry.has(planTool.name)) {
          ownerRegistry.register(planTool);
        }
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

      endFailed = async (error) => {
        await pipeline.afterRun(
          {
            status: 'failed',
            error,
            model: this.pricedModel(effectiveModel, routeProvider),
            memoryAgentId: memoryAgentId(agent),
          },
          middlewareContext()
        );
      };
      if (checkpoint) {
        input = checkpoint.input;
        effectiveModel = checkpoint.model;
        routeProvider = checkpoint.provider;
        ({ backend, model } = this.turnRoute(effectiveModel, routeProvider, pluginSnapshot));
        messages = [...checkpoint.messages];
        if (checkpoint.instructions) harness.restoreInstructions(checkpoint.instructions);
        if (checkpoint.context) pendingContext.push(...checkpoint.context);
        if (pipeline.startsRuns) {
          const started = await waitForAbortable(
            pipeline.startRun(
              { source: 'resume', resumed: true, input, model: effectiveModel },
              middlewareContext()
            ),
            abortController.signal
          );
          const held = new Set(messages.map((message) => getTextContent(message.content)));
          afterSystemPrompt(
            messages,
            started.filter((text) => !held.has(text))
          );
        }
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
        ({ backend, model } = this.turnRoute(effectiveModel, routeProvider, pluginSnapshot));

        if (costRouter && this.config.limits?.onExceeded !== 'interrupt') {
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
        if (pipeline.startsRuns) await this.openForStart(threadId, options, runMemory);
        const started = pipeline.startsRuns
          ? await waitForAbortable(
              pipeline.startRun(
                {
                  source: await this.sessionSource(threadId, options),
                  resumed: false,
                  input,
                  model: effectiveModel,
                },
                middlewareContext()
              ),
              abortController.signal
            )
          : [];
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
        afterSystemPrompt(messages, started);
        if (harness.instructions.length > 0) {
          await runMemory.event(
            agent.id,
            {
              type: 'custom',
              event: {
                kind: 'instructions',
                files: harness.instructions.map((file) => ({ ...file })),
              },
            },
            `Read the project instructions of ${harness.instructions.map((file) => file.path).join(', ')}`
          );
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

      let candidates = this.modelCandidates(
        active,
        effectiveModel,
        routeProvider,
        { backend, model },
        pluginSnapshot
      );
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
      const keptBudget = withoutRaise(checkpoint?.budget?.limits);
      const ownBudget =
        keptBudget && options.budget
          ? mergeBudgets(keptBudget, options.budget)
          : (options.budget ?? keptBudget);
      const budgetConfig = mergeBudgets(this.config.budget, ownBudget);
      const anyAgentBudget = reachableAgents([agent, active]).some(
        (owner) => owner.config.budget !== undefined
      );
      const interruptLimits = this.config.limits?.onExceeded === 'interrupt';
      const maxTokensPerRun = this.config.limits?.maxTokensPerRun;
      const agentBudgets = new Map<string, BudgetLimits | undefined>([
        [budgetKey(agent), agent.config.budget],
        [budgetKey(active), active.config.budget],
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
          agentBudgets: anyAgentBudget,
          ...(options.budget && { explicit: options.budget }),
          ...(ownBudget && { ownLimits: withoutWarning(ownBudget) }),
        },
        budgetConfig.session || budgetConfig.agent || anyAgentBudget
          ? await this.sessionLedgerOf(threadId, options)
          : readSessionSpend(undefined),
        checkpoint?.budget
      );
      budget = runBudget;
      const budgetAncestors = currentToolRuns().filter((id) => id !== runId);
      this.runBudgets.set(runId, { budget: runBudget, agentId: () => budgetKey(active) });
      /** The budget a model call now would pass: the run's own, else one of the runs it serves */
      const budgetBeforeModel = (): BudgetUsage | undefined => {
        const spent = runBudget.runTotals();
        return (
          runBudget.beforeModel(
            budgetKey(active),
            Math.max(costMeter.total(costModel), spent.costUsd),
            Math.max(totalInputTokens + totalOutputTokens, spent.tokens)
          ) ??
          budgetAncestors
            .map((ancestor) => {
              const parent = this.runBudgets.get(ancestor);
              if (!parent) return undefined;
              const totals = parent.budget.runTotals();
              return parent.budget.beforeModel(parent.agentId(), totals.costUsd, totals.tokens);
            })
            .find((usage) => usage !== undefined)
        );
      };
      const charge = (usage: ChatResponse['usage'], model: string) => {
        const spentBefore = costMeter.total(costModel);
        costMeter.add(usage, model);
        const cost = costMeter.total(costModel) - spentBefore;
        const tokens = usage.inputTokens + usage.outputTokens;
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        cachedInputTokens += usage.cachedInputTokens ?? 0;
        cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        reasoningTokens += usage.reasoningTokens ?? 0;
        runBudget.noteModel(budgetKey(active), cost, tokens);
        for (const ancestor of budgetAncestors) {
          const parent = this.runBudgets.get(ancestor);
          parent?.budget.noteModel(parent.agentId(), cost, tokens);
        }
        if (usage.cost === undefined) this.pricer.noteUnpriced(model);
        this.state.costRouter?.recordCost({
          runId,
          agentId: agent.id,
          threadId,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost,
        });
      };
      this.classifierCharges.set(abortController.signal, charge);
      for (const early of earlyCharges.splice(0)) charge(early.usage, early.model);
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
      const limit = {
        reached: checkpoint?.closingTurn === true,
        closingTurn: checkpoint?.closingTurn === true,
      };
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
        const toModel = this.resolveModel(target);
        if (toModel !== effectiveModel) {
          const blocked = await waitForAbortable(
            pipeline.beforeModelSwitch(
              { from: effectiveModel, to: toModel, reason: 'handoff', agent: target.name },
              middlewareContext()
            ),
            abortController.signal
          );
          if (blocked) {
            const note: Message = {
              role: 'system',
              content: `The handoff to agent "${target.name}" did not happen: ${blocked.block}`,
            };
            messages.push(note);
            await runMemory.save(active.id, note, undefined, undefined, {
              context: 'beforeModelSwitch',
            });
            return;
          }
        }
        await harness.prepare(target);
        if (subagents && workspaceOf(target) !== workspaceOf(active)) {
          subagentCatalog = await subagents.catalog(
            workspaceOf(target),
            abortController.signal,
            pluginSnapshot.agents
          );
        }
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
        const targetWorkspace = workspaceOf(target);
        if (targetWorkspace) await workspaceSeat?.add(targetWorkspace);
        active = target;
        agentBudgets.set(budgetKey(target), target.config.budget);
        await permissions.switchAgent(
          { options: target.config.permissions, origin: `agent:${target.name}` },
          permissionRootOf(target)
        );
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
        ({ backend, model } = this.turnRoute(effectiveModel, routeProvider, pluginSnapshot));
        candidates = this.modelCandidates(
          target,
          effectiveModel,
          routeProvider,
          { backend, model },
          pluginSnapshot
        );
        reasoning = options.reasoning ?? target.config.reasoning;
        responseFormat = toLLMResponseFormat(target.config.responseFormat);
        lastToolCallSig = '';
      };

      /** The context the input checks add for a queued message, undefined when they refuse it */
      const passesChecks = async (
        item: QueuedRunMessage
      ): Promise<readonly string[] | undefined> => {
        try {
          return await waitForAbortable(
            pipeline.beforeRun(
              {
                input: getTextContent(item.content),
                messages: [...messages, { role: 'user', content: item.content }],
              },
              middlewareContext()
            ),
            abortController.signal
          );
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          queue?.refuse(item, error instanceof Error ? error : new Error(String(error)));
          return undefined;
        }
      };
      /** Delivers what passes the checks, and counts the steering and follow-up messages of it */
      const deliver = async (
        queued: readonly QueuedRunMessage[],
        stopsAt?: number
      ): Promise<number> => {
        let wakes = 0;
        for (const item of queued) {
          const queuedId = queue?.idOf(item);
          const extendsTo = item.kind !== 'inject' ? stopsAt : undefined;
          const added = await passesChecks(item);
          if (!added || !queue?.settle(item)) continue;
          const message: Message = { role: 'user', content: item.content };
          messages.push(message);
          if (item.kind !== 'inject') {
            wakes++;
            lastToolCallSig = '';
            stopContinued = false;
          }
          await runMemory.saveUser(active.id, message, {
            queued: item.kind,
            ...(keeper && queuedId !== undefined && { queuedId }),
            ...(keeper && extendsTo !== undefined && { iterationLimit: extendsTo }),
          });
          const notes: Message[] = [];
          for (const text of added) {
            const note: Message = { role: 'system', content: text };
            messages.push(note);
            notes.push(note);
            await runMemory.save(active.id, note, undefined, undefined, { context: 'beforeRun' });
          }
          await keeper?.delivered(
            { ...item, ...(queuedId !== undefined && { id: queuedId }) },
            [message, ...notes],
            extendsTo
          );
        }
        return wakes;
      };
      /** Saves what middleware added for the next model call, see `RunMiddlewareContext.addContext` */
      const flushContext = async (): Promise<void> => {
        if (pendingContext.length === 0) return;
        const note: Message = { role: 'system', content: pendingContext.splice(0).join('\n\n') };
        messages.push(note);
        await runMemory.save(active.id, note, undefined, undefined, { context: 'middleware' });
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
          permissionService.settingsOptions?.trusted === true
        ),
        classifierInput: () => ({
          toolName: tool.name,
          description: tool.description,
          arguments: toolCall.arguments,
          request: input,
          transcript: transcriptOf(messages, classifierTranscriptLength(this.config.permissions)),
          signal: abortController.signal,
        }),
        classifierBudget: budgetBeforeModel,
      });
      /** The approval request of a call the permissions decided to ask for */
      const approvalRequestOf = (
        tool: Tool,
        toolCall: ToolCall,
        verdict: PermissionDecision
      ): ToolApprovalRequest => {
        const suggestedRule = permissions.suggest(tool, toolCall.arguments, workspaceOf(active));
        return {
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
      };
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
          /** Calls the rules or the mode allowed, not a person */
          automatic?: readonly string[];
          /** Decisions a person gave with the resume, not before the pause */
          fresh?: readonly string[];
          /** Approvals asked for the arguments a middleware changed calls to */
          changed?: readonly ToolApprovalRequest[];
          /** Calls of `changed` asked for as they started */
          admitted?: readonly string[];
          /** What the calls that ran before the pause returned */
          results?: Record<
            string,
            { result: unknown; error?: string; arguments?: Record<string, unknown> }
          >;
          /** The paused delegates of calls of the turn, with what the resume answered them */
          children?: ReadonlyMap<string, DelegatedResume>;
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

        const decisions = new Map(Object.entries(resumed?.decisions ?? {}));
        const denied = new Map(Object.entries(resumed?.denied ?? {}));
        const fresh = new Set(resumed?.fresh ?? []);
        const runArguments = new Map<string, ToolCall>();
        const pending: ToolApprovalRequest[] = [];
        const automatic = new Set(resumed?.automatic ?? []);
        /** Calls of the turn the `auto` classifier allowed */
        const classified = new Set<string>();
        /** Approvals asked for the arguments a middleware changed calls to, which their decisions decide */
        const changedAsked = new Map(
          (resumed?.changed ?? []).map((request) => [request.toolCallId, request])
        );
        /** Approvals this turn asks for the arguments a middleware changed calls to */
        const changedRequests = new Map<string, ToolApprovalRequest>();
        /** Calls whose changed arguments a person approved */
        const answeredChanges = new Set<string>();
        /** Calls whose changed approval was asked for as they started, see `admit` */
        const admitted = new Set(resumed?.admitted ?? []);
        const keptChanged = (kept: (id: string) => boolean) => {
          const requests = new Map([...changedAsked, ...changedRequests]);
          const list = [...requests.values()].filter((request) => kept(request.toolCallId));
          const ids = list.map((request) => request.toolCallId).filter((id) => admitted.has(id));
          return list.length > 0 ? { changed: list, ...(ids.length > 0 && { admitted: ids }) } : {};
        };
        /** The decision, or the budget that classifying the call would pass */
        const decideOrStop = async (
          tool: Tool,
          args: Record<string, unknown>,
          call: PermissionCall
        ): Promise<PermissionDecision | { stop: BudgetUsage }> => {
          try {
            return await permissions.decide(tool, args, call);
          } catch (error) {
            if (error instanceof ClassifierBudgetReached) return { stop: error.usage };
            throw error;
          }
        };
        /** The turn paused at the budget a classification would pass, what it decided so far kept */
        const classifierPause = (usage: BudgetUsage): PausedTurn => {
          const automaticLeft = [...automatic].filter((id) => decisions.has(id));
          return {
            toolCalls,
            decisions: Object.fromEntries(
              [...decisions].map(([id, decision]) => [id, withoutRemember(decision)])
            ),
            ...(denied.size > 0 && { denied: Object.fromEntries(denied) }),
            ...(automaticLeft.length > 0 && { automatic: automaticLeft }),
            ...keptChanged((id) => open.some((call) => call.id === id)),
            pending: [],
            interrupts: [budgetInterrupt(usage, budgetConfig.allowRaise === true)],
            completed: [...done],
          };
        };
        const refuseByHook = async (toolCall: ToolCall, reason: string) => {
          denied.set(toolCall.id, reason);
          decisions.delete(toolCall.id);
          automatic.delete(toolCall.id);
          await permissions.record({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            decision: 'deny',
            decidedBy: 'hook',
            mode: permissions.mode,
            reason,
          });
        };
        /**
         * Records the answer an approval of a call got: the arguments it changes the call to, once
         * they pass the schema and the rules again, and the rule it asks to remember
         */
        const settle = async (toolCall: ToolCall, tool: Tool, decision: ToolApprovalDecision) => {
          const answered = fresh.has(toolCall.id);
          let event: PermissionDecisionEvent | undefined = answered
            ? {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                decision: decision.approved ? 'allow' : 'deny',
                mode: permissions.mode,
                ...answeredBy(this.hookDecisions.has(decision), decision),
              }
            : undefined;
          const updated = this.acceptedUpdate(decision, permissions);
          if (updated) {
            const checked = await this.checkUpdatedArguments(
              tool,
              updated,
              permissions,
              permissionCall(tool, { ...toolCall, arguments: updated }, false)
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
        };
        /**
         * With `beforeToolCall` middleware (the `PreToolUse` hooks among them), each call is
         * decided when it starts, after the calls before it in the step ran, see {@link admit}
         */
        const decidesAtStart = pipeline.checksToolCalls;
        if (!decidesAtStart && resumed && permissions.active) {
          for (const toolCall of open) {
            const kept = decisions.get(toolCall.id);
            const tool = registry.get(toolCall.name);
            if (!kept?.approved || !tool) continue;
            const byRules = automatic.has(toolCall.id) && !fresh.has(toolCall.id);
            const needs =
              byRules &&
              (needsApproval(tool, toolCall.arguments) ||
                this.state.constitutionalAI?.toolNeedsApproval(tool, toolCall.arguments) === true);
            const decide = (call: ToolCall) =>
              decideOrStop(tool, call.arguments, {
                ...permissionCall(tool, call, needs),
                ...(!byRules && permissions.mode === 'dontAsk' && { mode: 'default' as const }),
              });
            const changedTo = changedAsked.get(toolCall.id)?.arguments;
            const sent = await decide(toolCall);
            if ('stop' in sent) return classifierPause(sent.stop);
            const verdict =
              changedTo && sent.decision !== 'deny'
                ? await decide({ ...toolCall, arguments: changedTo })
                : sent;
            if ('stop' in verdict) return classifierPause(verdict.stop);
            if (verdict.decision === 'allow' || (verdict.decision === 'ask' && !byRules)) continue;
            decisions.delete(toolCall.id);
            automatic.delete(toolCall.id);
            if (verdict.decision === 'deny') {
              denied.set(toolCall.id, verdict.reason);
              await permissions.record(decisionEvent(toolCall, verdict));
            }
          }
        }
        for (const toolCall of decidesAtStart ? [] : open) {
          const tool = registry.get(toolCall.name);
          if (
            !tool ||
            toolCall.argumentsError !== undefined ||
            decisions.has(toolCall.id) ||
            denied.has(toolCall.id)
          ) {
            continue;
          }
          const changedRequest = changedAsked.get(toolCall.id);
          if (changedRequest) {
            const decision = resumed?.fallback
              ? forEveryCall(resumed.fallback)
              : await this.decideApproval(changedRequest, options.onApproval, {
                  pipeline,
                  context: middlewareContext(),
                  tool,
                  signal: abortController.signal,
                });
            if (decision === 'pause') {
              pending.push(changedRequest);
            } else {
              decisions.set(toolCall.id, decision);
              fresh.add(toolCall.id);
            }
            continue;
          }
          const needs =
            needsApproval(tool, toolCall.arguments) ||
            this.state.constitutionalAI?.toolNeedsApproval(tool, toolCall.arguments) === true;
          if (!needs && !permissions.active) continue;
          const verdict = await decideOrStop(
            tool,
            toolCall.arguments,
            permissionCall(tool, toolCall, needs)
          );
          if ('stop' in verdict) return classifierPause(verdict.stop);
          if (verdict.decision !== 'ask') {
            if (verdict.decision === 'deny') denied.set(toolCall.id, verdict.reason);
            else if (verdict.decidedBy !== 'default') {
              decisions.set(toolCall.id, { approved: true });
              automatic.add(toolCall.id);
              if (verdict.decidedBy === 'classifier') classified.add(toolCall.id);
            }
            await permissions.record(decisionEvent(toolCall, verdict));
            continue;
          }
          const request = approvalRequestOf(tool, toolCall, verdict);
          const decision = resumed?.fallback
            ? forEveryCall(resumed.fallback)
            : await this.decideApproval(request, options.onApproval, {
                pipeline,
                context: middlewareContext(),
                tool,
                signal: abortController.signal,
              });
          if (decision === 'pause') {
            pending.push(request);
          } else {
            decisions.set(toolCall.id, decision);
            fresh.add(toolCall.id);
          }
        }

        for (const toolCall of decidesAtStart ? [] : open) {
          const decision = decisions.get(toolCall.id);
          const tool = registry.get(toolCall.name);
          if (!decision || !tool) continue;
          const changedTo = changedAsked.get(toolCall.id)?.arguments;
          if (changedTo) {
            if (fresh.has(toolCall.id) && !decision.approved) {
              const changed = { ...toolCall, arguments: changedTo };
              await this.answerChangedArguments(
                tool,
                changed,
                decision,
                permissions,
                permissionCall(tool, changed, false)
              );
            }
            continue;
          }
          await settle(toolCall, tool, decision);
        }

        const keptAutomatic = () => {
          const ids = [...automatic].filter((id) => decisions.has(id));
          return ids.length > 0 ? { automatic: ids } : {};
        };
        const keptDecisions = () =>
          Object.fromEntries(
            [...decisions].map(([id, decision]) => [id, withoutRemember(decision)])
          );
        if (pending.length > 0) {
          return {
            toolCalls,
            decisions: keptDecisions(),
            ...(denied.size > 0 && { denied: Object.fromEntries(denied) }),
            ...keptAutomatic(),
            ...keptChanged((id) => open.some((call) => call.id === id)),
            pending,
            interrupts: pending.map(approvalInterrupt),
            completed: [...done],
          };
        }
        const runnable = (decidesAtStart ? [] : open).filter(
          (toolCall) =>
            registry.get(toolCall.name) !== undefined &&
            toolCall.argumentsError === undefined &&
            !denied.has(toolCall.id) &&
            decisions.get(toolCall.id)?.approved !== false &&
            !(resumed?.interrupts ?? []).some(
              (entry) =>
                entry.toolCallId === toolCall.id &&
                (entry.kind === 'input' || entry.kind === 'plan')
            )
        ).length;
        const toolBudget =
          runnable > 0 ? runBudget.beforeTools(budgetKey(active), runnable) : undefined;
        const callerBudget = budgetAncestors
          .map((ancestor) => {
            const parent = this.runBudgets.get(ancestor);
            return runnable > 0
              ? parent?.budget.beforeTools(parent.agentId(), runnable)
              : undefined;
          })
          .find((usage) => usage !== undefined);
        if (callerBudget && !toolBudget) {
          for (const toolCall of open) {
            if (!denied.has(toolCall.id) && decisions.get(toolCall.id)?.approved !== false) {
              denied.set(
                toolCall.id,
                `the run that started this one would pass its tool call budget (${callerBudget.used} of ${callerBudget.limit})`
              );
            }
          }
        }
        if (toolBudget) {
          return {
            toolCalls,
            decisions: keptDecisions(),
            ...(denied.size > 0 && { denied: Object.fromEntries(denied) }),
            ...keptAutomatic(),
            ...keptChanged((id) => open.some((call) => call.id === id)),
            pending: [],
            interrupts: [
              ...(resumed?.interrupts ?? []).filter(
                (entry) =>
                  (entry.kind !== 'budget' && entry.kind !== 'approval' && isAnswered(entry)) ||
                  (isNestedInterrupt(entry, resumed?.children) && !isAnswered(entry))
              ),
              budgetInterrupt(toolBudget, budgetConfig.allowRaise === true),
            ],
            completed: [...done],
            ...(resumed?.children &&
              resumed.children.size > 0 && {
                children: Object.fromEntries(
                  [...resumed.children].map(([id, child]) => [id, child.checkpoint])
                ),
              }),
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
        if (resumed && !runMemory.aside) {
          const store = this.runCheckpointStore();
          if ((await store.load(threadId))?.runId === runId) await store.delete(threadId);
        }

        /**
         * Decides the arguments a `wrapToolCall` middleware changed a call to: a deny refuses, an
         * ask takes a decision of its own, and pauses the run when nobody gives one. A decision
         * given for the approval asked for these arguments decides them
         */
        const permitChanged = async (
          toolCall: ToolCall,
          tool: Tool,
          args: Record<string, unknown>
        ): Promise<ChangedCallPermit> => {
          const changed = { ...toolCall, arguments: args };
          const needs =
            needsApproval(tool, args) ||
            this.state.constitutionalAI?.toolNeedsApproval(tool, args) === true;
          const call = permissionCall(tool, changed, needs);
          const asked = changedAsked.get(toolCall.id);
          const decision = decisions.get(toolCall.id);
          if (
            asked &&
            decision &&
            canonicalArguments(asked.arguments) === canonicalArguments(args)
          ) {
            const { classifierInput: _answered, ...answeredCall } = permissionCall(
              tool,
              changed,
              false
            );
            const verdict = await permissions.decide(tool, args, {
              ...answeredCall,
              ...(permissions.mode === 'dontAsk' && { mode: 'default' as const }),
            });
            if (verdict.decision === 'deny') {
              await permissions.record(decisionEvent(changed, verdict));
              return {
                allowed: false,
                reason: `the arguments a middleware changed the call to: ${verdict.reason}`,
              };
            }
            const answered = await this.answerChangedArguments(
              tool,
              changed,
              decision,
              permissions,
              call
            );
            if (answered.allowed) answeredChanges.add(toolCall.id);
            return answered;
          }
          const outcome = await this.permitChangedArguments({
            tool,
            toolCall: changed,
            permissions,
            call,
            request: {},
            decide: (request) =>
              this.decideApproval(request, options.onApproval, {
                pipeline,
                context: middlewareContext(),
                tool,
                signal: abortController.signal,
              }),
          });
          if (!('pause' in outcome)) {
            if (outcome.allowed && outcome.byPerson) answeredChanges.add(toolCall.id);
            if (outcome.allowed && outcome.byClassifier) classified.add(toolCall.id);
            return outcome;
          }
          changedRequests.set(toolCall.id, outcome.pause);
          throw new ToolInterruptSignal(approvalInterrupt(outcome.pause));
        };
        /**
         * Decides a call again right before it runs: the mode may have changed since the turn
         * decided it (`setPermissionMode()`), and an earlier call of the turn may have moved what
         * its paths point to (a symlink). Why it may not run, or undefined when it still may. A
         * call a person approved stops only at a deny or a mode that refuses it (`plan`), as an
         * approval answers an ask (`dontAsk` decides it as `default` would), one the rules allowed
         * also when it would now ask. A call the `auto` classifier allowed is not judged again
         * while the run stays in `auto` mode
         */
        const recheck = async (
          toolCall: ToolCall,
          args: Record<string, unknown>
        ): Promise<string | undefined> => {
          const tool = registry.get(toolCall.name);
          if (!permissions.active || !tool) return undefined;
          const runCall = { ...toolCall, arguments: args };
          const human =
            (decisions.get(toolCall.id)?.approved === true && !automatic.has(toolCall.id)) ||
            answeredChanges.has(toolCall.id);
          const needs =
            !human &&
            (needsApproval(tool, runCall.arguments) ||
              this.state.constitutionalAI?.toolNeedsApproval(tool, runCall.arguments) === true);
          return this.finalCheck({
            tool,
            toolCall,
            args,
            permissions,
            call: permissionCall(tool, runCall, needs),
            human,
            judged: classified.has(toolCall.id),
          });
        };

        let admitting: Promise<unknown> = Promise.resolve();
        /**
         * Decides a call as it starts, when the run has `beforeToolCall` middleware: the middleware
         * first (a deny refuses, new arguments must pass the schema), then the permissions with
         * what it said, then an approval when one is needed. An approval nobody gives pauses the
         * run at this call, with the arguments it was asked for, and an answer on resume holds only
         * for exactly those. Calls of a step are decided one after another
         */
        /**
         * The tool call budget for a call that will run, as it starts: a pause at the run's own
         * limit, a refusal at the limit of a run that started this one
         */
        const budgetAt = (toolCall: ToolCall): RunInterrupt | undefined => {
          if (denied.has(toolCall.id) || decisions.get(toolCall.id)?.approved === false) {
            return undefined;
          }
          if (!registry.get(toolCall.name) || toolCall.argumentsError !== undefined)
            return undefined;
          const own = runBudget.beforeTools(budgetKey(active), 1);
          if (own) return budgetInterrupt(own, budgetConfig.allowRaise === true);
          const caller = budgetAncestors
            .map((ancestor) => {
              const parent = this.runBudgets.get(ancestor);
              return parent?.budget.beforeTools(parent.agentId(), 1);
            })
            .find((usage) => usage !== undefined);
          if (caller) {
            denied.set(
              toolCall.id,
              `the run that started this one would pass its tool call budget (${caller.used} of ${caller.limit})`
            );
          }
          return undefined;
        };
        const admit = (toolCall: ToolCall): Promise<RunInterrupt | undefined> => {
          const next = admitting.then(async () => (await admitNow(toolCall)) ?? budgetAt(toolCall));
          admitting = next.catch(() => undefined);
          return next;
        };
        const admitNow = async (toolCall: ToolCall): Promise<RunInterrupt | undefined> => {
          const tool = registry.get(toolCall.name);
          if (!tool || toolCall.argumentsError !== undefined || denied.has(toolCall.id)) {
            return undefined;
          }
          const hooked = await waitForAbortable(
            pipeline.beforeToolCall(
              { toolCall, tool, resumed: resumed !== undefined },
              middlewareContext()
            ),
            abortController.signal
          );
          if (hooked?.decision === 'deny') {
            await refuseByHook(toolCall, hooked.reason ?? 'a hook refused the call');
            return undefined;
          }
          let call = toolCall;
          if (hooked?.updatedArguments) {
            const parsed =
              typeof tool.parameters.safeParse === 'function'
                ? tool.parameters.safeParse(hooked.updatedArguments)
                : undefined;
            if (parsed && !parsed.success) {
              await refuseByHook(
                toolCall,
                `the arguments a hook changed the call to do not match the tool's schema: ${parsed.error.message}`
              );
              return undefined;
            }
            call = { ...toolCall, arguments: hooked.updatedArguments };
            runArguments.set(toolCall.id, call);
          }
          const asked = changedAsked.get(toolCall.id);
          const answer = decisions.get(toolCall.id);
          const sameArguments =
            asked !== undefined &&
            canonicalArguments(asked.arguments) === canonicalArguments(call.arguments);
          if (asked && !admitted.has(toolCall.id) && answer && fresh.has(toolCall.id)) {
            return undefined;
          }
          if (asked) changedAsked.delete(toolCall.id);
          if (sameArguments && answer && fresh.has(toolCall.id) && hooked?.decision !== 'defer') {
            const again = await decideOrStop(tool, call.arguments, {
              ...permissionCall(tool, call, false),
              ...(permissions.mode === 'dontAsk' && { mode: 'default' as const }),
            });
            if ('stop' in again)
              return budgetInterrupt(again.stop, budgetConfig.allowRaise === true);
            if (again.decision === 'deny') {
              decisions.delete(toolCall.id);
              denied.set(toolCall.id, again.reason);
              await permissions.record(decisionEvent(toolCall, again));
              return undefined;
            }
            await settle(toolCall, tool, answer);
            return undefined;
          }
          if (
            answer?.approved === true &&
            askedBefore.some((entry) => entry.toolCallId === toolCall.id)
          ) {
            return undefined;
          }
          decisions.delete(toolCall.id);
          fresh.delete(toolCall.id);
          automatic.delete(toolCall.id);
          const needs =
            needsApproval(tool, call.arguments) ||
            this.state.constitutionalAI?.toolNeedsApproval(tool, call.arguments) === true;
          const hookAsks = hooked?.decision === 'ask' || hooked?.decision === 'defer';
          if (!needs && !permissions.active && !hookAsks) return undefined;
          const decided = await decideOrStop(tool, call.arguments, {
            ...permissionCall(tool, call, needs),
            ...(hooked?.decision === 'allow' && { allowedByHook: true }),
          });
          if ('stop' in decided) {
            return budgetInterrupt(decided.stop, budgetConfig.allowRaise === true);
          }
          const verdict = hookedVerdict(decided, hooked);
          if (verdict.decision !== 'ask') {
            if (verdict.decision === 'deny') denied.set(toolCall.id, verdict.reason);
            else if (verdict.decidedBy === 'hook') decisions.set(toolCall.id, { approved: true });
            else if (verdict.decidedBy !== 'default') {
              decisions.set(toolCall.id, { approved: true });
              automatic.add(toolCall.id);
              if (verdict.decidedBy === 'classifier') classified.add(toolCall.id);
            }
            await permissions.record(decisionEvent(toolCall, verdict));
            return undefined;
          }
          const request = approvalRequestOf(tool, call, verdict);
          if (hooked?.decision === 'defer' && !resumed?.fallback) {
            const deferred = { ...request, reason: hooked.reason ?? 'A hook deferred the call' };
            changedRequests.set(toolCall.id, deferred);
            admitted.add(toolCall.id);
            return approvalInterrupt(deferred);
          }
          const decision = resumed?.fallback
            ? forEveryCall(resumed.fallback)
            : await this.decideApproval(request, options.onApproval, {
                pipeline,
                context: middlewareContext(),
                tool,
                signal: abortController.signal,
              });
          if (decision === 'pause') {
            changedRequests.set(toolCall.id, request);
            admitted.add(toolCall.id);
            return approvalInterrupt(request);
          }
          decisions.set(toolCall.id, decision);
          fresh.add(toolCall.id);
          await settle(toolCall, tool, decision);
          return undefined;
        };

        const executeToolCall = async (toolCall: ToolCall): Promise<ToolOutcome> => {
          const toolSpanStart = Date.now();
          const toolSpanId = newSpanId();
          if (stopRequest) {
            return {
              toolCall,
              result: notStartedAtStop(toolCall),
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: toolSpanStart,
            };
          }
          if (decidesAtStart) {
            const waiting = await admit(toolCall);
            if (waiting) {
              return {
                toolCall,
                interrupt: waiting,
                toolSpanId,
                toolSpanStart,
                toolSpanEnd: toolSpanStart,
              };
            }
            if (stopRequest) {
              return {
                toolCall,
                result: notStartedAtStop(toolCall),
                toolSpanId,
                toolSpanStart,
                toolSpanEnd: toolSpanStart,
              };
            }
          }
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
              error: declinedError(this.hookDecisions.has(decision), decision.reason),
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
          /** The journal write of what the call was charged, awaited before the tool starts */
          let charging: Promise<void> | undefined;
          const dispatch = (): string | undefined => {
            if (askedBefore.some((entry) => entry.toolCallId === toolCall.id)) return undefined;
            if (resumed?.children?.has(toolCall.id)) return undefined;
            const parents = budgetAncestors.flatMap((ancestor) => {
              const parent = this.runBudgets.get(ancestor);
              return parent ? [parent] : [];
            });
            const spent =
              runBudget.beforeTools(budgetKey(active), 1) ??
              parents
                .map((parent) => parent.budget.beforeTools(parent.agentId(), 1))
                .find((usage) => usage !== undefined);
            if (spent) {
              return `The tool call budget is spent (${spent.scope} ${spent.used} of ${spent.limit}), the call did not run`;
            }
            runBudget.noteToolCalls(budgetKey(active), 1);
            if (runBudget.configured) charging = keeper?.charged(budgetKey(active), 1);
            for (const parent of parents) parent.budget.noteToolCalls(parent.agentId(), 1);
            return undefined;
          };
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
                    onStarted: (started) => workspaceSeat?.track(started),
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
                      ...(permissions.view(workspaceOf(active)) && {
                        permissions: permissions.view(workspaceOf(active)),
                      }),
                      delegation: {
                        conversation: () => messages,
                        ...(options.onApproval && { onApproval: options.onApproval }),
                        depth: budgetAncestors.length,
                        ...(options.onDelegatedRun && {
                          stream: delegatedStream(options.onDelegatedRun, {
                            parentToolCallId: toolCall.id,
                            parentRunId: runId,
                            depth: budgetAncestors.length + 1,
                          }),
                        }),
                        ...(resumed?.children?.has(toolCall.id) && {
                          resume: resumed.children.get(toolCall.id),
                        }),
                      },
                    },
                    approved: decision?.approved === true,
                    allowNativeFallback: this.config.sandbox?.allowNativeFallback !== false,
                    middleware: pipeline,
                    context: middlewareContext(),
                    ...(permissions.active && {
                      permit: (tool: Tool, args: Record<string, unknown>) =>
                        permitChanged(toolCall, tool, args),
                    }),
                    dispatch,
                    ...(keeper && {
                      dispatched: async () => {
                        await charging;
                      },
                    }),
                    stopped: () => stopRequest !== undefined,
                    ...(this.state.constitutionalAI && {
                      guardrails: this.state.constitutionalAI,
                    }),
                    ...(permissions.active && {
                      recheck: (_tool: Tool, args: Record<string, unknown>) =>
                        recheck(toolCall, args),
                    }),
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
            if (isDelegatePause(error) && !abortController.signal.aborted) {
              const interrupts = nestInterrupts(toolCall.id, error.agent, error.interrupts);
              const first = interrupts[0];
              if (first) {
                return {
                  toolCall,
                  interrupt: first,
                  nested: {
                    checkpoint: error.checkpoint,
                    interrupts,
                    pending: nestApprovals(toolCall.id, error.agent, error.pending),
                  },
                  toolSpanId,
                  toolSpanStart,
                  toolSpanEnd: Date.now(),
                };
              }
            }
            if (!isToolInterrupt(error) || abortController.signal.aborted) throw error;
            return {
              toolCall,
              interrupt: error.interrupt,
              toolSpanId,
              toolSpanStart,
              toolSpanEnd: Date.now(),
            };
          }
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
          await keeper?.started(toolCall.id);
          throwIfAborted(abortController.signal);
          dispatched.add(toolCall.id);
          const outcome = await executeToolCall(toolCall);
          if (outcome.result && !abortController.signal.aborted) {
            finished.set(toolCall.id, outcome.result);
            await keeper?.finished(toolCall.id, outcome.result);
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
          if (
            abortController.signal.aborted &&
            !(
              keeper &&
              (isSuspension(abortController.signal.reason) ||
                isLeaseLoss(abortController.signal.reason))
            )
          ) {
            await recordAbortedTurn();
          }
          throw error;
        }

        const reflectionMessages: Message[] = [];
        const asked: ToolOutcome[] = [];

        for (const outcome of outcomes) {
          const { toolCall, toolSpanId, toolSpanStart, toolSpanEnd } = outcome;
          const result = outcome.result ?? (stopRequest ? notStartedAtStop(toolCall) : undefined);
          if (!result) {
            asked.push(outcome);
            continue;
          }
          if (!outcome.result) finished.set(toolCall.id, result);
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
        const ran = outcomes.flatMap((outcome) => {
          const result = finished.get(outcome.toolCall.id) ?? outcome.result;
          if (!result) return [];
          return [{ toolCall: runArguments.get(outcome.toolCall.id) ?? outcome.toolCall, result }];
        });
        const reached = ran.flatMap(({ toolCall, result }) => {
          const tool = registry.get(toolCall.name);
          if (!tool || result.error !== undefined) return [];
          return touchedPaths(tool, (runArguments.get(toolCall.id) ?? toolCall).arguments);
        });
        if (reached.length > 0) {
          const brought = await harness.reach(active, reached, messages);
          if (brought) {
            pendingContext.push(brought.text);
            await runMemory.event(
              active.id,
              {
                type: 'custom',
                event: { kind: 'instructions', files: brought.files.map((file) => ({ ...file })) },
              },
              `Read the project instructions of ${brought.files.map((file) => file.path).join(', ')}`
            );
          }
        }
        if (asked.length > 0) {
          const ranIds = [...done, ...finished.keys()];
          const left = new Set(
            open.filter((call) => !finished.has(call.id)).map((call) => call.id)
          );
          const deniedLeft = [...denied].filter(([id]) => left.has(id));
          const keptLater = [...automatic].filter(
            (id) => left.has(id) && decisions.has(id) && !changedRequests.has(id)
          );
          return {
            toolCalls,
            decisions: Object.fromEntries(
              [...decisions]
                .filter(([id]) => left.has(id) && !changedRequests.has(id))
                .map(([id, decision]) => [id, withoutRemember(decision)])
            ),
            ...(deniedLeft.length > 0 && { denied: Object.fromEntries(deniedLeft) }),
            ...(keptLater.length > 0 && { automatic: keptLater }),
            ...keptChanged((id) => left.has(id)),
            pending: asked.flatMap((outcome) => {
              if (outcome.nested) return outcome.nested.pending;
              const request =
                outcome.interrupt?.kind === 'approval'
                  ? changedRequests.get(outcome.toolCall.id)
                  : undefined;
              return request ? [request] : [];
            }),
            interrupts: [
              ...new Map(
                [
                  ...askedBefore.filter(
                    (entry) =>
                      entry.toolCallId !== undefined &&
                      left.has(entry.toolCallId) &&
                      isAnswered(entry)
                  ),
                  ...asked.flatMap((outcome) =>
                    outcome.nested
                      ? outcome.nested.interrupts
                      : outcome.interrupt
                        ? [outcome.interrupt]
                        : []
                  ),
                ].map((entry) => [entry.id, entry])
              ).values(),
            ],
            completed: ranIds,
            ...(asked.some((outcome) => outcome.nested) && {
              children: Object.fromEntries(
                asked.flatMap((outcome) =>
                  outcome.nested ? [[outcome.toolCall.id, outcome.nested.checkpoint]] : []
                )
              ),
            }),
            results: {
              ...resumed?.results,
              ...Object.fromEntries(
                [...finished].map(([id, result]) => [
                  id,
                  {
                    result: result.result,
                    ...(result.error !== undefined && { error: result.error }),
                    ...(runArguments.has(id) && {
                      arguments: runArguments.get(id)?.arguments,
                    }),
                  },
                ])
              ),
            },
          };
        }
        if (stopRequest) return undefined;
        const batch = [
          ...toolCalls.flatMap((call) => {
            if (!done.has(call.id)) return [];
            const kept = resumed?.results?.[call.id];
            if (kept) {
              const result: ToolResult = {
                callId: call.id,
                name: call.name,
                result: kept.result,
                ...(kept.error !== undefined && { error: kept.error }),
              };
              const effective = kept.arguments ? { ...call, arguments: kept.arguments } : call;
              return [{ toolCall: effective, result }];
            }
            const message = messages.find(
              (entry) => entry.role === 'tool' && entry.toolCallId === call.id
            );
            return message ? [{ toolCall: call, result: resultOfMessage(call, message) }] : [];
          }),
          ...ran,
        ];
        if (batch.length > 0) {
          await waitForAbortable(
            pipeline.afterToolBatch({ calls: batch }, middlewareContext()),
            abortController.signal
          );
        }
        const handedOver = (call: ToolCall): boolean => {
          const result = finished.get(call.id);
          if (result) return result.error === undefined;
          if (!done.has(call.id)) return false;
          const message = messages.find(
            (entry) => entry.role === 'tool' && entry.toolCallId === call.id
          );
          return message !== undefined && !getTextContent(message.content).startsWith('{"error"');
        };
        const handoff = toolCalls.find((call) => handoffTargets.has(call.name) && handedOver(call));
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

      /** How many times in a row `beforeStop` kept the run going */
      let stopContinuations = checkpoint?.stopHooks?.continuations ?? 0;
      /** Whether `beforeStop` kept the run going since its last user message */
      let stopContinued = checkpoint?.stopHooks?.continued ?? false;

      /** Why the model's last turn ended, see `RunCheckpoint.finishReason` */
      let lastFinishReason: ChatResponse['finishReason'] | undefined = checkpoint?.finishReason;
      /** The run answered and has not settled what happens at its stop, see `RunCheckpoint.stopping` */
      let stopping = false;

      /** The run as a checkpoint, at `turn` and waiting on `interrupts` */
      const snapshot = (
        turn: RunCheckpoint['turn'],
        interrupts: RunInterrupt[] | undefined,
        running: boolean,
        calls: readonly ToolCall[] = allToolCalls
      ): RunCheckpoint => {
        const permissionState = permissions.state();
        const placement = runMemory.placement;
        const background = running ? (subagents?.backgroundOf(threadId, runId) ?? []) : [];
        return {
          version: 1,
          ...(running && { status: 'running' as const }),
          runId,
          agentId: active.id,
          threadId,
          ...(options.userId !== undefined && { userId: options.userId }),
          model: effectiveModel,
          ...(routeProvider !== undefined && { provider: routeProvider }),
          input,
          messages: restoreClearedOutputs(messages, middlewareState),
          ...(running &&
            queue &&
            queue.pending.length > 0 && { queued: withQueueIds(queue, queue.pending) }),
          ...(background.length > 0 && { background }),
          toolCalls: [...calls],
          ...(prompt && { prompt }),
          ...(active !== agent && { activeAgent: active.name }),
          ...(handoffs.length > 0 && { handoffs }),
          turn,
          ...(interrupts && { interrupts }),
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
          ...(running && placement && { branch: placement }),
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
          ...(harness.instructions.length > 0 && {
            instructions: harness.instructions.map((file) => ({ ...file })),
          }),
          ...(pendingContext.length > 0 && { context: [...pendingContext] }),
          ...(running && limit.closingTurn && { closingTurn: true as const }),
          ...(running && stopping && { stopping: true as const }),
          ...(running && lastFinishReason !== undefined && { finishReason: lastFinishReason }),
          ...((stopContinued || stopContinuations > 0) && {
            stopHooks: { continuations: stopContinuations, continued: stopContinued },
          }),
          ...(control.command && { command: control.command }),
        };
      };
      /** Saves a durable run's checkpoint after a step: at `turn` while its calls go on */
      const keepDurable = async (
        turn: RunCheckpoint['turn'] = { toolCalls: [], decisions: {} },
        calls?: readonly ToolCall[]
      ): Promise<void> => {
        if (!keeper) return;
        await runMemory.settled();
        await keeper.save(
          snapshot(turn, resumedInterrupts.length > 0 ? resumedInterrupts : undefined, true, calls),
          runMemory
        );
      };
      if (keeper && !checkpoint) await keepDurable();
      loopReached = true;

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
        } else if (resumeFrom.recovered) {
          subagents?.restoreLost(threadId, runId, checkpoint.background ?? []);
          for (const { toolCall, result } of resumeFrom.recovered.repairs) {
            options.onToolResult?.(result);
            const toolMessage = createToolMessage(
              toolCall,
              result,
              registry.get(toolCall.name)?.maxResultLength ??
                this.config.limits?.maxToolResultLength ??
                DEFAULT_TOOL_RESULT_MAX_LENGTH
            );
            messages.push(toolMessage);
            await runMemory.save(active.id, toolMessage, undefined, ...savedToolResult(result));
          }
          const turnCalls = checkpoint.turn.toolCalls;
          await keepDurable(
            turnCalls.length > 0 ? checkpoint.turn : undefined,
            checkpoint.toolCalls
          );
          if (turnCalls.length > 0) {
            pausedTurn = await handleToolTurn(turnCalls, {
              decisions: checkpoint.turn.decisions,
              interrupts: resumedInterrupts,
              completed: checkpoint.turn.completed ?? [],
              ...(checkpoint.turn.denied && { denied: checkpoint.turn.denied }),
              ...(checkpoint.turn.automatic && { automatic: checkpoint.turn.automatic }),
            });
            if (!pausedTurn) {
              reachedLimit();
              await keepDurable();
            }
          }
        } else {
          const children = new Map<string, DelegatedResume>(
            Object.entries(checkpoint.turn.children ?? {}).map(([callId, child]) => [
              callId,
              {
                checkpoint: child,
                decisions: answersUnder(callId, resumeFrom.decisions),
                responses: answersUnder(callId, resumeFrom.responses ?? {}),
                ...(resumeFrom.defaultDecision && { defaultDecision: resumeFrom.defaultDecision }),
              },
            ])
          );
          const ownDecisions = (all: Record<string, ToolApprovalDecision>) =>
            Object.fromEntries(
              Object.entries(all).filter(
                ([id]) => ![...children.keys()].some((callId) => id.startsWith(`${callId}/`))
              )
            );
          const answeredOwn = ownDecisions(answeredDecisions);
          const resumedOwn = ownDecisions(resumeFrom.decisions);
          if (keeper) {
            const fallback = resumeFrom.defaultDecision;
            const decided = {
              ...checkpoint.turn.decisions,
              ...answeredOwn,
              ...resumedOwn,
            };
            await keepDurable(
              {
                ...checkpoint.turn,
                decisions: {
                  ...(fallback &&
                    Object.fromEntries(
                      checkpoint.turn.toolCalls
                        .filter((call) => !(call.id in decided) && !children.has(call.id))
                        .map((call) => [call.id, withoutRemember(fallback)])
                    )),
                  ...decided,
                },
              },
              checkpoint.toolCalls
            );
          }
          pausedTurn = await handleToolTurn(checkpoint.turn.toolCalls, {
            decisions: {
              ...checkpoint.turn.decisions,
              ...answeredOwn,
              ...resumedOwn,
            },
            ...(children.size > 0 && { children }),
            fallback: resumeFrom.defaultDecision,
            interrupts: resumedInterrupts,
            ...(checkpoint.turn.completed && { completed: checkpoint.turn.completed }),
            ...(checkpoint.turn.denied && { denied: checkpoint.turn.denied }),
            ...(checkpoint.turn.automatic && { automatic: checkpoint.turn.automatic }),
            ...(checkpoint.turn.changed && { changed: checkpoint.turn.changed }),
            ...(checkpoint.turn.admitted && { admitted: checkpoint.turn.admitted }),
            ...(checkpoint.turn.results && { results: checkpoint.turn.results }),
            fresh: [...Object.keys(answeredOwn), ...Object.keys(resumedOwn)],
          });
          if (!pausedTurn) {
            reachedLimit();
            await keepDurable();
          }
        }
      }

      const streamsText = Boolean(options.stream && (options.onToken ?? options.onReasoning));
      const onToken = options.onToken ?? (() => undefined);
      let structuredRepaired = false;
      let emptyAnswerRetries = 0;

      let deliveredAtStop = false;
      /**
       * What the run does once the model answered: delivers what was queued for the stop, else
       * asks `beforeStop` (the `Stop` hooks) whether to go on. `stop` once nothing keeps it going
       */
      const atStop = async (output: string): Promise<'stop' | 'continue'> => {
        let delivered = 0;
        for (let next = queue?.takeAtStop() ?? []; next.length > 0 && delivered === 0;) {
          delivered = await deliver(next, iterations + maxIterations);
          if (delivered === 0) next = queue?.takeAtStop() ?? [];
        }
        if (delivered === 0) {
          const goOn =
            !limit.closingTurn && !stopRequest && iterations < iterationCap
              ? await waitForAbortable(
                  pipeline.beforeStop(
                    {
                      output,
                      continuations: stopContinuations,
                      continued: stopContinued,
                    },
                    middlewareContext()
                  ),
                  abortController.signal
                )
              : [];
          if (goOn.length === 0 || stopRequest) {
            stopping = false;
            await keepDurable();
            return 'stop';
          }
          stopping = false;
          stopContinuations++;
          stopContinued = true;
          const message: Message = { role: 'user', content: goOn.join('\n\n') };
          messages.push(message);
          await runMemory.save(active.id, message, undefined, undefined, {
            continued: 'beforeStop',
          });
          lastToolCallSig = '';
          emptyAnswerRetries = 0;
          structuredRepaired = false;
          return 'continue';
        }
        stopping = false;
        deliveredAtStop = true;
        iterationCap = iterations + maxIterations;
        limit.reached = false;
        limit.closingTurn = false;
        emptyAnswerRetries = 0;
        structuredRepaired = false;
        return 'continue';
      };
      let answeredBeforeStop = resumeFrom?.recovered?.answered === 'stopped';
      if (resumeFrom?.recovered?.answered === 'stopping') {
        stopping = true;
        const last = messages.filter((message) => message.role === 'assistant').pop();
        answeredBeforeStop = (await atStop(getTextContent(last?.content ?? ''))) === 'stop';
      }
      while (
        !answeredBeforeStop &&
        !pausedTurn &&
        !budgetStop &&
        (iterations < iterationCap || limit.closingTurn)
      ) {
        throwIfAborted(abortController.signal);
        if (stopRequest) break;
        const steering = queue?.takeForTurn(deliveredAtStop) ?? [];
        deliveredAtStop = false;
        if (steering.length > 0) await deliver(steering);
        if (stopRequest) break;
        if (!interruptLimits) {
          this.assertTokenBudget(totalInputTokens + totalOutputTokens);
          this.assertCostBudget(costMeter.total(costModel));
        }
        const spentWithDelegates = runBudget.runTotals();
        const reachedBudget = runBudget.beforeModel(
          budgetKey(active),
          Math.max(costMeter.total(costModel), spentWithDelegates.costUsd),
          Math.max(totalInputTokens + totalOutputTokens, spentWithDelegates.tokens)
        );
        const callerReached = budgetAncestors
          .map((ancestor) => {
            const parent = this.runBudgets.get(ancestor);
            if (!parent) return undefined;
            const totals = parent.budget.runTotals();
            return parent.budget.beforeModel(parent.agentId(), totals.costUsd, totals.tokens);
          })
          .find((usage) => usage !== undefined);
        if (callerReached && !reachedBudget) {
          budgetStop = callerReached;
          break;
        }
        if (reachedBudget) {
          pausedTurn = {
            toolCalls: [],
            decisions: {},
            pending: [],
            interrupts: [budgetInterrupt(reachedBudget, budgetConfig.allowRaise === true)],
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
        if (stopRequest) break;
        await flushContext();

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
            budgetKey(active),
            callCost,
            answer.usage.inputTokens + answer.usage.outputTokens
          );
          for (const ancestor of budgetAncestors) {
            const parent = this.runBudgets.get(ancestor);
            parent?.budget.noteModel(
              parent.agentId(),
              callCost,
              answer.usage.inputTokens + answer.usage.outputTokens
            );
          }
          runBudget.warn(
            budgetKey(active),
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
        const wantedToolChoice = limit.closingTurn
          ? 'none'
          : toolChoiceForTurn(requestedToolChoice, allToolCalls.length > 0, registry);
        const turnTools = harness
          .schemas(
            registry,
            messages,
            typeof wantedToolChoice === 'object' ? wantedToolChoice.function.name : undefined
          )
          .filter((schema) => {
            const offered = registry.get(schema.name);
            if (offered && permissions.hides(offered)) return false;
            return (
              schema.name !== EXIT_PLAN_MODE || offered !== planTool || permissions.mode === 'plan'
            );
          });
        const turnToolChoice = offeredToolChoice(wantedToolChoice, turnTools);

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
                        if (stopRequest) return stoppedTurn();
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
        if (stopRequest) {
          inputLedger.settle([]);
          if (!isStoppedTurn(response) && response.content.trim() !== '') {
            const said: Message = { role: 'assistant', content: response.content };
            messages.push(said);
            await runMemory.save(active.id, said);
          }
          break;
        }
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
          requestsTools ? response.toolCalls : undefined,
          undefined,
          keeper && {
            finishReason: response.finishReason,
            ...(runBudget.configured && { runBudget: runBudget.state() }),
            runUsage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedInputTokens,
              cacheWriteTokens,
              reasoningTokens,
              cost: costMeter.state(),
            } satisfies RunCheckpoint['usage'],
          }
        );
        shown.text = '';

        if (!requestsTools || !response.toolCalls) {
          stopping = true;
          await keepDurable();
          if ((await atStop(outputContent)) === 'stop') break;
          continue;
        }
        stopContinuations = 0;
        await keepDurable({ toolCalls: response.toolCalls, decisions: {} }, [
          ...allToolCalls,
          ...response.toolCalls,
        ]);
        pausedTurn = await handleToolTurn(response.toolCalls);
        runBudget.warn(
          budgetKey(active),
          costMeter.total(costModel),
          totalInputTokens + totalOutputTokens
        );
        if (pausedTurn) break;
        const atLimit = reachedLimit();
        await keepDurable();
        if (atLimit) break;
      }

      queue?.close();

      if (pausedTurn) {
        const pausedSpend = await this.keepSessionSpend(threadId, options, runBudget);
        const pausedCheckpoint = snapshot(
          {
            toolCalls: pausedTurn.toolCalls,
            decisions: pausedTurn.decisions,
            ...(pausedTurn.completed.length > 0 && { completed: pausedTurn.completed }),
            ...(pausedTurn.denied &&
              Object.keys(pausedTurn.denied).length > 0 && { denied: pausedTurn.denied }),
            ...(pausedTurn.automatic &&
              pausedTurn.automatic.length > 0 && { automatic: pausedTurn.automatic }),
            ...(pausedTurn.changed &&
              pausedTurn.changed.length > 0 && { changed: pausedTurn.changed }),
            ...(pausedTurn.admitted &&
              pausedTurn.admitted.length > 0 && { admitted: pausedTurn.admitted }),
            ...(pausedTurn.results &&
              Object.keys(pausedTurn.results).length > 0 && { results: pausedTurn.results }),
            ...(pausedTurn.children &&
              Object.keys(pausedTurn.children).length > 0 && { children: pausedTurn.children }),
          },
          pausedTurn.interrupts,
          false
        );
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
          ...(harness.instructions.length > 0 && { instructions: [...harness.instructions] }),
          ...(control.command && { command: control.command }),
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
        const questions = waitingOn.filter((entry) => entry.kind !== 'approval');
        if (questions.length > 0) {
          void pipeline.onNotification(
            {
              type: 'agent_needs_input',
              title: 'The agent is waiting',
              message: questions.map((entry) => entry.message).join('\n'),
            },
            middlewareContext()
          );
        }
        endFailed = undefined;
        await pipeline.afterRun(
          {
            status: 'paused',
            result: paused,
            model: fellBackTo ?? this.pricedModel(effectiveModel, routeProvider),
            memoryAgentId: memoryAgentId(agent),
          },
          middlewareContext()
        );
        keeper?.finish();
        options.onRunComplete?.(paused);
        pausedOut = true;
        return paused;
      }

      await flushContext();
      const kept = runMemory.enabled && runMemory.isOpen;
      for (const item of queue?.pending ?? []) {
        if (item.kind !== 'inject' || !kept || (await passesChecks(item)) === undefined) continue;
        if (!queue?.claim(item)) continue;
        await runMemory.saveUser(
          active.id,
          { role: 'user', content: item.content },
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
        ...(stopRequest && { stopped: stopRequest }),
        ...(harness.instructions.length > 0 && { instructions: [...harness.instructions] }),
        ...(control.command && { command: control.command }),
      };

      if (prompt) await this.recordPrompt(prompt, result, Date.now() - startTime);

      await runMemory.settled();
      await Promise.all(memoryNotes);
      if (sentItemIds.length > 0) this.noteRetrieved(sentItemIds, runId);
      endFailed = undefined;
      await pipeline.afterRun(
        {
          status: 'completed',
          result,
          model: fellBackTo ?? this.pricedModel(effectiveModel, routeProvider),
          memoryAgentId: memoryAgentId(agent),
        },
        middlewareContext()
      );
      const afterRun = this.afterRunSpend.get(runId);
      this.afterRunSpend.delete(runId);
      let spentAfterRun: SessionSpend | undefined;
      if (afterRun) {
        const tokens = afterRun.inputTokens + afterRun.outputTokens;
        runBudget.noteModel(budgetKey(active), afterRun.cost, tokens);
        for (const ancestor of budgetAncestors) {
          const parent = this.runBudgets.get(ancestor);
          parent?.budget.noteModel(parent.agentId(), afterRun.cost, tokens);
        }
        spentAfterRun = await this.keepSessionSpend(threadId, options, runBudget);
      }
      const finished: RunResult = afterRun
        ? {
            ...result,
            ...(spentAfterRun && { sessionSpend: spentAfterRun }),
            usage: {
              ...result.usage,
              inputTokens: result.usage.inputTokens + afterRun.inputTokens,
              outputTokens: result.usage.outputTokens + afterRun.outputTokens,
              totalTokens: result.usage.totalTokens + afterRun.inputTokens + afterRun.outputTokens,
              cost: result.usage.cost + afterRun.cost,
            },
          }
        : result;

      keeper?.finish();
      options.onRunComplete?.(finished);

      return finished;
    } catch (error) {
      queue?.close();
      const handOver =
        keeper !== undefined &&
        (isSuspension(error) || isSuspension(abortController.signal.reason));
      const taken =
        keeper !== undefined && (isLeaseLoss(error) || isLeaseLoss(abortController.signal.reason));
      if (budget && !handOver && !taken) {
        await this.keepSessionSpend(threadId, options, budget).catch(() => undefined);
      }
      if (prompt) await this.recordPrompt(prompt, undefined, Date.now() - startTime);
      if (loopReached && !handOver && !taken) keeper?.finish();
      if (taken) {
        runMemory.seal();
      } else if (abortController.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        if (shown.text && options.saveInterruptedReply !== false && !handOver) {
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

      const failed = error instanceof Error ? error : new Error(String(error));
      if (!taken) await endFailed?.(failed).catch(() => undefined);

      const early = earlyCharges.splice(0);
      const earlyUsage =
        early.length > 0
          ? await this.chargeEarly(early, { agent, threadId, runId, options, startTime }).catch(
              () => undefined
            )
          : undefined;

      options.onRunError?.(failed, runId, usageSoFar() ?? earlyUsage);

      throw error;
    } finally {
      runEnded = true;
      workspaceSeat?.release();
      finishRun();
      if (reservedRun !== undefined) this.durableRunsGoing.delete(reservedRun);
      if (resumeFrom?.recovered) {
        resumeFrom.recovered.stopHolding();
        if (!keeper) await resumeFrom.recovered.release();
      }
      if (keeper) {
        await keeper.end().catch((error: unknown) => {
          getLogger().warn('Could not close the checkpoint of a durable run', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (this.runPipelines.has(runId)) this.runPipelines.delete(runId);
      if (!pausedOut && !checkpointKept) this.interruptSchemas.forgetRun(runId);
      if (this.runMemories.get(runId) === runMemory) this.runMemories.delete(runId);
      if (this.runBudgets.get(runId)?.budget === budget) this.runBudgets.delete(runId);
      if (budget?.leave() && this.sessionLedgers.get(threadId)?.idle) {
        this.sessionLedgers.delete(threadId);
      }
      this.classifierCharges.delete(abortController.signal);
      this.afterRunSpend.delete(runId);
      releaseRunSlot?.();
      pluginLease?.release();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      removeParentAbortListener?.();
    }
  }

  /**
   * Charges the model calls hooks made before a run's usage was counted (a `UserPromptSubmit`
   * prompt hook that refused the input), for a run that failed before then: to the cost router
   * and, when the session has budgets, to what the session spent. The usage they come to
   */
  private async chargeEarly(
    charges: ReadonlyArray<{ usage: ChatResponse['usage']; model: string }>,
    run: { agent: Agent; threadId: string; runId: string; options: RunOptions; startTime: number }
  ): Promise<RunUsage> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    for (const { usage, model } of charges) {
      const priced = this.pricedModel(model);
      const spent = usage.cost ?? this.pricer.costOrNull(priced, usage) ?? 0;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cost += spent;
      this.state.costRouter?.recordCost({
        runId: run.runId,
        agentId: run.agent.id,
        threadId: run.threadId,
        model: priced,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: spent,
      });
    }
    const budgets = mergeBudgets(this.config.budget, run.options.budget);
    const keeps =
      budgets.session !== undefined ||
      budgets.agent !== undefined ||
      run.agent.config.budget !== undefined;
    const tokens = inputTokens + outputTokens;
    const memory = this.state.memoryAdapter;
    if (keeps && tokens + cost > 0) {
      const spend = {
        costUsd: cost,
        tokens,
        toolCalls: 0,
        agents: { [budgetKey(run.agent)]: { costUsd: cost, tokens, toolCalls: 0 } },
      };
      const before = this.spendWrites.get(run.threadId) ?? Promise.resolve();
      const writing = before
        .catch(() => undefined)
        .then(async () => {
          const total = addToSession(
            await this.loadSessionSpend(run.threadId, run.options),
            spend,
            {}
          );
          const updated =
            memory && run.options.useMemory !== false
              ? await memory.updateThread(run.threadId, { [SESSION_BUDGET_KEY]: total })
              : undefined;
          if (updated?.success) this.sessionSpends.delete(run.threadId);
          else this.sessionSpends.set(run.threadId, total);
          this.sessionLedgers.get(run.threadId)?.refresh(total);
        });
      const settled = writing.then(
        () => undefined,
        () => undefined
      );
      this.spendWrites.set(run.threadId, settled);
      await settled;
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: tokens,
      cost,
      duration: Date.now() - run.startTime,
    };
  }

  /**
   * Checks that the run may use its thread and lets it write there before the `startRun`
   * middleware (the `SessionStart` hooks) run: they must not run for a thread of another user,
   * and what they log belongs to the thread
   */
  private async openForStart(
    threadId: string,
    options: RunOptions,
    runMemory: RunMemory
  ): Promise<void> {
    const memory = this.state.memoryAdapter;
    if (!memory || options.useMemory === false) return;
    if (options.threadId !== undefined && options.threadAccess !== 'shared') {
      await assertThreadAccess(memory, threadId, options.userId);
    }
    runMemory.open();
  }

  /**
   * How a new run on `threadId` starts, for `startRun`: `resume` when it goes on from a history
   * (given, or in memory), `startup` otherwise
   */
  private async sessionSource(
    threadId: string,
    options: RunOptions
  ): Promise<'startup' | 'resume'> {
    if (options.history !== undefined) return options.history.length > 0 ? 'resume' : 'startup';
    if (options.useMemory === false || options.loadHistory === false) return 'startup';
    const memory = this.state.memoryAdapter;
    if (!memory) return 'startup';
    const thread = await memory.getThread(threadId);
    return thread.success && thread.data?.activeLeafId !== undefined ? 'resume' : 'startup';
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
    checkInput: (messages: readonly Message[]) => Promise<readonly string[]>,
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

    const added = await checkInput(messages);

    if (options.context) {
      addContextToMessages(messages, options.context);
    }

    await runMemory.saveUser(
      agent.id,
      { role: 'user', content: buildUserContent(options.input, options.images) },
      options.inputMetadata
    );
    for (const text of added) {
      const note: Message = { role: 'system', content: text };
      messages.push(note);
      await runMemory.save(agent.id, note, undefined, undefined, { context: 'beforeRun' });
    }

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

  /** The durable runs settings, undefined when runs keep no checkpoint while they go on */
  private durableConfig(): DurableRunsConfig | undefined {
    const durable = this.config.durable;
    if (durable === undefined || durable === false) return undefined;
    return durable === true ? {} : durable;
  }

  /** Where durable runs are kept: `durable.store`, the memory adapter's threads, or process memory */
  private durableStore(): DurableRunStore {
    const configured = this.durableConfig()?.store;
    if (configured) return configured;
    const memory = this.state.memoryAdapter;
    if (memory) {
      if (this.threadDurableRuns?.memory !== memory) {
        this.threadDurableRuns = { memory, store: new ThreadDurableRunStore(memory) };
      }
      return this.threadDurableRuns.store;
    }
    this.processDurableRuns ??= new InMemoryDurableRunStore();
    return this.processDurableRuns;
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

  /**
   * Whether this runtime's runs are durable by default (`CogitatorConfig.durable` set and
   * enabled). A run of another process shows in `durableRuns()`, and so to a rewind, only when it
   * is durable
   */
  get durableByDefault(): boolean {
    const durable = this.durableConfig();
    return durable !== undefined && durable.enabled !== false;
  }

  /**
   * The durable runs kept (`durable`), with whether a live process holds each: a run nobody holds
   * was left by a process that stopped, for `recoverRuns()` or `discardRun()`
   */
  async durableRuns(
    filter: { threadId?: string; agentId?: string; userId?: string } = {}
  ): Promise<DurableRunInfo[]> {
    await this.getMemory();
    const kept = await this.durableStore().list(filter);
    return kept.map((summary) => ({
      ...summary,
      held:
        this.durableRunsGoing.has(summary.runId) ||
        (summary.lease !== undefined && this.restartedFrom(summary.lease) === undefined),
    }));
  }

  /**
   * Picks up the durable runs a stopped process left running and continues each from its last
   * step: the conversation comes back from the checkpoint and the thread's log, a tool call that
   * returned before the stop keeps its result, one that was running gets "outcome unknown,
   * verify before retrying" (the model checks before it calls again), and messages queued on the
   * run's handle are delivered. Runs a live process holds are left alone, and each run is taken
   * under a lease, so two processes recovering at once never continue one run twice (with a
   * store whose leases are atomic, see `DurableRunStore`). With `resume: false` the runs are only
   * reported in `found`, for the host to `recoverRun()` or `discardRun()` them.
   *
   * @example
   * ```ts
   * const cog = new Cogitator({ memory, durable: { owner: process.env.HOSTNAME } });
   * const { resumed } = await cog.recoverRuns({ agents: [assistant] });
   * for (const { handle } of resumed) handle.result.then(deliver);
   * ```
   */
  async recoverRuns<TDeps = unknown>(
    options: RecoverRunsOptions<Agent<TDeps>, TDeps>
  ): Promise<RecoveredAgentRuns> {
    const recovered: RecoveredAgentRuns = { resumed: [], skipped: [], found: [] };
    for (const run of await this.durableRuns()) {
      if (run.held) continue;
      if (options.filter && !options.filter(run)) continue;
      if (options.resume === false) {
        recovered.found.push(run);
        continue;
      }
      const agent =
        typeof options.agents === 'function'
          ? options.agents(run)
          : (options.agents.find((candidate) => candidate.id === run.agentId) ??
            options.agents.find((candidate) => candidate.name === run.agentName));
      if (!agent) {
        recovered.skipped.push({
          run,
          reason: `agent "${run.agentName}" (${run.agentId}) was not given`,
        });
        continue;
      }
      try {
        const handle = await this.recoverDurable(agent, run.runId, options.options?.(run) ?? {});
        recovered.resumed.push({ run, handle });
      } catch (error) {
        recovered.skipped.push({
          run,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return recovered;
  }

  /**
   * Continues one durable run a stopped process left running, as `recoverRuns()` does, with the
   * agent it was started with. Resolves once the run is taken, with its handle
   *
   * @throws CogitatorError `RUN_NOT_FOUND` when no such run is kept, `RUN_LEASED` when a live
   * process holds it
   */
  async recoverRun<TDeps = unknown>(
    agent: Agent<TDeps>,
    runId: string,
    ...[options = {} as RecoverRunOptions<TDeps>]: RecoverArgs<TDeps>
  ): Promise<RunHandle & Required<Pick<RunHandle, 'setPermissionMode'>>> {
    return this.recoverDurable(agent, runId, options);
  }

  private async recoverDurable(
    agent: Agent,
    runId: string,
    options: RecoverRunOptions
  ): Promise<RunHandle & Required<Pick<RunHandle, 'setPermissionMode'>>> {
    const { record, release, stopHolding } = await this.takeDurableRun(runId);
    try {
      if (agent.id !== record.agentId && agent.name !== record.agentName) {
        throw new CogitatorError({
          message: `Durable run ${runId} belongs to agent "${record.agentName}", not "${agent.name}"`,
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      const rebuilt = await rebuildDurableRun(record, this.state.memoryAdapter);
      const recovered: RecoveredFrom = {
        repairs: rebuilt.repairs,
        ...(rebuilt.answered && { answered: rebuilt.answered }),
        savedAt: record.savedAt,
        entered: false,
        stopHolding,
        release,
      };
      const handle = this.startWith(
        agent,
        {
          ...options,
          input: '',
          threadId: record.threadId,
          ...(record.userId !== undefined && { userId: record.userId }),
        },
        {
          checkpoint: rebuilt.checkpoint,
          decisions: {},
          checkUser: false,
          recovered,
        },
        rebuilt.queued
      );
      handle.result.catch(() => {
        if (!recovered.entered) void release();
      });
      return handle;
    } catch (error) {
      await release();
      throw error;
    }
  }

  /**
   * Ends a durable run a stopped process left running without going on: the tool calls of its
   * last step that have no answer in the thread get one (the result a call returned, "outcome
   * unknown" for one that was running, "Not run" for the others), so the next run of the thread
   * reads a whole history, and the run is no longer kept
   *
   * @throws CogitatorError `RUN_NOT_FOUND`, `RUN_LEASED` as `recoverRun()`
   */
  async discardRun(runId: string): Promise<void> {
    const { record, release, epoch } = await this.takeDurableRun(runId);
    const store = this.durableStore();
    const leaseMs = this.durableConfig()?.leaseMs ?? DEFAULT_DURABLE_LEASE_MS;
    const takenOver = () =>
      new CogitatorError({
        message: `Another process took durable run ${runId} over while it was being discarded`,
        code: ErrorCode.RUN_LEASED,
        details: { runId },
      });
    try {
      const rebuilt = await rebuildDurableRun(record, this.state.memoryAdapter);
      const { checkpoint } = rebuilt;
      const memory = new RunMemory(
        () => this.state.memoryAdapter,
        record.threadId,
        () => ({
          input: '',
          threadId: record.threadId,
          ...(record.userId !== undefined && { userId: record.userId }),
        })
      );
      memory.tag(`${runId}/discard`);
      memory.epoch(epoch);
      memory.guard(async () => {
        if (!(await store.renew(record, this.durableHolder, leaseMs))) throw takenOver();
      });
      memory.open(checkpoint.branch);
      const settled = new Set(checkpoint.turn.completed ?? []);
      const answers = [
        ...rebuilt.repairs,
        ...checkpoint.turn.toolCalls
          .filter((call) => !settled.has(call.id))
          .map((toolCall) => ({
            toolCall,
            result: {
              callId: toolCall.id,
              name: toolCall.name,
              result: null,
              error: 'Not run: the run was discarded after its process stopped',
            } satisfies ToolResult,
          })),
      ];
      for (const { toolCall, result } of answers) {
        await memory.save(
          checkpoint.agentId,
          createToolMessage(toolCall, result),
          undefined,
          ...savedToolResult(result)
        );
      }
      if (!(await store.delete(record, this.durableHolder))) throw takenOver();
      await release();
    } catch (error) {
      await release();
      throw error;
    }
  }

  /**
   * The instance of a lease this runtime takes over before it runs out: one of its own `owner`
   * that no runtime of this process has, with `takeoverOnRestart` set. Undefined otherwise, when
   * only a lease that ran out may be taken
   */
  private restartedFrom(lease: DurableRunLease): string | undefined {
    const config = this.durableConfig();
    if (config?.takeoverOnRestart !== true || config.owner === undefined) return undefined;
    if (lease.owner !== this.durableOwner || LIVE_INSTANCES.has(lease.instance)) return undefined;
    return lease.instance;
  }

  /** The last lease epoch the thread of run `runId` fenced, 0 for none */
  private async fencedEpoch(threadId: string, runId: string): Promise<number> {
    const memory = this.state.memoryAdapter;
    if (!memory) return 0;
    const thread = await memory.getThread(threadId);
    if (!thread.success || !thread.data) return 0;
    return durableFencesOf(thread.data.metadata)[runId]?.epoch ?? 0;
  }

  /**
   * Notes in the thread of a durable run this runtime takes over that its lease epoch `epoch`
   * began: an entry of an older epoch that lands after it (a write of the former holder that
   * came late) is dropped by every reader, see `withoutStaleDurableEntries`
   */
  private async fenceDurableRun(run: DurableRunSummary, epoch: number): Promise<void> {
    const memory = this.state.memoryAdapter;
    if (!memory) return;
    const thread = await memory.getThread(run.threadId);
    if (!thread.success || !thread.data) return;
    const added = await memory.addEntry({
      threadId: run.threadId,
      message: {
        role: 'system',
        content: `Durable run ${run.runId} was taken over (lease epoch ${epoch})`,
      },
      tokenCount: 0,
      type: 'custom',
      event: { kind: DURABLE_FENCE, runId: run.runId, epoch },
      metadata: { durableRun: `${run.runId}/fence-${epoch}`, durableEpoch: epoch },
      activate: false,
    });
    if (!added.success) {
      throw new CogitatorError({
        message: `Could not fence durable run ${run.runId} in its thread: ${added.error}`,
        code: ErrorCode.MEMORY_WRITE_FAILED,
      });
    }
    const fence: DurableFence = {
      epoch,
      at: added.data.createdAt.toISOString(),
      ...(added.data.seq !== undefined && { seq: added.data.seq }),
    };
    const updated = await memory.updateThread(run.threadId, {
      [DURABLE_FENCE_KEY_PREFIX + run.runId]: fence,
    });
    if (!updated.success) {
      throw new CogitatorError({
        message: `Could not fence durable run ${run.runId} in its thread: ${updated.error}`,
        code: ErrorCode.MEMORY_WRITE_FAILED,
      });
    }
  }

  /** Takes a kept durable run for this runtime, with how to let it go again */
  private async takeDurableRun(runId: string): Promise<{
    record: DurableRunRecord;
    release: () => Promise<void>;
    stopHolding: () => void;
    epoch: number;
  }> {
    const leased = (expiresAt?: number) =>
      new CogitatorError({
        message: `Durable run ${runId} is held by a live process`,
        code: ErrorCode.RUN_LEASED,
        details: { runId, ...(expiresAt !== undefined && { expiresAt }) },
      });
    if (this.durableRunsGoing.has(runId)) throw leased();
    this.durableRunsGoing.add(runId);
    let held: DurableRunSummary | undefined;
    let holding: ReturnType<typeof setInterval> | undefined;
    const store = () => this.durableStore();
    const stopHolding = () => clearInterval(holding);
    const release = async () => {
      stopHolding();
      this.durableRunsGoing.delete(runId);
      if (held) {
        await store()
          .release(held, this.durableHolder)
          .catch(() => undefined);
      }
    };
    try {
      await this.getMemory();
      const [found] = await store().list({ runId });
      if (!found) {
        throw new CogitatorError({
          message: `No durable run ${runId} is kept`,
          code: ErrorCode.RUN_NOT_FOUND,
          details: { runId },
        });
      }
      const lease = found.lease;
      const replacing = lease && this.restartedFrom(lease);
      const leaseMs = this.durableConfig()?.leaseMs ?? DEFAULT_DURABLE_LEASE_MS;
      const taken = await store().acquire(found, this.durableHolder, leaseMs, {
        ...(replacing !== undefined && { replacing }),
        above: await this.fencedEpoch(found.threadId, runId),
      });
      if (taken === false) throw leased(lease?.expiresAt);
      held = found;
      await this.fenceDurableRun(found, taken);
      holding = setInterval(
        () => {
          void store()
            .renew(found, this.durableHolder, leaseMs)
            .catch(() => undefined);
        },
        Math.max(1, Math.floor(leaseMs / 3))
      );
      holding.unref?.();
      const record = await store().load(found);
      if (!record) {
        throw new CogitatorError({
          message: `No durable run ${runId} is kept`,
          code: ErrorCode.RUN_NOT_FOUND,
          details: { runId },
        });
      }
      return { record, release, stopHolding, epoch: taken };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** The permissions of this runtime's runs, made on first use */
  private permissionsOf(): PermissionService {
    this.permissionService ??= new PermissionService(this.config.permissions, (config) => {
      if (!config) return undefined;
      if (isPermissionClassifier(config)) return config;
      this.classifier ??= modelClassifier(async (messages, signal, input) => {
        const { backend, model } = this.route(config.model);
        const response = await backend.chat({ model, messages, temperature: 0, signal });
        if (input.signal) this.classifierCharges.get(input.signal)?.(response.usage, config.model);
        return response.content;
      }, config);
      return this.classifier;
    });
    return this.permissionService;
  }

  /**
   * The arguments an approval changes a call to, when the run may take them: with permissions set
   * up, or from a `decideApproval` middleware (a `PermissionRequest` hook), which the host set up.
   * Others are dropped with a warning, as before an approval could not change a call
   */
  private acceptedUpdate(
    decision: ToolApprovalDecision,
    permissions: RunPermissions
  ): Record<string, unknown> | undefined {
    if (!decision.approved || decision.updatedArguments === undefined) return undefined;
    if (permissions.active || this.hookDecisions.has(decision)) return decision.updatedArguments;
    this.permissionsOf().warnOnce(
      'An approval changed the arguments of a call, which a runtime without permissions ignores'
    );
    return undefined;
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
    const { classifierInput: _approved, ...approvedCall } = call;
    const verdict = await permissions.decide(tool, updated, approvedCall);
    if (verdict.decision === 'deny') {
      return { error: `the arguments the approval changed the call to: ${verdict.reason}` };
    }
    return { args: updated };
  }

  /**
   * The ledger the runs of thread `threadId` going on in this process share, its record read
   * again from storage for the run that starts
   */
  private async sessionLedgerOf(threadId: string, options: RunOptions): Promise<SessionLedger> {
    const stored = await this.loadSessionSpend(threadId, options);
    const ledger = this.sessionLedgers.get(threadId);
    if (ledger) {
      ledger.refresh(stored);
      return ledger;
    }
    const fresh = new SessionLedger(stored);
    this.sessionLedgers.set(threadId, fresh);
    return fresh;
  }

  /** What the session of thread `threadId` spent, from its metadata or this process */
  private async loadSessionSpend(threadId: string, options: RunOptions): Promise<SessionSpend> {
    const memory = this.state.memoryAdapter;
    if (memory && options.useMemory !== false) {
      try {
        const thread = await memory.getThread(threadId);
        const kept = thread.success ? thread.data?.metadata[SESSION_BUDGET_KEY] : undefined;
        if (kept !== undefined) {
          const local = this.sessionSpends.get(threadId);
          const stored = readSessionSpend(kept);
          return local ? freshestSpend(stored, readSessionSpend(local)) : stored;
        }
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
    const before = this.spendWrites.get(threadId) ?? Promise.resolve();
    const writing = before
      .catch(() => undefined)
      .then(() => this.writeSessionSpend(threadId, options, budget));
    const settled = writing.then(
      () => undefined,
      () => undefined
    );
    this.spendWrites.set(threadId, settled);
    void settled.then(() => {
      if (this.spendWrites.get(threadId) === settled) this.spendWrites.delete(threadId);
    });
    return writing;
  }

  /** {@link keepSessionSpend} itself, one write of a thread at a time */
  private async writeSessionSpend(
    threadId: string,
    options: RunOptions,
    budget: RunBudget
  ): Promise<SessionSpend> {
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
    if (kept) this.sessionSpends.delete(threadId);
    else this.sessionSpends.set(threadId, total);
    budget.markRecorded(total);
    return total;
  }

  /**
   * Decides a call once more right before its tool starts, after the middleware and once it holds
   * its locks: the run loop's check and `invokeTool()`'s. Why it may not run, or undefined. A call
   * a person approved (`human`) stops only at a deny or a mode that refuses it (`plan`), an
   * approval answering an ask (`dontAsk` decides it as `default`), one the rules allowed also when
   * it would now ask. A call the `auto` classifier allowed (`judged`) is not judged again while
   * the run stays in `auto` mode
   */
  private async finalCheck(check: {
    tool: Tool;
    toolCall: Pick<ToolCall, 'id' | 'name'>;
    args: Record<string, unknown>;
    permissions: RunPermissions;
    call: PermissionCall;
    human: boolean;
    judged: boolean;
  }): Promise<string | undefined> {
    const { permissions, human } = check;
    const judged = check.judged && permissions.mode === 'auto';
    const { classifierInput: _judgedBefore, ...unjudged } = check.call;
    let verdict: PermissionDecision;
    try {
      verdict = await permissions.decide(check.tool, check.args, {
        ...(judged || human ? unjudged : check.call),
        ...(human && permissions.mode === 'dontAsk' && { mode: 'default' as const }),
      });
    } catch (error) {
      if (!(error instanceof ClassifierBudgetReached)) throw error;
      return `classifying the call would pass a budget (${error.usage.scope} ${error.usage.metric})`;
    }
    const recorded = { toolCallId: check.toolCall.id, toolName: check.toolCall.name };
    if (verdict.decision === 'deny') {
      await permissions.record({ ...verdict, ...recorded });
      return verdict.reason;
    }
    if (verdict.decision === 'ask' && !human && !judged) {
      const reason = `the call no longer passes the permissions when it runs (${verdict.reason}): the mode, or what it touches, changed since it was decided`;
      await permissions.record({ ...verdict, ...recorded, decision: 'deny', reason });
      return reason;
    }
    return undefined;
  }

  /**
   * Decides the arguments a `wrapToolCall` middleware changed a call to, as the permissions
   * decide the ones the model sent: a deny refuses, an allow goes on, and an ask takes a decision
   * of its own from `decide`, since an approval of the old arguments does not carry over to new
   * ones. `pause` holds the request the call waits for when nobody decided it, `byPerson` marks
   * an answer a person gave, `byClassifier` an allow of the `auto` classifier, which the final
   * check before the call runs does not ask again
   */
  private async permitChangedArguments(changed: {
    tool: Tool;
    toolCall: ToolCall;
    permissions: RunPermissions;
    call: PermissionCall;
    request: Pick<ToolApprovalRequest, 'agentId' | 'threadId' | 'userId'>;
    decide: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision | 'pause'>;
  }): Promise<
    (ChangedCallPermit & { byPerson?: true; byClassifier?: true }) | { pause: ToolApprovalRequest }
  > {
    const { tool, toolCall, permissions, call } = changed;
    let verdict: PermissionDecision;
    try {
      verdict = await permissions.decide(tool, toolCall.arguments, call);
    } catch (error) {
      if (!(error instanceof ClassifierBudgetReached)) throw error;
      return {
        allowed: false,
        reason: `classifying the arguments a middleware changed the call to would pass a budget (${error.usage.scope} ${error.usage.metric})`,
      };
    }
    if (verdict.decision !== 'ask') {
      await permissions.record({ ...verdict, toolCallId: toolCall.id, toolName: toolCall.name });
      return verdict.decision === 'allow'
        ? { allowed: true, ...(verdict.decidedBy === 'classifier' && { byClassifier: true }) }
        : {
            allowed: false,
            reason: `the arguments a middleware changed the call to: ${verdict.reason}`,
          };
    }
    const suggestedRule = permissions.suggest(tool, toolCall.arguments, call.workspace);
    const request: ToolApprovalRequest = {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      description: tool.description,
      ...(tool.sideEffects && { sideEffects: [...tool.sideEffects] }),
      ...changed.request,
      reason: `A middleware changed the arguments of the call: ${verdict.reason}`,
      ...(verdict.rule && { rule: verdict.rule }),
      ...(suggestedRule !== undefined && { suggestedRule }),
      mode: verdict.mode,
    };
    const decision = await changed.decide(request);
    if (decision === 'pause') return { pause: request };
    return {
      ...(await this.answerChangedArguments(tool, toolCall, decision, permissions, call)),
      byPerson: true,
    };
  }

  /**
   * What a person's decision on the arguments a middleware changed a call to lets the call do,
   * recorded: a decline refuses it, an approval runs it, with the arguments the approval changed
   * the call to once they pass the schema and the rules, and saves the rule it asks to remember
   */
  private async answerChangedArguments(
    tool: Tool,
    toolCall: ToolCall,
    decision: ToolApprovalDecision,
    permissions: RunPermissions,
    call: PermissionCall
  ): Promise<ChangedCallPermit> {
    const answered: PermissionDecisionEvent = {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      decision: decision.approved ? 'allow' : 'deny',
      mode: permissions.mode,
      ...answeredBy(this.hookDecisions.has(decision), decision),
    };
    if (!decision.approved) {
      await permissions.record(answered);
      return {
        allowed: false,
        reason: `the user declined the arguments a middleware changed the call to${decision.reason ? `: ${decision.reason}` : ''}`,
      };
    }
    let args = toolCall.arguments;
    let event = answered;
    const updated = this.acceptedUpdate(decision, permissions);
    if (updated) {
      const checked = await this.checkUpdatedArguments(tool, updated, permissions, {
        ...call,
        needsApproval: false,
      });
      if ('error' in checked) {
        await permissions.record({ ...answered, decision: 'deny', reason: checked.error });
        return { allowed: false, reason: checked.error };
      }
      args = checked.args;
      event = { ...event, updatedArguments: checked.args };
    }
    if (decision.remember) {
      const remembered = await permissions.remember(tool, args, decision.remember, call.workspace);
      if (remembered) event = { ...event, remembered };
    }
    await permissions.record(event);
    return { allowed: true, ...(updated && { args }) };
  }

  /**
   * The decision for a call that needs approval: the `decideApproval` middleware (the
   * `PermissionRequest` hooks among them), else the run's `onApproval`, else
   * `guardrails.onToolApproval`, else a pause. The middleware hear of an approval they leave to a
   * person (`onNotification`)
   */
  private async decideApproval(
    request: ToolApprovalRequest,
    onApproval: RunOptions['onApproval'],
    gate?: {
      pipeline: MiddlewarePipeline;
      context: RunMiddlewareContext;
      tool: Tool;
      /** The run's signal: an abort ends the wait for the hooks' and a person's answer */
      signal?: AbortSignal;
    }
  ): Promise<ToolApprovalDecision | 'pause'> {
    const signal = gate?.signal;
    const answer = <T>(asked: T | Promise<T>): Promise<T> =>
      signal ? waitForAbortable(Promise.resolve(asked), signal) : Promise.resolve(asked);
    if (gate) {
      const hooked = await answer(
        gate.pipeline.decideApproval({ request, tool: gate.tool }, gate.context)
      );
      if (hooked) {
        this.hookDecisions.add(hooked);
        return hooked;
      }
      void gate.pipeline.onNotification(
        {
          type: 'permission_prompt',
          title: 'Permission needed',
          message: `The agent needs your permission to use ${request.toolName}`,
        },
        gate.context
      );
    }
    const decided = onApproval ? await answer(onApproval(request)) : undefined;
    if (decided !== undefined) return decided;
    const legacy = this.config.guardrails?.onToolApproval;
    if (legacy) {
      const approved = await answer(
        legacy(request.toolName, request.arguments, request.sideEffects ?? [])
      );
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
    primary: ModelRoute,
    snapshot?: PluginSnapshot
  ): ModelCandidate[] {
    const candidates: ModelCandidate[] = [
      { name: this.pricedModel(modelString, explicitProvider), ...primary },
    ];
    for (const fallback of owner.config.fallbackModels ?? []) {
      const [fallbackModel, fallbackProvider] =
        typeof fallback === 'string' ? [fallback, undefined] : [fallback.model, fallback.provider];
      const name = this.pricedModel(fallbackModel, fallbackProvider);
      if (candidates.some((candidate) => candidate.name === name)) continue;
      candidates.push({ name, ...this.turnRoute(fallbackModel, fallbackProvider, snapshot) });
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
   * masking, which the turn's middleware does instead. With `snapshot`, the plugin generations a
   * run holds: a provider of a plugin comes from them, even after a reload replaced it
   */
  private turnRoute(
    modelString: string,
    explicitProvider?: string,
    snapshot?: PluginSnapshot
  ): ModelRoute {
    const { provider, model } = this.chatRoute(modelString, explicitProvider);
    return { backend: this.heldTurnBackend(provider, snapshot), model };
  }

  /**
   * The turn backend of `name` for a run that holds `snapshot`: the shared one, unless the plugin
   * that brings the provider in `snapshot` is no longer the one that brings it now, then one of
   * the run's own, built from the plugin of its generation
   */
  private heldTurnBackend(name: string, snapshot: PluginSnapshot | undefined): LLMBackend {
    if (!snapshot || Object.hasOwn(this.config.llm?.backends ?? {}, name)) {
      return this.turnBackendFor(name);
    }
    const held = this.pluginBackendOf(name, snapshot);
    if (!held || held === this.pluginBackendOf(name, this.pluginHost.snapshot())) {
      return this.turnBackendFor(name);
    }
    let backend = this.heldBackends.get(held);
    if (!backend) {
      backend = withLLMRetry(this.backendFromPlugin(name, held), this.config.llm?.retry);
      this.heldBackends.set(held, backend);
    }
    return backend;
  }

  /**
   * The plugin that brings provider `name` in `snapshot`: the core's for a built-in provider, a
   * third party's only when no provider of that name is registered globally
   */
  private pluginBackendOf(name: string, snapshot: PluginSnapshot): LLMPlugin | undefined {
    const contributed = snapshot.backends.get(name);
    if (!contributed) return undefined;
    const fromCore = snapshot.backendOwners.get(name)?.endsWith('@builtin') === true;
    return fromCore || !hasLLMPlugin(name) ? contributed : undefined;
  }

  /** The backend `plugin` builds for provider `name`, with its `llm.plugins` config checked */
  private backendFromPlugin(name: string, plugin: LLMPlugin): LLMBackend {
    const config = this.config.llm?.plugins?.[name];
    if (plugin.validateConfig && !plugin.validateConfig(config)) {
      throw new CogitatorError({
        message: `Invalid configuration for provider '${name}' (llm.plugins.${name})`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    return plugin.factory(config);
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
    if (
      Object.hasOwn(llm?.backends ?? {}, provider) ||
      (this.pluginHost.snapshot().backends.has(provider) && !isLLMProvider(provider)) ||
      hasLLMPlugin(provider)
    ) {
      return true;
    }
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
      this.pluginHost.snapshot().backends.has(name) ||
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

  /**
   * The backend of provider `name`: `llm.backends`, then the built-in providers, then a provider
   * registered globally with `registerLLMBackend`, then one a plugin brings. A plugin never takes
   * over a provider registered globally, nor gets its `llm.plugins` config
   */
  private createBackend(name: string): LLMBackend {
    const custom = this.config.llm?.backends;
    if (custom && Object.hasOwn(custom, name)) return custom[name];
    const contributed = this.pluginBackendOf(name, this.pluginHost.snapshot());
    if (contributed) {
      const backend = this.backendFromPlugin(name, contributed);
      this.backendPlugins.set(name, contributed);
      return backend;
    }
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
   * Rewinds `threadId` to `toEntryId`, an entry of its active branch, in one operation: the
   * conversation, the memory that stood on it, and with `files` the files of the workspace.
   *
   * - Conversation: new entries go after `toEntryId`, the entries after it stay on a branch of
   *   their own (`conversation.cut`).
   * - Memory: the memory items that stood only on those entries become `stale`
   *   (`staleBecause: { reason: 'rewound' }`), and summaries and memory files of the branch left
   *   behind are not seen from the new one. The paused run of the thread and its durable runs are
   *   dropped (`runs`), as their checkpoints hold the conversation that was cut.
   * - Files, only with `files: true` (or `checkpoints.rewindFiles`): the workspace is restored
   *   from the file checkpoint the runs took at that point (see `CogitatorConfig.checkpoints`),
   *   the one taken right after `toEntryId` when it is the last entry before a user message,
   *   else the nearest one before it. The checkpoint must be one the workspace keeps for this
   *   thread (or a thread it was forked from). A snapshot of the files as they were goes first
   *   (`files.safetySnapshotId`, to undo the rewind with `workspace.restore()`), then the
   *   restore, before the conversation moves, so a restore that fails leaves the conversation as
   *   it was and the call can be made again.
   *
   * The thread is held for the whole rewind, and with files the workspace too: runs starting
   * there meanwhile wait for it. `memory: false` restores the files only. `dryRun` changes
   * nothing and reports what would change, `runs.going` the runs in the way. A run going on in
   * the thread (here, or as a durable run another process holds) refuses the rewind with
   * `THREAD_BUSY`, and with files a run of this runtime in the same workspace (of any thread)
   * or a command the workspace still runs refuses it with `WORKSPACE_BUSY`, unless `force` stops
   * them first. A durable run another process holds is never forced while files are restored, as
   * its tools could still be writing: wait for its lease to run out.
   *
   * @throws CogitatorError (`VALIDATION_ERROR`) when no memory is configured, the adapter has no
   * branches, `toEntryId` is not on the active branch, the thread names no agents and `agents`
   * is not passed, a tool of a run of the thread or the workspace asks for the rewind, or files
   * are to be restored and there is no checkpoint at that point, no workspace to restore
   * (`workspace`, or the workspace of one of `agents`), or a checkpoint the workspace does not
   * keep for this thread. `THREAD_BUSY` and `WORKSPACE_BUSY` as above. A store that fails throws
   * its own error, and the rewind can be made again.
   */
  async rewind(
    threadId: string,
    toEntryId: string,
    options: RewindOptions = {}
  ): Promise<RewindReport> {
    const memory = await this.getMemory();
    if (!memory) {
      throw new CogitatorError({
        message: 'rewind needs memory: set memory.adapter in the Cogitator config',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (!memory.rewind || !memory.getPath) {
      throw new CogitatorError({
        message: `The ${memory.provider} memory adapter has no branches to rewind`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const rewindsMemory = options.memory ?? true;
    const runtimeCheckpoints =
      typeof this.config.checkpoints === 'object' ? this.config.checkpoints : undefined;
    const rewindsFiles = options.files ?? runtimeCheckpoints?.rewindFiles ?? false;
    if (!rewindsMemory && !rewindsFiles) {
      throw new CogitatorError({
        message: 'rewind with memory: false restores files only: pass files: true',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const dryRun = options.dryRun ?? false;
    const getPath = memory.getPath.bind(memory);
    this.refuseFromOwnTool('rewind', threadId);

    const read = async () => {
      const thread = unwrapMemory(await memory.getThread(threadId));
      if (!thread) {
        throw new CogitatorError({
          message: `Thread ${threadId} does not exist`,
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      const path = unwrapMemory(await getPath({ threadId, types: 'all' }));
      const index = path.findIndex((entry) => entry.id === toEntryId);
      if (index === -1) {
        throw new CogitatorError({
          message: `Entry ${toEntryId} is not on the active branch of thread ${threadId}`,
          code: ErrorCode.VALIDATION_ERROR,
          details: { threadId, toEntryId },
        });
      }
      const files = rewindsFiles
        ? fileRestorePlan(
            path,
            index,
            options,
            unwrapMemory(await memory.getEntries({ threadId, types: 'all' }))
          )
        : undefined;
      const checkpoint = files ? await this.verifyCheckpoint(memory, threadId, files) : undefined;
      return { thread, path, index, files, checkpoint };
    };

    const releaseThread = await this.threadRuns.lock(threadId);
    let releaseWorkspace: (() => void) | undefined;
    try {
      let state = await read();
      if (state.files) {
        this.refuseFromOwnTool(
          'rewind',
          threadId,
          await this.workspaceRuns.active(state.files.workspace)
        );
        releaseWorkspace = await this.workspaceRuns.lock(state.files.workspace);
      }
      const cascade = rewindsMemory ? await this.cascadeFor('rewind', options) : undefined;
      const agentIds = cascade ? await this.withThreadAgents(cascade.agentIds, [threadId]) : [];
      let plan = state.files ? await state.files.restore({ dryRun: true }) : undefined;
      const going = await this.goingOn(threadId, state.files?.workspace);
      const durable = this.durableStore();

      const report: RewindReport = {
        ...emptyCascadeReport(),
        threadId,
        toEntryId,
        dryRun,
        conversation: {
          rewound: false,
          cut: rewindsMemory ? state.path.slice(cutFrom(state)).map((entry) => entry.id) : [],
          ...(state.thread.activeLeafId !== undefined && {
            previousLeafId: state.thread.activeLeafId,
          }),
        },
        runs: { going: going.ids, interrupted: [], paused: false, durable: [] },
      };

      if (dryRun) {
        if (plan) report.files = plan;
        if (cascade) {
          Object.assign(
            report,
            await cascade.cascade.rewind(threadId, toEntryId, { agentIds }, { dryRun: true })
          );
          report.runs.paused = (await this.runCheckpointStore().load(threadId)) !== null;
          report.runs.durable = (await durable.list({ threadId })).map((run) => run.runId);
        }
        return report;
      }

      this.refuseBusy('rewind', threadId, going, plan, options.force ?? false, rewindsFiles);
      if (going.thread.count > 0 || going.ids.length > 0 || (rewindsFiles && going.tools > 0)) {
        const stopped = await this.stopRuns(threadId, going, `Thread ${threadId} is being rewound`);
        report.runs.interrupted = stopped.interrupted;
        report.runs.durable = stopped.durable;
        if (state.files) {
          await this.awaitTools(
            'rewind',
            threadId,
            state.files.workspace,
            options.toolSettleMs ?? TOOL_SETTLE_MS
          );
        }
        state = await read();
        report.conversation.cut = rewindsMemory
          ? state.path.slice(cutFrom(state)).map((entry) => entry.id)
          : [];
        plan = state.files ? await state.files.restore({ dryRun: true }) : undefined;
        if (plan?.busy) throw workspaceBusy('rewind', threadId, plan);
      }

      if (state.files && plan && state.checkpoint)
        report.files = await this.restoreWithSafety(state.files, plan, state.checkpoint, {
          threadId,
          reason: 'rewind',
          entryId: toEntryId,
        });
      if (cascade) {
        Object.assign(report, await cascade.cascade.rewind(threadId, toEntryId, { agentIds }));
        report.conversation.rewound = true;
        const dropped = await this.dropPausedRuns([threadId]);
        report.runs.paused = dropped.paused.length > 0;
        report.runs.durable.push(...dropped.durable);
      }
      return report;
    } finally {
      releaseWorkspace?.();
      releaseThread();
    }
  }

  /**
   * Forks `threadId` at `atEntryId` into a new thread holding the branch up to it (see
   * `MemoryAdapter.forkThread`): each copied entry keeps its metadata, the file checkpoints the
   * user messages name included, and the copy of the point names the checkpoint of the files
   * exactly at it (`fileCheckpointAt`) when the message it was taken for lies after the point, so
   * rewinds and forks of the fork restore those files from there too. With `files: true` the workspace of the fork (`workspace`, or
   * the workspace of one of `agents`) gets the files as they were at that point, a snapshot of
   * them as they were taken first (`files.safetySnapshotId`): when it is another workspace than
   * `source` (where the checkpoints are kept, `workspace` by default), every checkpoint of the
   * branch is copied into it first (`copySnapshot`), so later rewinds of the fork restore there
   * too. Every check, the safety snapshot's included, runs before the fork is made, and the files
   * are restored once it is: a fork refused leaves nothing behind, one whose files then fail to
   * restore takes the thread and the checkpoints copied for it back, and a dry run leaves no copy behind.
   * With `files` the thread and the workspace are held for the whole fork, as by `rewind`, and
   * `dryRun` reports what the fork would restore without making it.
   *
   * @throws CogitatorError (`VALIDATION_ERROR`) when no memory is configured or the adapter
   * cannot fork, and with `files` when there is no checkpoint at that point, no workspace, a
   * checkpoint the source does not keep for this thread, or a source that cannot copy its
   * snapshots. With `files`, `THREAD_BUSY` and `WORKSPACE_BUSY` as by `rewind`, unless `force`
   */
  forkThread(
    threadId: string,
    atEntryId: string,
    options: ForkThreadOptions & { dryRun: true }
  ): Promise<ForkThreadPlan>;
  forkThread(
    threadId: string,
    atEntryId: string,
    options?: ForkThreadOptions & { dryRun?: false }
  ): Promise<ForkThreadResult>;
  forkThread(
    threadId: string,
    atEntryId: string,
    options?: ForkThreadOptions
  ): Promise<ForkThreadResult | ForkThreadPlan>;
  async forkThread(
    threadId: string,
    atEntryId: string,
    options: ForkThreadOptions = {}
  ): Promise<ForkThreadResult | ForkThreadPlan> {
    const memory = await this.getMemory();
    if (!memory?.forkThread || !memory.getPath) {
      throw new CogitatorError({
        message: memory
          ? `The ${memory.provider} memory adapter cannot fork threads`
          : 'forkThread needs memory: set memory.adapter in the Cogitator config',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const forkThread = memory.forkThread.bind(memory);
    const getPath = memory.getPath.bind(memory);
    const branch = unwrapMemory(await getPath({ threadId, leafId: atEntryId, types: 'all' }));
    if (branch.at(-1)?.id !== atEntryId) {
      throw new CogitatorError({
        message: `Entry ${atEntryId} is not in thread ${threadId}`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { threadId, atEntryId },
      });
    }
    if (
      options.newThreadId !== undefined &&
      unwrapMemory(await memory.getThread(options.newThreadId))
    ) {
      throw new CogitatorError({
        message: `Thread ${options.newThreadId} exists already: fork into a new id`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { threadId, newThreadId: options.newThreadId },
      });
    }
    const dryRun = options.dryRun ?? false;
    const readTree = async () => unwrapMemory(await memory.getEntries({ threadId, types: 'all' }));
    if (!options.files) {
      if (dryRun) return { dryRun: true, snapshotsCopied: [], going: [] };
      const at = checkpointAt(branch, branch.length - 1, await readTree());
      const thread = unwrapMemory(
        await forkThread(threadId, atEntryId, options.newThreadId, forkPointMetadata(branch, at))
      );
      return { thread, snapshotsCopied: [] };
    }

    this.refuseFromOwnTool('fork', threadId);
    const releaseThread = await this.threadRuns.lock(threadId);
    let releaseWorkspace: (() => void) | undefined;
    try {
      const files = fileRestorePlan(branch, branch.length - 1, options, await readTree());
      const source = options.source ?? files.workspace;
      const checkpoint = await this.verifyCheckpoint(memory, threadId, {
        ...files,
        workspace: source,
      });
      this.refuseFromOwnTool('fork', threadId, await this.workspaceRuns.active(files.workspace));
      releaseWorkspace = await this.workspaceRuns.lock(files.workspace);

      const target = files.workspace;
      const copied: string[] = [];
      const added: string[] = [];
      const dropAdded = async () => {
        for (const id of added) await target.deleteSnapshot?.(id).catch(() => undefined);
      };
      try {
        if (source !== target) {
          if (!source.copySnapshot) {
            throw new CogitatorError({
              message: `Workspace ${source.id} cannot copy its snapshots into the workspace of the fork`,
              code: ErrorCode.VALIDATION_ERROR,
            });
          }
          const copy = source.copySnapshot.bind(source);
          const listed = await target.listSnapshots?.();
          const had = listed && new Set(listed.map((snapshot) => snapshot.id));
          const wanted = dryRun
            ? [files.at.checkpoint]
            : checkpointsOn(branch, files.at.checkpoint);
          for (const checkpoint of wanted) {
            try {
              await copy(checkpoint.snapshotId, target);
              copied.push(checkpoint.snapshotId);
              if (had && !had.has(checkpoint.snapshotId)) added.push(checkpoint.snapshotId);
            } catch (error) {
              if (checkpoint.snapshotId === files.at.checkpoint.snapshotId) throw error;
              getLogger().warn('A file checkpoint of the forked branch could not be copied', {
                snapshot: checkpoint.snapshotId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (dryRun) {
            copied.push(
              ...checkpointsOn(branch)
                .map((checkpoint) => checkpoint.snapshotId)
                .filter((id) => !copied.includes(id))
            );
          }
        }
        let plan = await files.restore({ dryRun: true });
        const going = await this.goingOn(threadId, target);
        if (dryRun) {
          await dropAdded();
          return { dryRun: true, snapshotsCopied: copied, files: plan, going: going.ids };
        }

        this.refuseBusy('fork', threadId, going, plan, options.force ?? false, true);
        if (going.thread.count > 0 || going.ids.length > 0 || going.tools > 0) {
          await this.stopRuns(threadId, going, `Thread ${threadId} is being forked with its files`);
          await this.awaitTools('fork', threadId, target, options.toolSettleMs ?? TOOL_SETTLE_MS);
          plan = await files.restore({ dryRun: true });
          if (plan.busy) throw workspaceBusy('fork', threadId, plan);
        }
        const safety = await this.takeSafetySnapshot(files, plan, checkpoint, {
          threadId,
          reason: 'fork',
          entryId: atEntryId,
        });
        let thread: Thread;
        try {
          thread = unwrapMemory(
            await forkThread(
              threadId,
              atEntryId,
              options.newThreadId,
              forkPointMetadata(branch, files.at)
            )
          );
        } catch (error) {
          await safety?.drop();
          throw error;
        }
        try {
          const restored = await this.restoreAfterSafety(files, safety);
          return { thread, snapshotsCopied: copied, files: restored };
        } catch (error) {
          await this.unmakeFork(memory, threadId, thread.id);
          throw error;
        }
      } catch (error) {
        await dropAdded();
        throw error;
      }
    } finally {
      releaseWorkspace?.();
      releaseThread();
    }
  }

  /**
   * The threads of the memory a page at a time, as `MemoryAdapter.listThreads` lists them, and by
   * archive state with `archived` (see {@link archiveThread}): `true` for archived threads only,
   * `false` for the others. With `archived: false` a page may hold fewer threads than `limit`, the
   * archived ones left out, and an adapter page holding archived threads only is skipped, so a
   * page comes back empty only at the end of the listing.
   *
   * @throws CogitatorError (`VALIDATION_ERROR`) when no memory is configured, `INTERNAL_ERROR`
   * when the adapter refuses the listing (a bad cursor or limit) or fails
   */
  async listThreads(options: CogitatorListThreadsOptions = {}): Promise<ThreadPage> {
    const memory = await this.threadMemory('listThreads');
    const { archived, ...listing } = options;
    if (archived === undefined) return unwrapMemory(await memory.listThreads(listing));
    if (archived) {
      return unwrapMemory(
        await memory.listThreads({
          ...listing,
          metadata: { ...listing.metadata, [ARCHIVED_KEY]: true },
        })
      );
    }
    let cursor = listing.cursor;
    for (;;) {
      const page = unwrapMemory(
        await memory.listThreads({ ...listing, ...(cursor !== undefined && { cursor }) })
      );
      const threads = page.threads.filter((thread) => !isArchived(thread));
      if (threads.length > 0 || page.nextCursor === undefined) {
        return { threads, ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }) };
      }
      cursor = page.nextCursor;
    }
  }

  /**
   * Archives `threadId`: its metadata gets `archived: true` and `archivedAt` (an ISO time), so
   * `listThreads({ archived: false })` leaves it out. Nothing else changes, the thread can still
   * be read and run on. A thread archived already stays as it is.
   *
   * @throws CogitatorError (`THREAD_BUSY`) while a run of this runtime goes on in the thread,
   * (`VALIDATION_ERROR`) when no memory is configured or the thread does not exist
   */
  async archiveThread(threadId: string): Promise<Thread> {
    return this.setArchived(threadId, true);
  }

  /**
   * Takes `threadId` out of the archive: `archived: false` and `archivedAt: null` in its metadata.
   * A thread not archived stays as it is. Refused as by {@link archiveThread}
   */
  async unarchiveThread(threadId: string): Promise<Thread> {
    return this.setArchived(threadId, false);
  }

  private async setArchived(threadId: string, archived: boolean): Promise<Thread> {
    const method = archived ? 'archiveThread' : 'unarchiveThread';
    const memory = await this.threadMemory(method);
    const releaseThread = await this.threadRuns.lock(threadId);
    try {
      const going = this.threadRuns.active(threadId);
      if (going.count > 0) {
        throw new CogitatorError({
          message: `Thread ${threadId} has a run going on: ${archived ? 'archive' : 'unarchive'} it once the run ends`,
          code: ErrorCode.THREAD_BUSY,
          details: { threadId, runIds: going.runIds },
        });
      }
      const thread = unwrapMemory(await memory.getThread(threadId));
      if (!thread) {
        throw new CogitatorError({
          message: `Thread ${threadId} does not exist`,
          code: ErrorCode.VALIDATION_ERROR,
          details: { threadId },
        });
      }
      if (isArchived(thread) === archived) return thread;
      return unwrapMemory(
        await memory.updateThread(threadId, {
          [ARCHIVED_KEY]: archived,
          [ARCHIVED_AT_KEY]: archived ? new Date().toISOString() : null,
        })
      );
    } finally {
      releaseThread();
    }
  }

  private async threadMemory(method: string): Promise<MemoryAdapter> {
    const memory = await this.getMemory();
    if (!memory) {
      throw new CogitatorError({
        message: `${method} needs memory: set memory.adapter in the Cogitator config`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return memory;
  }

  /**
   * Refuses a rewind or a fork a tool call asked for of a run it would have to stop: one of the
   * thread's runs, or of `inWorkspace` (the runs of the workspace it restores). Stopping that run
   * would wait for the tool call, which waits for the rewind
   */
  private refuseFromOwnTool(
    what: 'rewind' | 'fork',
    threadId: string,
    inWorkspace: readonly WorkspaceRun[] = []
  ): void {
    const callers = currentToolRuns();
    if (callers.length === 0) return;
    const own = [
      ...this.threadRuns.active(threadId).runIds,
      ...inWorkspace.map((run) => run.runId()),
    ];
    const caller = callers.find((runId) => own.includes(runId));
    if (caller === undefined) return;
    throw new CogitatorError({
      message: `A tool of run ${caller} cannot ${what} thread ${threadId}: the ${what} would have to stop that very run. Ask for it after the run ends`,
      code: ErrorCode.VALIDATION_ERROR,
      details: { threadId, runId: caller },
    });
  }

  /**
   * The runs going on that a rewind or a fork with files would race: the runs of the thread
   * here, the runs of this runtime in `workspace` (of any thread), and the durable runs of the
   * thread whose lease is live, here or in another process (`foreign`)
   */
  private async goingOn(threadId: string, workspace: Workspace | undefined): Promise<GoingOn> {
    const thread = this.threadRuns.active(threadId);
    const inWorkspace = workspace
      ? (await this.workspaceRuns.active(workspace)).filter(
          (run) => !thread.runIds.includes(run.runId())
        )
      : [];
    const tools = workspace ? await this.workspaceRuns.toolsInFlight(workspace) : 0;
    const now = Date.now();
    const instance = this.durableHolder.instance;
    const held = (await this.durableStore().list({ threadId })).flatMap((run) =>
      run.lease && (run.lease.expiresAt === undefined || run.lease.expiresAt > now)
        ? [
            {
              runId: run.runId,
              foreign: run.lease.instance !== instance,
              ...(run.lease.expiresAt !== undefined && { expiresAt: run.lease.expiresAt }),
            },
          ]
        : []
    );
    const ids = [
      ...new Set([
        ...thread.runIds,
        ...inWorkspace.map((run) => run.runId()),
        ...held.map((run) => run.runId),
      ]),
    ];
    return { thread, inWorkspace, held, ids, tools };
  }

  /**
   * Refuses a rewind or a fork what `going` and the dry run `plan` say is in the way, unless
   * `force`: a durable run another process holds is never forced while files are restored
   */
  private refuseBusy(
    what: 'rewind' | 'fork',
    threadId: string,
    going: GoingOn,
    plan: WorkspaceRestoreResult | undefined,
    force: boolean,
    files: boolean
  ): void {
    const foreign = going.held.filter((run) => run.foreign);
    if (files && foreign.length > 0) {
      const until = foreign
        .map((run) => run.expiresAt)
        .filter((at): at is number => at !== undefined)
        .sort((a, b) => b - a)[0];
      throw new CogitatorError({
        message: `Thread ${threadId} has a durable run another process holds (${foreign.map((run) => run.runId).join(', ')}), whose tools may still write the files: wait for it to end${until !== undefined ? ` or its lease to run out at ${new Date(until).toISOString()}` : ''}, then ${what} again`,
        code: ErrorCode.THREAD_BUSY,
        details: { threadId, runIds: foreign.map((run) => run.runId) },
      });
    }
    if (force) return;
    if (going.thread.count > 0 || going.held.length > 0) {
      throw new CogitatorError({
        message: `Thread ${threadId} has a run going on: wait for it, or pass force to stop it first`,
        code: ErrorCode.THREAD_BUSY,
        details: { threadId, runIds: going.ids },
      });
    }
    if (going.inWorkspace.length > 0) {
      const runIds = going.inWorkspace.map((run) => run.runId());
      throw new CogitatorError({
        message: `Other runs work in the workspace the ${what} would restore (${runIds.join(', ')}): wait for them, or pass force to stop them first`,
        code: ErrorCode.WORKSPACE_BUSY,
        details: { threadId, runIds },
      });
    }
    if (files && going.tools > 0) throw toolsBusy(what, threadId, going.tools);
    if (plan?.busy) throw workspaceBusy(what, threadId, plan);
  }

  /**
   * Waits until the tool executions in `workspace` settled, those of runs a forced rewind or fork
   * stopped included: a tool that goes on regardless of its signal may still write the files.
   * Refuses with `WORKSPACE_BUSY` when some still run after `timeoutMs`
   */
  private async awaitTools(
    what: 'rewind' | 'fork',
    threadId: string,
    workspace: Workspace,
    timeoutMs: number
  ): Promise<void> {
    if (await this.workspaceRuns.toolsSettled(workspace, timeoutMs)) return;
    throw toolsBusy(what, threadId, await this.workspaceRuns.toolsInFlight(workspace));
  }

  /**
   * Stops what `going` lists before a forced rewind or fork: the thread's runs here, the runs of
   * other threads in the workspace, and the records of the thread's durable runs (whose holder
   * loses them and stops at its next step). Resolves once the runs here are done
   */
  private async stopRuns(
    threadId: string,
    going: GoingOn,
    message: string
  ): Promise<{ interrupted: string[]; durable: string[] }> {
    const reason = new CogitatorError({
      message,
      code: ErrorCode.RUN_INTERRUPTED,
      details: { threadId },
    });
    const interrupted =
      going.thread.count > 0 ? await this.threadRuns.interrupt(threadId, reason) : [];
    for (const run of going.inWorkspace) run.abort(reason);
    await Promise.all(going.inWorkspace.map((run) => run.done));
    interrupted.push(...going.inWorkspace.map((run) => run.runId()));
    const durable: string[] = [];
    const store = this.durableStore();
    for (const run of await store.list({ threadId })) {
      if (!going.held.some((held) => held.runId === run.runId)) continue;
      await store.delete(run);
      durable.push(run.runId);
    }
    return { interrupted: [...new Set(interrupted)], durable };
  }

  /**
   * Checks the checkpoint a file restore takes against the workspace it restores from: the
   * workspace keeps that snapshot, taken in this thread (or a thread it was forked from) before
   * this entry (or the entry it was copied from), so a checkpoint reference forged into an
   * entry's metadata cannot bring another thread's files
   */
  private async verifyCheckpoint(
    memory: MemoryAdapter,
    threadId: string,
    files: Pick<FileRestorePlan, 'at' | 'workspace'>
  ): Promise<WorkspaceSnapshot> {
    const { at, workspace } = files;
    const snapshotId = at.checkpoint.snapshotId;
    const list = workspace.listSnapshots?.bind(workspace);
    if (!list) {
      throw new CogitatorError({
        message: `Workspace ${workspace.id} cannot list its snapshots, so checkpoint ${snapshotId} cannot be checked before it is restored`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const record = (await list()).find((snapshot) => snapshot.id === snapshotId);
    if (!record) {
      throw new CogitatorError({
        message: `Workspace ${workspace.id} (${workspace.root}) does not keep checkpoint ${snapshotId}, which was taken in workspace ${at.checkpoint.workspaceId} (${at.checkpoint.root}): pass the workspace the thread ran in`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { snapshotId },
      });
    }
    const threads = new Set<string>();
    for (
      let id: string | undefined = threadId, hops = 0;
      id !== undefined && !threads.has(id) && hops < LINEAGE_HOPS;
      hops++
    ) {
      threads.add(id);
      const thread: Thread | null = unwrapMemory(await memory.getThread(id));
      const from: unknown = thread?.metadata.forkedFrom;
      id =
        typeof from === 'object' &&
        from !== null &&
        'threadId' in from &&
        typeof from.threadId === 'string'
          ? from.threadId
          : undefined;
    }
    const entries = new Set<string>();
    for (
      let id: string | undefined = at.entryId, hops = 0;
      id !== undefined && !entries.has(id) && hops < LINEAGE_HOPS;
      hops++
    ) {
      entries.add(id);
      const entry: MemoryEntry | null = unwrapMemory(await memory.getEntry(id));
      const forkOf: unknown = entry?.metadata?.forkOf;
      id = typeof forkOf === 'string' ? forkOf : undefined;
    }
    const tookIn = record.metadata?.threadId;
    const tookAt = record.metadata?.entryId ?? record.label;
    if (
      typeof tookIn !== 'string' ||
      typeof tookAt !== 'string' ||
      !threads.has(tookIn) ||
      !entries.has(tookAt)
    ) {
      throw new CogitatorError({
        message: `Checkpoint ${snapshotId} was not taken for entry ${at.entryId} of thread ${threadId}: it is not restored`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { snapshotId, threadId, entryId: at.entryId },
      });
    }
    return record;
  }

  /**
   * Restores the files of `files`, after a snapshot of them as they are when the restore changes
   * anything and the workspace can snapshot, named in the report to undo it. The safety snapshot
   * covers every path the restore changes or deletes: it leaves out only what the checkpoint
   * `target` left out (which the restore never touches), keeps files as large as the largest one
   * the restore rewrites or deletes, and keeps a retention of the workspace from pruning `target`
   * before it is restored. A restore that would change a path the safety snapshot could not keep
   * (one it skipped, or one the workspace's own snapshot excludes leave out) is refused with
   * `DENIED` before anything changes, as it could not be undone
   */
  private async restoreWithSafety(
    files: FileRestorePlan,
    plan: WorkspaceRestoreResult,
    target: WorkspaceSnapshot,
    place: { threadId: string; reason: 'rewind' | 'fork'; entryId: string }
  ): Promise<FileRewindReport> {
    const safety = await this.takeSafetySnapshot(files, plan, target, place);
    return this.restoreAfterSafety(files, safety);
  }

  /**
   * The safety snapshot of {@link restoreWithSafety}, taken and checked: undefined when the
   * restore changes nothing or the workspace cannot snapshot, refused with `DENIED` (the snapshot
   * deleted) when it could not keep a path the restore changes
   */
  private async takeSafetySnapshot(
    files: FileRestorePlan,
    plan: WorkspaceRestoreResult,
    target: WorkspaceSnapshot,
    place: { threadId: string; reason: 'rewind' | 'fork'; entryId: string }
  ): Promise<{ id: string; drop(): Promise<void> } | undefined> {
    const { workspace } = files;
    const changed = [...plan.restored, ...plan.deleted];
    if (changed.length === 0 || !workspace.snapshot) return undefined;
    let largest = target.maxFileBytes ?? WORKSPACE_SNAPSHOT_MAX_FILE_BYTES;
    for (const path of changed) {
      const info = await workspace.stat(path).catch(() => undefined);
      if (info?.type === 'file' && info.size > largest) largest = info.size;
    }
    const safety = await workspace.snapshot({
      label: `before-${place.reason}`,
      exclude: target.exclude,
      maxFileBytes: largest,
      protect: [target.id],
      metadata: { ...place, safety: true },
    });
    const drop = async () => {
      await workspace.deleteSnapshot?.(safety.id).catch(() => undefined);
    };
    const unread = (safety.skipped ?? [])
      .map((skip) => skip.path)
      .filter((path) => changed.some((each) => each === path || each.startsWith(`${path}/`)));
    const leftOut = changed.filter(leavesOut(safety.exclude));
    if (unread.length > 0 || leftOut.length > 0) {
      await drop();
      const why = [
        unread.length > 0 &&
          `${unread.join(', ')}, which it could not read (unreadable, hard links the workspace refuses, too large or changing)`,
        leftOut.length > 0 &&
          `${leftOut.join(', ')}, which the workspace's own snapshot excludes leave out`,
      ]
        .filter((part): part is string => typeof part === 'string')
        .join(', and ');
      throw new WorkspaceError(
        'DENIED',
        `The ${place.reason} would change files the snapshot taken first could not keep to undo it: ${why}. Move them away or change what the workspace leaves out, then ${place.reason} again`,
        { path: [...unread, ...leftOut][0] }
      );
    }
    return { id: safety.id, drop };
  }

  /**
   * Restores the files of `files` once `safety` is taken. A restore that fails keeps the safety
   * snapshot to undo what it changed, unless the files are still those the snapshot holds (a dry
   * run of it changes nothing): one refused before it changed anything drops it, whatever the
   * error says
   */
  private async restoreAfterSafety(
    files: FileRestorePlan,
    safety: { id: string; drop(): Promise<void> } | undefined
  ): Promise<FileRewindReport> {
    try {
      const restored = await files.restore();
      return { ...restored, ...(safety && { safetySnapshotId: safety.id }) };
    } catch (error) {
      if (safety && (await this.unchangedSince(files.workspace, safety.id))) await safety.drop();
      else if (safety) {
        getLogger().warn(
          'A file restore failed on the way, the files as they were before it are in the safety snapshot',
          {
            workspace: files.workspace.id,
            snapshot: safety.id,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
      throw error;
    }
  }

  /** Whether the files of `workspace` are those snapshot `snapshotId` holds, false when unsure */
  private async unchangedSince(workspace: Workspace, snapshotId: string): Promise<boolean> {
    const restore = workspace.restore?.bind(workspace);
    if (!restore) return false;
    try {
      const plan = await restore(snapshotId, { dryRun: true });
      return plan.restored.length === 0 && plan.deleted.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Takes back a fork whose files could not be restored: deletes thread `forkId` and the note of
   * it in the metadata of `threadId`, so a failed fork leaves no thread behind
   */
  private async unmakeFork(memory: MemoryAdapter, threadId: string, forkId: string): Promise<void> {
    try {
      unwrapMemory(await memory.deleteThread(forkId));
      const source = unwrapMemory(await memory.getThread(threadId));
      const known: unknown = source?.metadata[FORKS_KEY];
      if (Array.isArray(known) && known.includes(forkId)) {
        unwrapMemory(
          await memory.updateThread(threadId, {
            [FORKS_KEY]: known.filter((id) => id !== forkId),
          })
        );
      }
    } catch (error) {
      getLogger().warn('A fork whose files could not be restored could not be taken back', {
        threadId,
        fork: forkId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
   * Drops what runs of `threadIds` kept of their conversation outside the thread, after a forget,
   * a redaction or a rewind there: the paused run, and every durable run, whose checkpoint may
   * hold the text that is gone (a durable run going on loses its lease and stops)
   */
  private async dropPausedRuns(
    threadIds: readonly string[]
  ): Promise<{ paused: string[]; durable: string[] }> {
    const store = this.runCheckpointStore();
    const durable = this.durableStore();
    const dropped: { paused: string[]; durable: string[] } = { paused: [], durable: [] };
    for (const threadId of new Set(threadIds)) {
      if (await store.load(threadId)) {
        await store.delete(threadId);
        dropped.paused.push(threadId);
      }
      for (const run of await durable.list({ threadId })) {
        await durable.delete(run);
        dropped.durable.push(run.runId);
      }
    }
    return dropped;
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
    await this.triggerManager?.stop();
    LIVE_INSTANCES.delete(this.durableHolder.instance);
    await this.pluginHost.dispose();
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
type RecoverArgs<TDeps> = unknown extends TDeps
  ? [options?: RecoverRunOptions<TDeps>]
  : [options: RecoverRunOptions<TDeps> & { deps: TDeps }];

type ResumeArgs<TDeps> = unknown extends TDeps
  ? [options?: ResumeOptions]
  : [options: ResumeOptions<TDeps> & { deps: TDeps }];

/** The thread metadata key `archiveThread()` sets, which `listThreads({ archived })` reads */
const ARCHIVED_KEY = 'archived';
const ARCHIVED_AT_KEY = 'archivedAt';

function isArchived(thread: Thread): boolean {
  return thread.metadata[ARCHIVED_KEY] === true;
}

/** The options of `startResume()`, see {@link ResumeArgs} */
type StartResumeArgs<TDeps> = unknown extends TDeps
  ? [options?: StartResumeOptions]
  : [options: StartResumeOptions<TDeps> & { deps: TDeps }];

/**
 * The run options and the resume a resumed run launches with: from `target`, a checkpoint or the
 * thread whose paused run goes on, and the decisions and answers of `options`
 *
 * @throws CogitatorError (`VALIDATION_ERROR`) for a durable run left running, which
 * `recoverRun()` continues, or a checkpoint version this runtime cannot read
 */
function resumeLaunch(
  target: RunCheckpoint | string,
  options: ResumeOptions
): { options: RunOptions; from: ResumeFrom } {
  if (typeof target !== 'string' && target.status === 'running') {
    throw new CogitatorError({
      message: `Run ${target.runId} did not pause: it is a durable run left running, recover it with recoverRun()`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  if (typeof target !== 'string' && target.version !== 1) {
    throw new CogitatorError({
      message: `Unsupported run checkpoint version: ${String(target.version)}`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  const { decisions = {}, defaultDecision, responses, userId, ...rest } = options;
  const threadId = typeof target === 'string' ? target : target.threadId;
  return {
    options: { ...rest, input: '', threadId, ...(userId !== undefined && { userId }) },
    from: {
      ...(typeof target === 'string' ? {} : { checkpoint: target }),
      decisions,
      ...(defaultDecision && { defaultDecision }),
      ...(responses && { responses }),
      checkUser: typeof target === 'string' || userId !== undefined,
    },
  };
}

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
  /** Calls the rules or the mode allowed, not a person */
  automatic?: string[];
  /** Approvals asked for the arguments a middleware changed calls to */
  changed?: ToolApprovalRequest[];
  /** Calls of `changed` asked for as they started, after the `beforeToolCall` middleware */
  admitted?: string[];
  /** What the calls that ran before the pause returned, by call id */
  results?: Record<
    string,
    { result: unknown; error?: string; arguments?: Record<string, unknown> }
  >;
  pending: ToolApprovalRequest[];
  /** What the turn waits on: its approvals, or the questions its tools asked and their answers */
  interrupts: RunInterrupt[];
  /** Calls of the turn that already ran */
  completed: string[];
  /** Delegates that paused with their interrupts bubbling up, by the tool call that started each */
  children?: Record<string, RunCheckpoint>;
}

/** What a resumed run goes on with */
interface ResumeFrom {
  checkpoint?: RunCheckpoint;
  decisions: Record<string, ToolApprovalDecision>;
  defaultDecision?: ToolApprovalDecision;
  responses?: Record<string, unknown>;
  checkUser: boolean;
  /** A durable run recovered after its process stopped, see `Cogitator.recoverRun` */
  recovered?: RecoveredFrom;
}

/** A durable run taken back by `recoverRun()`, handed to the run that goes on with it */
interface RecoveredFrom extends Pick<RebuiltRun, 'repairs' | 'answered'> {
  /** When the checkpoint it goes on from was saved: the run stops if the store has another one */
  savedAt: number;
  /** Set once the run started: from then on it lets the run go itself */
  entered: boolean;
  /** Stops renewing the lease taken at recovery, once the run's own keeper holds it */
  stopHolding: () => void;
  /** Lets the run go: its reservation, the renewal and the lease */
  release: () => Promise<void>;
}

/** Fails a run whose own `runId` cannot name a run */
function assertRunId(runId: string): void {
  if (/^[\w.:-]{1,200}$/.test(runId)) return;
  throw new CogitatorError({
    message: `runId must be 1 to 200 letters, digits, '_', '.', ':' or '-', got ${JSON.stringify(runId)}`,
    code: ErrorCode.VALIDATION_ERROR,
  });
}

/** The durable instances of the runtimes of this process, see `DurableRunHolder.instance` */
const LIVE_INSTANCES = new Set<string>();

/** `messages` of `queue` with the ids it gave them, for a durable run's store */
function withQueueIds(
  queue: RunQueue,
  messages: readonly QueuedRunMessage[]
): DurableQueuedMessage[] {
  return messages.map((message) => {
    const id = queue.idOf(message);
    return { ...message, ...(id !== undefined && { id }) };
  });
}

/** Whether another process took a durable run over, see `ErrorCode.RUN_LEASED` */
function isLeaseLoss(reason: unknown): boolean {
  return reason instanceof CogitatorError && reason.code === ErrorCode.RUN_LEASED;
}

/** Whether a run stopped to be handed over to another process, see `ErrorCode.RUN_SUSPENDED` */
function isSuspension(reason: unknown): boolean {
  return reason instanceof CogitatorError && reason.code === ErrorCode.RUN_SUSPENDED;
}

/** How a run is steered from outside: its queued messages and its seat on its thread */
interface RunControl {
  /** The command its input named, expanded */
  command?: ExpandedCommand;
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
  | { result: ToolResult; interrupt?: undefined; nested?: undefined }
  | {
      result?: undefined;
      interrupt: RunInterrupt;
      /** A delegate of the call that paused, its interrupts and approvals under the call's id */
      nested?: {
        checkpoint: RunCheckpoint;
        interrupts: RunInterrupt[];
        pending: ToolApprovalRequest[];
      };
    }
);

/** Whether `entry` is an interrupt of a paused delegate of one of `children`'s calls */
function isNestedInterrupt(
  entry: RunInterrupt,
  children: ReadonlyMap<string, unknown> | undefined
): boolean {
  if (!children) return false;
  for (const id of children.keys()) {
    if (entry.id.startsWith(`${id}/`)) return true;
  }
  return false;
}

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
