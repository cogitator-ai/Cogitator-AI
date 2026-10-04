import { nanoid } from 'nanoid';
import type {
  CogitatorConfig,
  RunOptions,
  RunResult,
  Message,
  ToolCall,
  ToolResult,
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
  HandoffEvent,
  ResumeOptions,
  RunCheckpoint,
  RunCheckpointStore,
  RunPrompt,
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import { type Agent } from './agent';
import { ToolRegistry } from './registry';
import { createLLMBackend } from './llm/index';
import { isLLMProvider } from './llm/providers';
import { createLLMBackendFromPlugin, hasLLMPlugin } from './llm/plugin';
import { withLLMRetry } from './llm/retry';
import { PiiMasker, withPiiMasking } from './security/pii';
import { createLoggerFromConfig, getLogger, setLogger } from './logger';
import { RunCostMeter } from './cogitator/run-cost';
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
} from './cogitator/initializers';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import {
  buildInitialMessages,
  buildInputWithAudio,
  saveEntry,
  enrichMessagesWithInsights,
  addContextToMessages,
} from './cogitator/message-builder';
import { createSpan, getTextContent } from './cogitator/span-factory';
import { executeTool, createToolMessage } from './cogitator/tool-executor';
import { streamChat } from './cogitator/streaming';
import { RunLimiter } from './cogitator/run-limiter';
import { findHandoffAgent, handoffTools } from './cogitator/handoffs';
import { PromptRegistry } from './cogitator/prompts';
import { InMemoryRunCheckpointStore, ThreadRunCheckpointStore } from './cogitator/run-checkpoints';
import {
  parseStructuredOutput,
  structuredOutputProblem,
  toLLMResponseFormat,
} from './cogitator/response-format';
import { CostEstimator } from './cost-routing/cost-estimator';
import { readEnv } from './utils/env';

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
export class Cogitator {
  private config: CogitatorConfig;
  private backends = new Map<string, LLMBackend>();
  private processCheckpoints?: InMemoryRunCheckpointStore;
  private promptRegistry?: PromptRegistry;
  private threadCheckpoints?: { memory: MemoryAdapter; store: ThreadRunCheckpointStore };
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
    this.config = config;
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
  async run(agent: Agent, options: RunOptions): Promise<RunResult> {
    return this.execute(agent, options);
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
  async resume(
    agent: Agent,
    target: RunCheckpoint | string,
    options: ResumeOptions = {}
  ): Promise<RunResult> {
    if (typeof target !== 'string' && target.version !== 1) {
      throw new CogitatorError({
        message: `Unsupported run checkpoint version: ${String(target.version)}`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const { decisions = {}, defaultDecision, userId, ...rest } = options;
    const threadId = typeof target === 'string' ? target : target.threadId;
    return this.execute(
      agent,
      { ...rest, input: '', threadId, ...(userId !== undefined && { userId }) },
      {
        ...(typeof target === 'string' ? {} : { checkpoint: target }),
        decisions,
        ...(defaultDecision && { defaultDecision }),
        checkUser: typeof target === 'string' || userId !== undefined,
      }
    );
  }

  private async execute(
    agent: Agent,
    options: RunOptions,
    resumeFrom?: {
      checkpoint?: RunCheckpoint;
      decisions: Record<string, ToolApprovalDecision>;
      defaultDecision?: ToolApprovalDecision;
      checkUser: boolean;
    }
  ): Promise<RunResult> {
    let checkpoint = resumeFrom?.checkpoint;
    let prompt: RunPrompt | undefined;
    let runId = checkpoint?.runId ?? `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const traceId = `trace_${nanoid(16)}`;
    const startTime = Date.now();
    const spans: Span[] = [];

    const timeout =
      options.timeout ??
      agent.config?.timeout ??
      this.config.limits?.defaultTimeout ??
      DEFAULT_RUN_TIMEOUT;
    const abortController = new AbortController();
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

    if (timeout && timeout > 0 && timeout <= MAX_TIMER_DELAY_MS) {
      timeoutId = setTimeout(() => {
        abortController.abort(
          new CogitatorError({
            message: `Run timed out after ${timeout}ms`,
            code: ErrorCode.RUN_TIMEOUT,
            details: { timeout },
          })
        );
      }, timeout);
    }

    const rootSpanId = `span_${nanoid(12)}`;
    let releaseRunSlot: (() => void) | undefined;

    try {
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
        runId = checkpoint.runId;
        options = { ...options, userId: checkpoint.userId };
      }

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

      const buildRegistry = (owner: Agent) => {
        const ownerRegistry = new ToolRegistry();
        ownerRegistry.registerMany(this.tools.getAll());
        if (owner.tools.length > 0) ownerRegistry.registerMany(owner.tools);
        const handoff = handoffTools(owner);
        ownerRegistry.registerMany(handoff.tools);
        return { registry: ownerRegistry, targets: handoff.targets };
      };
      let { registry, targets: handoffTargets } = buildRegistry(active);

      let effectiveModel = agentModel;
      let routeProvider = agent.config.provider;
      let backend: LLMBackend;
      let model: string;
      let input: string;
      let messages: Message[];

      if (checkpoint) {
        input = checkpoint.input;
        effectiveModel = checkpoint.model;
        routeProvider = checkpoint.provider;
        ({ backend, model } = this.route(effectiveModel, routeProvider));
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
        ({ backend, model } = this.route(effectiveModel, routeProvider));

        if (costRouter) {
          const budgetCheck = recommendation
            ? costRouter.checkBudget(recommendation.estimatedCost)
            : costRouter.checkRunBudget(input, model);
          if (!budgetCheck.allowed) {
            throw new CogitatorError({
              message: `Budget exceeded: ${budgetCheck.reason}`,
              code: ErrorCode.BUDGET_EXCEEDED,
            });
          }
        }

        await this.abandonPausedRun(agent, runOptions, threadId);
        messages = await this.prepareMessages(agent, runOptions, input, threadId);
      }

      const allToolCalls: ToolCall[] = [...(checkpoint?.toolCalls ?? [])];
      let totalInputTokens = checkpoint?.usage.inputTokens ?? 0;
      let totalOutputTokens = checkpoint?.usage.outputTokens ?? 0;
      let cachedInputTokens = checkpoint?.usage.cachedInputTokens ?? 0;
      let cacheWriteTokens = checkpoint?.usage.cacheWriteTokens ?? 0;
      let reasoningTokens = checkpoint?.usage.reasoningTokens ?? 0;
      const costMeter = new RunCostMeter(checkpoint?.usage.cost, checkpoint?.usage);
      const reasoningParts: string[] = [...(checkpoint?.reasoning ?? [])];
      let reasoning = options.reasoning ?? active.config.reasoning;
      const promptCache = this.config.llm?.promptCache ?? {};
      let iterations = checkpoint?.iterations ?? 0;
      const maxIterations = agent.config?.maxIterations ?? 10;
      const answerAtLimit = (agent.config?.onIterationLimit ?? 'answer') === 'answer';
      let closingTurn = false;
      let iterationLimitReached = false;
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

      const switchTo = (target: Agent, reason: unknown) => {
        const event: HandoffEvent = {
          from: active.name,
          to: target.name,
          ...(typeof reason === 'string' && reason && { reason }),
        };
        handoffs.push(event);
        options.onHandoff?.(event);
        const system = messages[0];
        const content =
          system?.role === 'system' &&
          typeof system.content === 'string' &&
          system.content.startsWith(active.instructions)
            ? target.instructions + system.content.slice(active.instructions.length)
            : target.instructions;
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
        ({ registry, targets: handoffTargets } = buildRegistry(target));
        effectiveModel = this.resolveModel(target);
        routeProvider = target.config.provider;
        ({ backend, model } = this.route(effectiveModel, routeProvider));
        reasoning = options.reasoning ?? target.config.reasoning;
        responseFormat = toLLMResponseFormat(target.config.responseFormat);
        lastToolCallSig = '';
      };

      const handleToolTurn = async (
        toolCalls: ToolCall[],
        resumed?: {
          decisions: Record<string, ToolApprovalDecision>;
          fallback?: ToolApprovalDecision;
        }
      ): Promise<PausedTurn | undefined> => {
        if (!resumed) {
          const currentSig = toolCalls
            .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
            .join('|');
          if (currentSig === lastToolCallSig) {
            for (const tc of toolCalls) {
              const errorResult: ToolResult = {
                callId: tc.id,
                name: tc.name,
                result: null,
                error: 'Duplicate tool call detected. Try a different approach.',
              };
              const duplicateMessage = createToolMessage(tc, errorResult);
              messages.push(duplicateMessage);
              if (
                this.state.memoryAdapter &&
                options.saveHistory !== false &&
                options.useMemory !== false
              ) {
                await saveEntry(
                  threadId,
                  active.id,
                  duplicateMessage,
                  this.state.memoryAdapter,
                  undefined,
                  [errorResult],
                  options.onMemoryError,
                  options.userId
                );
              }
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
        const pending: ToolApprovalRequest[] = [];
        for (const toolCall of toolCalls) {
          const tool = registry.get(toolCall.name);
          if (
            !tool ||
            decisions.has(toolCall.id) ||
            !(
              needsApproval(tool, toolCall.arguments) ||
              this.state.constitutionalAI?.toolNeedsApproval(tool, toolCall.arguments)
            )
          ) {
            continue;
          }
          const request: ToolApprovalRequest = {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            description: tool.description,
            ...(tool.sideEffects && { sideEffects: [...tool.sideEffects] }),
          };
          const decision = resumed?.fallback ?? (await this.decideApproval(request, options));
          if (decision === 'pause') pending.push(request);
          else decisions.set(toolCall.id, decision);
        }
        if (pending.length > 0) {
          return { toolCalls, decisions: Object.fromEntries(decisions), pending };
        }
        if (resumed) await this.runCheckpointStore().delete(threadId);

        const executeToolCall = async (toolCall: ToolCall) => {
          const toolSpanStart = Date.now();
          const decision = decisions.get(toolCall.id);
          if (decision?.approved === false) {
            const declined: ToolResult = {
              callId: toolCall.id,
              name: toolCall.name,
              result: null,
              error: `The user declined this tool call${decision.reason ? `: ${decision.reason}` : ''}`,
            };
            return { toolCall, result: declined, toolSpanStart, toolSpanEnd: Date.now() };
          }
          const result = await waitForAbortable(
            executeTool(
              registry,
              toolCall,
              runId,
              active.id,
              this.state.sandboxManager,
              this.state.constitutionalAI,
              this.state.constitutionalAI?.config.filterToolCalls ?? false,
              () => initializeSandbox(this.config, this.state),
              abortController.signal,
              {
                threadId,
                userId: options.userId,
                channelType: options.channelType,
                channelId: options.channelId,
              },
              decision?.approved === true,
              this.config.sandbox?.allowNativeFallback !== false
            ),
            abortController.signal
          );
          const toolSpanEnd = Date.now();
          return { toolCall, result, toolSpanStart, toolSpanEnd };
        };

        const toolResults = options.parallelToolCalls
          ? await Promise.all(toolCalls.map(executeToolCall))
          : await (async () => {
              const results: Awaited<ReturnType<typeof executeToolCall>>[] = [];
              for (const toolCall of toolCalls) {
                results.push(await executeToolCall(toolCall));
              }
              return results;
            })();

        const reflectionMessages: Message[] = [];

        for (const { toolCall, result, toolSpanStart, toolSpanEnd } of toolResults) {
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
            },
            result.error ? 'error' : 'ok',
            'internal',
            options.onSpan
          );
          spans.push(toolSpan);

          options.onToolResult?.(result);

          const toolMessage = createToolMessage(toolCall, result);
          messages.push(toolMessage);

          if (
            this.state.memoryAdapter &&
            options.saveHistory !== false &&
            options.useMemory !== false
          ) {
            await saveEntry(
              threadId,
              active.id,
              toolMessage,
              this.state.memoryAdapter,
              undefined,
              [result],
              options.onMemoryError,
              options.userId
            );
          }

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
        const handoff = toolCalls.find((call) => handoffTargets.has(call.name));
        const target = handoff && handoffTargets.get(handoff.name);
        if (handoff && target) switchTo(target, handoff.arguments.reason);
        return undefined;
      };

      if (checkpoint && resumeFrom) {
        pausedTurn = await handleToolTurn(checkpoint.turn.toolCalls, {
          decisions: { ...checkpoint.turn.decisions, ...resumeFrom.decisions },
          fallback: resumeFrom.defaultDecision,
        });
      }

      const streaming = Boolean(options.stream && (options.onToken ?? options.onReasoning));
      const onToken = options.onToken ?? (() => undefined);
      let structuredRepaired = false;
      let emptyAnswerRetries = 0;

      while (!pausedTurn && (iterations < maxIterations || closingTurn)) {
        throwIfAborted(abortController.signal);
        this.assertTokenBudget(totalInputTokens + totalOutputTokens);

        if (this.state.contextManager?.shouldCompress(messages, effectiveModel)) {
          const compressionResult = await this.state.contextManager.compress(
            messages,
            effectiveModel
          );
          messages.length = 0;
          messages.push(...compressionResult.messages);
        }

        iterations++;
        agentContext.iterationIndex = iterations - 1;
        agentContext.previousActions = [...allActions];

        const llmSpanStart = Date.now();

        let response;
        if (streaming) {
          response = await waitForAbortable(
            streamChat(
              backend,
              model,
              messages,
              registry,
              active,
              onToken,
              abortController.signal,
              responseFormat,
              {
                reasoning,
                cache: promptCache,
                onReasoning: options.onReasoning,
                ...(closingTurn && { toolChoice: 'none' as const }),
              }
            ),
            abortController.signal
          );
        } else {
          response = await waitForAbortable(
            backend.chat({
              model,
              messages,
              tools: registry.getSchemas(),
              ...(closingTurn && { toolChoice: 'none' as const }),
              temperature: active.config.temperature,
              topP: active.config.topP,
              maxTokens: active.config.maxTokens,
              stop: active.config.stopSequences,
              responseFormat,
              reasoning,
              cache: promptCache,
              signal: abortController.signal,
            }),
            abortController.signal
          );
        }

        const llmSpan = createSpan(
          'llm.chat',
          traceId,
          rootSpanId,
          llmSpanStart,
          Date.now(),
          {
            'llm.model': model,
            'llm.iteration': iterations,
            'llm.input_tokens': response.usage.inputTokens,
            'llm.output_tokens': response.usage.outputTokens,
            ...(response.usage.cachedInputTokens && {
              'llm.cached_input_tokens': response.usage.cachedInputTokens,
            }),
            ...(response.usage.reasoningTokens && {
              'llm.reasoning_tokens': response.usage.reasoningTokens,
            }),
            'llm.finish_reason': response.finishReason,
          },
          'ok',
          'client',
          options.onSpan
        );
        spans.push(llmSpan);

        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;
        cachedInputTokens += response.usage.cachedInputTokens ?? 0;
        cacheWriteTokens += response.usage.cacheWriteTokens ?? 0;
        reasoningTokens += response.usage.reasoningTokens ?? 0;
        costMeter.add(response.usage);
        if (response.reasoning) reasoningParts.push(response.reasoning);

        if (
          isEmptyAnswer(response) &&
          emptyAnswerRetries < MAX_EMPTY_ANSWER_RETRIES &&
          iterations < maxIterations
        ) {
          emptyAnswerRetries++;
          getLogger().warn('Model returned an empty answer, asking again', {
            model,
            iteration: iterations,
            attempt: emptyAnswerRetries,
          });
          continue;
        }

        let outputContent = response.content;

        if (this.state.constitutionalAI?.config.filterOutput) {
          const outputResult = await this.state.constitutionalAI.filterOutput(
            outputContent,
            messages
          );
          if (!outputResult.allowed) {
            if (outputResult.suggestedRevision) {
              outputContent = outputResult.suggestedRevision;
            } else {
              throw new CogitatorError({
                message: `Output blocked: ${outputResult.blockedReason ?? 'Policy violation'}`,
                code: ErrorCode.LLM_CONTENT_FILTERED,
                details: { harmScores: outputResult.harmScores },
              });
            }
          }
        }

        const requestsTools = !closingTurn && Boolean(response.toolCalls?.length);
        const assistantMessage = requestsTools
          ? ({
              role: 'assistant',
              content: outputContent,
              toolCalls: response.toolCalls,
            } as Message & { toolCalls: ToolCall[] })
          : ({ role: 'assistant', content: outputContent } as Message);
        messages.push(assistantMessage);

        const finalAnswer = !(requestsTools && response.finishReason === 'tool_calls');
        const structuredProblem =
          finalAnswer && !streaming && !structuredRepaired && iterations < maxIterations
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

        if (
          this.state.memoryAdapter &&
          options.saveHistory !== false &&
          options.useMemory !== false
        ) {
          await saveEntry(
            threadId,
            active.id,
            assistantMessage,
            this.state.memoryAdapter,
            requestsTools ? response.toolCalls : undefined,
            undefined,
            options.onMemoryError,
            options.userId
          );
        }

        if (finalAnswer || !response.toolCalls) break;
        pausedTurn = await handleToolTurn(response.toolCalls);
        if (pausedTurn) break;

        if (iterations >= maxIterations) {
          iterationLimitReached = true;
          if (!answerAtLimit) break;
          closingTurn = true;
          messages.push({ role: 'user', content: ITERATION_LIMIT_PROMPT });
        }
      }

      if (pausedTurn) {
        const pausedCheckpoint: RunCheckpoint = {
          version: 1,
          runId,
          agentId: active.id,
          threadId,
          ...(options.userId !== undefined && { userId: options.userId }),
          model: effectiveModel,
          ...(routeProvider !== undefined && { provider: routeProvider }),
          input,
          messages,
          toolCalls: allToolCalls,
          ...(prompt && { prompt }),
          ...(active !== agent && { activeAgent: active.name }),
          ...(handoffs.length > 0 && { handoffs }),
          turn: { toolCalls: pausedTurn.toolCalls, decisions: pausedTurn.decisions },
          iterations,
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
        };
        const paused: RunResult = {
          output: getTextContent(messages[messages.length - 1]?.content ?? ''),
          runId,
          agentId: agent.id,
          threadId,
          status: 'paused',
          pendingApprovals: pausedTurn.pending,
          ...(handoffs.length > 0 && { handoffs, finalAgent: active.name }),
          checkpoint: pausedCheckpoint,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            cost: costMeter.total(effectiveModel),
            duration: Date.now() - startTime,
          },
          ...(reasoningParts.length > 0 && { reasoning: reasoningParts.join('\n\n') }),
          toolCalls: allToolCalls,
          messages,
          trace: { traceId, spans },
        };
        await this.runCheckpointStore().save(pausedCheckpoint);
        options.onRunComplete?.(paused);
        return paused;
      }

      const endTime = Date.now();
      const lastAssistantMessage = messages.filter((m) => m.role === 'assistant').pop();
      const finalOutput = lastAssistantMessage ? getTextContent(lastAssistantMessage.content) : '';
      const structured = parseStructuredOutput(active.config.responseFormat, finalOutput);

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
        undefined,
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
        },
        'ok',
        'server',
        options.onSpan,
        rootSpanId
      );
      spans.unshift(rootSpan);

      const runCost = costMeter.total(effectiveModel);

      if (this.state.costRouter) {
        this.state.costRouter.recordCost({
          runId,
          agentId: agent.id,
          threadId,
          model: effectiveModel,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cost: runCost,
        });
      }

      const result: RunResult = {
        output: finalOutput,
        ...(structured !== undefined && { structured }),
        status: 'completed',
        ...(iterationLimitReached && { iterationLimitReached: true }),
        ...(prompt && { prompt }),
        ...(handoffs.length > 0 && { handoffs, finalAgent: active.name }),
        runId,
        agentId: agent.id,
        threadId,
        modelUsed: this.config.costRouting?.enabled ? effectiveModel : undefined,
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
        toolCalls: allToolCalls,
        messages,
        trace: {
          traceId,
          spans,
        },
        reflections: allReflections.length > 0 ? allReflections : undefined,
        reflectionSummary: this.state.reflectionEngine
          ? await this.state.reflectionEngine.getSummary(agent.id)
          : undefined,
      };

      if (prompt) await this.recordPrompt(prompt, result, Date.now() - startTime);

      options.onRunComplete?.(result);

      return result;
    } catch (error) {
      if (prompt) await this.recordPrompt(prompt, undefined, Date.now() - startTime);
      const endTime = Date.now();

      const errorSpan = createSpan(
        'agent.run',
        traceId,
        undefined,
        startTime,
        endTime,
        {
          'agent.id': agent.id,
          'agent.name': agent.name,
          'agent.model': agent.model ?? this.config.llm?.defaultModel,
          'run.id': runId,
          error: error instanceof Error ? error.message : String(error),
        },
        'error',
        'server',
        options.onSpan,
        rootSpanId
      );
      spans.unshift(errorSpan);

      options.onRunError?.(error instanceof Error ? error : new Error(String(error)), runId);

      throw error;
    } finally {
      releaseRunSlot?.();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      removeParentAbortListener?.();
    }
  }

  /**
   * The messages a new run starts with: the thread's history and the input,
   * once the input passed the injection and constitutional checks, with the
   * input saved to memory.
   */
  private async prepareMessages(
    agent: Agent,
    options: RunOptions,
    input: string,
    threadId: string
  ): Promise<Message[]> {
    const messages = await buildInitialMessages(
      agent,
      options,
      threadId,
      this.state.memoryAdapter,
      this.state.contextBuilder
    );

    const pii = this.config.security?.pii;
    if (pii?.mode === 'block') {
      const found = new PiiMasker(pii).find(input);
      if (found.length > 0) {
        throw new CogitatorError({
          message: `The input contains personal data: ${[...new Set(found.map((f) => f.type))].join(', ')}`,
          code: ErrorCode.PII_DETECTED,
          details: { types: [...new Set(found.map((f) => f.type))] },
        });
      }
    }

    if (this.state.injectionDetector) {
      const injectionResult = await this.state.injectionDetector.analyze(input);
      if (injectionResult.action === 'blocked') {
        const threatTypes = injectionResult.threats.map((t) => t.type).join(', ');
        throw new CogitatorError({
          message: `Prompt injection detected: ${threatTypes}`,
          code: ErrorCode.PROMPT_INJECTION_DETECTED,
          details: { threats: injectionResult.threats },
        });
      }
    }

    if (this.state.constitutionalAI?.config.filterInput) {
      const inputResult = await this.state.constitutionalAI.filterInput(input);
      if (!inputResult.allowed) {
        throw new CogitatorError({
          message: `Input blocked: ${inputResult.blockedReason ?? 'Policy violation'}`,
          code: ErrorCode.LLM_CONTENT_FILTERED,
          details: { harmScores: inputResult.harmScores },
        });
      }
    }

    if (options.context) {
      addContextToMessages(messages, options.context);
    }

    if (this.state.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
      const currentUserMessage = messages[messages.length - 1];
      await saveEntry(
        threadId,
        agent.id,
        currentUserMessage,
        this.state.memoryAdapter,
        undefined,
        undefined,
        options.onMemoryError,
        options.userId
      );
    }

    return messages;
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
    if (this.state.memoryAdapter && options.useMemory !== false && options.saveHistory !== false) {
      for (const toolCall of paused.turn.toolCalls) {
        const result: ToolResult = {
          callId: toolCall.id,
          name: toolCall.name,
          result: null,
          error: 'The user moved on without approving this tool call',
        };
        await saveEntry(
          threadId,
          agent.id,
          createToolMessage(toolCall, result),
          this.state.memoryAdapter,
          undefined,
          [result],
          options.onMemoryError,
          options.userId
        );
      }
    }
    await store.delete(threadId);
  }

  /**
   * The decision for a call that needs approval: the run's `onApproval`, else
   * `guardrails.onToolApproval`, else a pause.
   */
  private async decideApproval(
    request: ToolApprovalRequest,
    options: RunOptions
  ): Promise<ToolApprovalDecision | 'pause'> {
    if (options.onApproval) return options.onApproval(request);
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
      initializeCostRouting(this.config, this.state);
    }
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
    const { provider, model } = this.resolveRoute(modelString, explicitProvider);
    return { backend: this.backendFor(provider), model };
  }

  private resolveRoute(
    modelString: string,
    explicitProvider?: string
  ): { provider: string; model: string } {
    if (explicitProvider) return { provider: explicitProvider, model: modelString };
    const slash = modelString.indexOf('/');
    if (slash > 0) {
      const prefix = modelString.slice(0, slash);
      if (this.knowsProvider(prefix)) {
        return { provider: prefix, model: modelString.slice(slash + 1) };
      }
    }
    return { provider: this.config.llm?.defaultProvider ?? 'ollama', model: modelString };
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
   * `llm.backends`, a built-in provider or a registered plugin. A model string
   * `name/model` runs on that provider (see {@link route}), any other prefix
   * stays part of the model name on `llm.defaultProvider`.
   *
   * Credentials are not checked: a built-in provider counts even when
   * `llm.providers` has no key for it, as a run would still be sent there.
   */
  knowsProvider(name: string): boolean {
    return (
      Object.hasOwn(this.config.llm?.backends ?? {}, name) ||
      isLLMProvider(name) ||
      hasLLMPlugin(name)
    );
  }

  private backendFor(name: string): LLMBackend {
    const cached = this.backends.get(name);
    if (cached) return cached;
    const backend = withPiiMasking(
      withLLMRetry(this.createBackend(name), this.config.llm?.retry),
      this.config.security?.pii
    );
    this.backends.set(name, backend);
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
      this.costEstimator = new CostEstimator();
    }
    return this.costEstimator.estimate({
      ...params,
      model: params.model ?? this.resolveModel(params.agent),
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
    await cleanupState(this.state);
    this.backends.clear();
    this.initPromise = undefined;
  }
}

function toAbortError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (reason === undefined || reason === null) {
    return new Error(fallbackMessage);
  }
  return new Error(String(reason));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw toAbortError(signal.reason, 'Run aborted');
  }
}

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
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

interface PausedTurn {
  toolCalls: ToolCall[];
  decisions: Record<string, ToolApprovalDecision>;
  pending: ToolApprovalRequest[];
}

/** Whether a call to `tool` with `args` needs approval; a check that throws counts as yes. */
function needsApproval(tool: Tool, args: Record<string, unknown>): boolean {
  const check = tool.requiresApproval;
  if (typeof check !== 'function') return check === true;
  try {
    return check(args);
  } catch {
    return true;
  }
}
