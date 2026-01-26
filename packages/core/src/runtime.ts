import { nanoid } from 'nanoid';
import type {
  CogitatorConfig,
  RunOptions,
  RunResult,
  Message,
  ToolCall,
  LLMBackend,
  LLMProvider,
  Span,
  Reflection,
  ReflectionAction,
  AgentContext,
  Constitution,
  CostSummary,
  CostEstimate,
  EstimateOptions,
} from '@cogitator-ai/types';
import { getPrice } from '@cogitator-ai/models';
import { type Agent } from './agent';
import { ToolRegistry } from './registry';
import { createLLMBackend, parseModel } from './llm/index';
import { getLogger } from './logger';
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
  saveEntry,
  enrichMessagesWithInsights,
  addContextToMessages,
} from './cogitator/message-builder';
import { createSpan, getTextContent } from './cogitator/span-factory';
import { executeTool, createToolMessage } from './cogitator/tool-executor';
import { streamChat } from './cogitator/streaming';
import { CostEstimator } from './cost-routing/cost-estimator';

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
 *   model: 'anthropic/claude-sonnet-4-20250514',
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
  private backends = new Map<LLMProvider, LLMBackend>();
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
   */
  constructor(config: CogitatorConfig = {}) {
    this.config = config;
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
    const runId = `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const traceId = `trace_${nanoid(16)}`;
    const startTime = Date.now();
    const spans: Span[] = [];

    const timeout = options.timeout ?? agent.config?.timeout;
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error(`Run timed out after ${timeout}ms`));
      }, timeout);
    }

    options.onRunStart?.({ runId, agentId: agent.id, input: options.input, threadId });

    const rootSpanId = `span_${nanoid(12)}`;

    try {
      await this.initializeAll(agent);

      const registry = new ToolRegistry();
      if (agent.tools && agent.tools.length > 0) {
        registry.registerMany(agent.tools);
      }

      let effectiveModel = agent.model;

      if (this.state.costRouter && this.config.costRouting?.autoSelectModel) {
        const recommendation = await this.state.costRouter.recommendModel(options.input);
        effectiveModel = `${recommendation.provider}/${recommendation.modelId}`;

        const budgetCheck = this.state.costRouter.checkBudget(recommendation.estimatedCost);
        if (!budgetCheck.allowed) {
          throw new Error(`Budget exceeded: ${budgetCheck.reason}`);
        }
      }

      const backend = this.getBackend(effectiveModel, agent.config.provider);
      const model = agent.config.provider ? effectiveModel : parseModel(effectiveModel).model;

      const messages = await buildInitialMessages(
        agent,
        options,
        threadId,
        this.state.memoryAdapter,
        this.state.contextBuilder
      );

      if (this.state.injectionDetector) {
        const injectionResult = await this.state.injectionDetector.analyze(options.input);
        if (injectionResult.action === 'blocked') {
          const threatTypes = injectionResult.threats.map((t) => t.type).join(', ');
          throw new CogitatorError({
            message: `Prompt injection detected: ${threatTypes}`,
            code: ErrorCode.PROMPT_INJECTION_DETECTED,
            details: { threats: injectionResult.threats },
          });
        }
      }

      if (this.state.constitutionalAI && this.config.guardrails?.filterInput) {
        const inputResult = await this.state.constitutionalAI.filterInput(options.input);
        if (!inputResult.allowed) {
          throw new Error(`Input blocked: ${inputResult.blockedReason ?? 'Policy violation'}`);
        }
      }

      if (options.context) {
        addContextToMessages(messages, options.context);
      }

      if (
        this.state.memoryAdapter &&
        options.saveHistory !== false &&
        options.useMemory !== false
      ) {
        await saveEntry(
          threadId,
          agent.id,
          { role: 'user', content: options.input },
          this.state.memoryAdapter,
          undefined,
          undefined,
          options.onMemoryError
        );
      }

      const allToolCalls: ToolCall[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let iterations = 0;
      const maxIterations = agent.config?.maxIterations ?? 10;

      const allReflections: Reflection[] = [];
      const allActions: ReflectionAction[] = [];
      const agentContext: AgentContext = {
        agentId: agent.id,
        agentName: agent.name,
        runId,
        threadId,
        goal: options.input,
        iterationIndex: 0,
        previousActions: [],
        availableTools: registry.getNames(),
      };

      if (this.state.reflectionEngine && this.config.reflection?.enabled) {
        await enrichMessagesWithInsights(messages, this.state.reflectionEngine, agentContext);
      }

      while (iterations < maxIterations) {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason ?? new Error('Run aborted');
        }

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
        if (options.stream && options.onToken) {
          response = await streamChat(backend, model, messages, registry, agent, options.onToken);
        } else {
          response = await backend.chat({
            model,
            messages,
            tools: registry.getSchemas(),
            temperature: agent.config.temperature,
            topP: agent.config.topP,
            maxTokens: agent.config.maxTokens,
            stop: agent.config.stopSequences,
          });
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
            'llm.finish_reason': response.finishReason,
          },
          'ok',
          'client',
          options.onSpan
        );
        spans.push(llmSpan);

        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;

        let outputContent = response.content;

        if (this.state.constitutionalAI && this.config.guardrails?.filterOutput) {
          const outputResult = await this.state.constitutionalAI.filterOutput(
            outputContent,
            messages
          );
          if (!outputResult.allowed) {
            if (outputResult.suggestedRevision) {
              outputContent = outputResult.suggestedRevision;
            } else {
              throw new Error(
                `Output blocked: ${outputResult.blockedReason ?? 'Policy violation'}`
              );
            }
          }
        }

        const assistantMessage: Message = {
          role: 'assistant',
          content: outputContent,
        };
        messages.push(assistantMessage);

        if (
          this.state.memoryAdapter &&
          options.saveHistory !== false &&
          options.useMemory !== false
        ) {
          await saveEntry(
            threadId,
            agent.id,
            assistantMessage,
            this.state.memoryAdapter,
            response.toolCalls,
            undefined,
            options.onMemoryError
          );
        }

        if (response.finishReason === 'tool_calls' && response.toolCalls) {
          const toolCalls = response.toolCalls;

          for (const toolCall of toolCalls) {
            allToolCalls.push(toolCall);
            options.onToolCall?.(toolCall);
          }

          const executeToolCall = async (toolCall: ToolCall) => {
            const toolSpanStart = Date.now();
            const result = await executeTool(
              registry,
              toolCall,
              runId,
              agent.id,
              this.state.sandboxManager,
              this.state.constitutionalAI,
              !!this.config.guardrails?.filterToolCalls,
              () => initializeSandbox(this.config, this.state),
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
                agent.id,
                toolMessage,
                this.state.memoryAdapter,
                undefined,
                [result],
                options.onMemoryError
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

            if (
              this.state.reflectionEngine &&
              this.config.reflection?.enabled &&
              this.config.reflection.reflectAfterToolCall
            ) {
              try {
                const reflectionResult = await this.state.reflectionEngine.reflectOnToolCall(
                  action,
                  agentContext
                );
                allReflections.push(reflectionResult.reflection);

                if (reflectionResult.shouldAdjustStrategy && reflectionResult.suggestedAction) {
                  messages.push({
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
        } else {
          break;
        }
      }

      const endTime = Date.now();
      const lastAssistantMessage = messages.filter((m) => m.role === 'assistant').pop();
      const finalOutput = lastAssistantMessage ? getTextContent(lastAssistantMessage.content) : '';

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
          'agent.model': agent.model,
          'run.id': runId,
          'run.thread_id': threadId,
          'run.iterations': iterations,
          'run.tool_calls': allToolCalls.length,
          'run.input_tokens': totalInputTokens,
          'run.output_tokens': totalOutputTokens,
        },
        'ok',
        'server',
        options.onSpan
      );
      spans.unshift(rootSpan);

      const runCost = this.calculateCost(effectiveModel, totalInputTokens, totalOutputTokens);

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
        },
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

      options.onRunComplete?.(result);

      return result;
    } catch (error) {
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
          'agent.model': agent.model,
          'run.id': runId,
          error: error instanceof Error ? error.message : String(error),
        },
        'error',
        'server',
        options.onSpan
      );
      spans.unshift(errorSpan);

      options.onRunError?.(error instanceof Error ? error : new Error(String(error)), runId);

      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async initializeAll(agent: Agent): Promise<void> {
    if (this.config.memory?.adapter && !this.state.memoryInitialized) {
      await initializeMemory(this.config, this.state);
    }

    if (this.config.reflection?.enabled && !this.state.reflectionInitialized) {
      await initializeReflection(this.config, this.state, agent, (model) => this.getBackend(model));
    }

    if (this.config.guardrails?.enabled && !this.state.guardrailsInitialized) {
      initializeGuardrails(this.config, this.state, agent, (model) => this.getBackend(model));
    }

    if (this.config.costRouting?.enabled && !this.state.costRoutingInitialized) {
      initializeCostRouting(this.config, this.state);
    }

    if (this.config.security?.promptInjection && !this.state.securityInitialized) {
      initializeSecurity(this.config, this.state, (model) => this.getBackend(model));
    }

    if (this.config.context?.enabled && !this.state.contextManagerInitialized) {
      initializeContextManager(this.config, this.state, (model) => this.getBackend(model));
    }
  }

  private getBackend(modelString: string, explicitProvider?: string): LLMBackend {
    const { provider: parsedProvider } = parseModel(modelString);

    const actualProvider = (explicitProvider ??
      parsedProvider ??
      this.config.llm?.defaultProvider ??
      'ollama') as LLMProvider;

    let backend = this.backends.get(actualProvider);
    if (!backend) {
      backend = createLLMBackend(actualProvider, this.config.llm);
      this.backends.set(actualProvider, backend);
    }

    return backend;
  }

  private calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const { model: modelName } = parseModel(model);
    const price = getPrice(modelName);

    if (!price) {
      return 0;
    }

    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
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
   * @returns ConstitutionalAI instance, undefined if guardrails not enabled
   */
  getGuardrails() {
    return this.state.constitutionalAI;
  }

  /**
   * Set or update the constitution for guardrails.
   *
   * The constitution defines principles and rules that the agent
   * must follow, filtering both input and output.
   *
   * @param constitution - New constitution to apply
   */
  setConstitution(constitution: Constitution): void {
    this.state.constitutionalAI?.setConstitution(constitution);
  }

  /**
   * Get cost tracking summary across all runs.
   *
   * @returns Cost summary with total spent, runs count, and per-model breakdown
   */
  getCostSummary(): CostSummary | undefined {
    return this.state.costRouter?.getCostSummary();
  }

  /**
   * Get the cost-aware router instance for advanced cost management.
   *
   * @returns CostAwareRouter instance, undefined if cost routing not enabled
   */
  getCostRouter() {
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
  }): Promise<CostEstimate> {
    if (!this.costEstimator) {
      this.costEstimator = new CostEstimator();
    }
    return this.costEstimator.estimate(params);
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
  }
}
