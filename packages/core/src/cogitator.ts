/**
 * Cogitator - Main runtime class
 */

import { nanoid } from 'nanoid';
import type {
  CogitatorConfig,
  RunOptions,
  RunResult,
  Message,
  ToolCall,
  ToolResult,
  LLMBackend,
  LLMProvider,
  Span,
  ToolContext,
  MemoryAdapter,
  Tool,
} from '@cogitator-ai/types';
import {
  InMemoryAdapter,
  RedisAdapter,
  PostgresAdapter,
  ContextBuilder,
  countMessageTokens,
  countMessagesTokens,
  type ContextBuilderDeps,
} from '@cogitator-ai/memory';
import { getPrice } from '@cogitator-ai/models';
import { type Agent } from './agent';
import { ToolRegistry } from './registry';
import { createLLMBackend, parseModel } from './llm/index';
import { getLogger } from './logger';

type SandboxManager = {
  initialize(): Promise<void>;
  execute(
    request: { command: string[]; cwd?: string; env?: Record<string, string>; timeout?: number },
    config: { type: string; image?: string; resources?: unknown; network?: unknown; timeout?: number }
  ): Promise<{ success: boolean; data?: { stdout: string; stderr: string; exitCode: number; timedOut: boolean; duration: number }; error?: string }>;
  isDockerAvailable(): Promise<boolean>;
  shutdown(): Promise<void>;
};

export class Cogitator {
  private config: CogitatorConfig;
  private backends = new Map<LLMProvider, LLMBackend>();
  public readonly tools: ToolRegistry = new ToolRegistry();

  private memoryAdapter?: MemoryAdapter;
  private contextBuilder?: ContextBuilder;
  private memoryInitialized = false;

  private sandboxManager?: SandboxManager;
  private sandboxInitialized = false;

  constructor(config: CogitatorConfig = {}) {
    this.config = config;
  }

  /**
   * Initialize memory adapter and context builder (lazy, on first run)
   */
  private async initializeMemory(): Promise<void> {
    if (this.memoryInitialized || !this.config.memory?.adapter) return;

    const provider = this.config.memory.adapter;
    let adapter: MemoryAdapter;

    if (provider === 'memory') {
      adapter = new InMemoryAdapter({
        provider: 'memory',
        ...this.config.memory.inMemory,
      });
    } else if (provider === 'redis') {
      const url = this.config.memory.redis?.url;
      if (!url) {
        getLogger().warn('Redis adapter requires url in config');
        return;
      }
      adapter = new RedisAdapter({
        provider: 'redis',
        url,
        ...this.config.memory.redis,
      });
    } else if (provider === 'postgres') {
      const connectionString = this.config.memory.postgres?.connectionString;
      if (!connectionString) {
        getLogger().warn('Postgres adapter requires connectionString in config');
        return;
      }
      adapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString,
        ...this.config.memory.postgres,
      });
    } else {
      getLogger().warn(`Unknown memory provider: ${provider}`);
      return;
    }

    const result = await adapter.connect();
    if (!result.success) {
      getLogger().warn('Memory adapter connection failed', { error: result.error });
      return;
    }

    this.memoryAdapter = adapter;

    if (this.config.memory.contextBuilder) {
      const deps: ContextBuilderDeps = {
        memoryAdapter: this.memoryAdapter,
      };
      const contextConfig = {
        maxTokens: this.config.memory.contextBuilder.maxTokens ?? 4000,
        strategy: this.config.memory.contextBuilder.strategy ?? 'recent',
        ...this.config.memory.contextBuilder,
      } as const;
      this.contextBuilder = new ContextBuilder(contextConfig, deps);
    }

    this.memoryInitialized = true;
  }

  /**
   * Initialize sandbox manager (lazy, on first sandboxed tool execution)
   */
  private async initializeSandbox(): Promise<void> {
    if (this.sandboxInitialized) return;

    try {
      const { SandboxManager } = await import('@cogitator-ai/sandbox');
      this.sandboxManager = new SandboxManager(this.config.sandbox) as SandboxManager;
      await this.sandboxManager.initialize();
      this.sandboxInitialized = true;
    } catch {
      this.sandboxInitialized = true;
    }
  }

  /**
   * Build initial messages for a run, loading history if memory is enabled
   */
  private async buildInitialMessages(
    agent: Agent,
    options: RunOptions,
    threadId: string
  ): Promise<Message[]> {
    if (!this.memoryAdapter || options.useMemory === false) {
      return [
        { role: 'system', content: agent.instructions },
        { role: 'user', content: options.input },
      ];
    }

    const threadResult = await this.memoryAdapter.getThread(threadId);
    if (!threadResult.success || !threadResult.data) {
      await this.memoryAdapter.createThread(agent.id, { agentId: agent.id });
    }

    if (this.contextBuilder && options.loadHistory !== false) {
      const ctx = await this.contextBuilder.build({
        threadId,
        agentId: agent.id,
        systemPrompt: agent.instructions,
      });
      return [...ctx.messages, { role: 'user', content: options.input }];
    }

    if (options.loadHistory !== false) {
      const entries = await this.memoryAdapter.getEntries({ threadId, limit: 20 });
      const messages: Message[] = [{ role: 'system', content: agent.instructions }];
      if (entries.success) {
        messages.push(...entries.data.map((e) => e.message));
      }
      messages.push({ role: 'user', content: options.input });
      return messages;
    }

    return [
      { role: 'system', content: agent.instructions },
      { role: 'user', content: options.input },
    ];
  }

  /**
   * Save a message entry to memory (non-blocking, won't crash on failure)
   */
  private async saveEntry(
    threadId: string,
    message: Message,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[]
  ): Promise<void> {
    if (!this.memoryAdapter) return;

    try {
      await this.memoryAdapter.addEntry({
        threadId,
        message,
        toolCalls,
        toolResults,
        tokenCount: countMessageTokens(message),
      });
    } catch (error) {
      getLogger().warn('Failed to save memory entry', { error });
    }
  }

  /**
   * Create a span with proper IDs and emit callback
   */
  private createSpan(
    name: string,
    traceId: string,
    parentId: string | undefined,
    startTime: number,
    endTime: number,
    attributes: Record<string, unknown>,
    status: 'ok' | 'error' | 'unset' = 'ok',
    kind: Span['kind'] = 'internal',
    onSpan?: (span: Span) => void
  ): Span {
    const span: Span = {
      id: `span_${nanoid(12)}`,
      traceId,
      parentId,
      name,
      kind,
      status,
      startTime,
      endTime,
      duration: endTime - startTime,
      attributes,
    };
    onSpan?.(span);
    return span;
  }

  /**
   * Run an agent with the given input
   */
  async run(agent: Agent, options: RunOptions): Promise<RunResult> {
    const runId = `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const traceId = `trace_${nanoid(16)}`;
    const startTime = Date.now();
    const spans: Span[] = [];

    options.onRunStart?.({ runId, agentId: agent.id, input: options.input, threadId });

    const rootSpanId = `span_${nanoid(12)}`;

    try {
      if (this.config.memory?.adapter && !this.memoryInitialized) {
        await this.initializeMemory();
      }

      const registry = new ToolRegistry();
      if (agent.tools && agent.tools.length > 0) {
        registry.registerMany(agent.tools);
      }

      const backend = this.getBackend(agent.model);
      const { model } = parseModel(agent.model);

      const messages = await this.buildInitialMessages(agent, options, threadId);

      if (options.context && messages.length > 0 && messages[0].role === 'system') {
        const contextStr = Object.entries(options.context)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join('\n');
        messages[0].content += `\n\nContext:\n${contextStr}`;
      }

      if (this.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
        await this.saveEntry(threadId, { role: 'user', content: options.input });
      }

      const allToolCalls: ToolCall[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let iterations = 0;
      const maxIterations = agent.config?.maxIterations ?? 10;

      while (iterations < maxIterations) {
        iterations++;

        const llmSpanStart = Date.now();

        let response;
        if (options.stream && options.onToken) {
          response = await this.streamChat(
            backend,
            model,
            messages,
            registry,
            agent,
            options.onToken
          );
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

        const llmSpan = this.createSpan(
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

        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content,
        };
        messages.push(assistantMessage);

        if (this.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
          await this.saveEntry(threadId, assistantMessage, response.toolCalls);
        }

        if (response.finishReason === 'tool_calls' && response.toolCalls) {
          for (const toolCall of response.toolCalls) {
            allToolCalls.push(toolCall);
            options.onToolCall?.(toolCall);

            const toolSpanStart = Date.now();
            const result = await this.executeTool(registry, toolCall, runId, agent.id);
            const toolSpanEnd = Date.now();

            const toolSpan = this.createSpan(
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

            const toolMessage: Message = {
              role: 'tool',
              content: JSON.stringify(result.result),
              toolCallId: toolCall.id,
              name: toolCall.name,
            };
            messages.push(toolMessage);

            if (this.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
              await this.saveEntry(threadId, toolMessage, undefined, [result]);
            }
          }
        } else {
          break;
        }
      }

      const endTime = Date.now();
      const lastAssistantMessage = messages.filter((m) => m.role === 'assistant').pop();

      const rootSpan = this.createSpan(
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

      const result: RunResult = {
        output: lastAssistantMessage?.content ?? '',
        runId,
        agentId: agent.id,
        threadId,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          cost: this.calculateCost(agent.model, totalInputTokens, totalOutputTokens),
          duration: endTime - startTime,
        },
        toolCalls: allToolCalls,
        messages,
        trace: {
          traceId,
          spans,
        },
      };

      options.onRunComplete?.(result);

      return result;
    } catch (error) {
      const endTime = Date.now();

      const errorSpan = this.createSpan(
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
          'error': error instanceof Error ? error.message : String(error),
        },
        'error',
        'server',
        options.onSpan
      );
      spans.unshift(errorSpan);

      options.onRunError?.(error instanceof Error ? error : new Error(String(error)), runId);

      throw error;
    }
  }

  /**
   * Stream chat with token callback
   */
  private async streamChat(
    backend: LLMBackend,
    model: string,
    messages: Message[],
    registry: ToolRegistry,
    agent: Agent,
    onToken: (token: string) => void
  ) {
    let content = '';
    let toolCalls: ToolCall[] | undefined;
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    let hasUsageFromStream = false;

    const stream = backend.chatStream({
      model,
      messages,
      tools: registry.getSchemas(),
      temperature: agent.config.temperature,
      topP: agent.config.topP,
      maxTokens: agent.config.maxTokens,
      stop: agent.config.stopSequences,
    });

    for await (const chunk of stream) {
      if (chunk.delta.content) {
        content += chunk.delta.content;
        onToken(chunk.delta.content);
      }
      if (chunk.delta.toolCalls) {
        toolCalls = chunk.delta.toolCalls as ToolCall[];
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.inputTokens;
        outputTokens = chunk.usage.outputTokens;
        hasUsageFromStream = true;
      }
    }

    if (!hasUsageFromStream) {
      inputTokens = countMessagesTokens(messages);
      outputTokens = Math.ceil(content.length / 4);
    }

    return {
      id: `stream_${nanoid(8)}`,
      content,
      toolCalls,
      finishReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Execute a tool
   */
  private async executeTool(
    registry: ToolRegistry,
    toolCall: ToolCall,
    runId: string,
    agentId: string
  ): Promise<ToolResult> {
    const tool = registry.get(toolCall.name);

    if (!tool) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Tool not found: ${toolCall.name}`,
      };
    }

    if (tool.sandbox?.type === 'docker' || tool.sandbox?.type === 'wasm') {
      return this.executeInSandbox(tool, toolCall, runId, agentId);
    }

    const context: ToolContext = {
      agentId,
      runId,
      signal: new AbortController().signal,
    };

    try {
      const result = await tool.execute(toolCall.arguments, context);
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result,
      };
    } catch (error) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a tool in sandbox (Docker or WASM)
   */
  private async executeInSandbox(
    tool: Tool,
    toolCall: ToolCall,
    runId: string,
    agentId: string
  ): Promise<ToolResult> {
    await this.initializeSandbox();

    if (!this.sandboxManager) {
      getLogger().warn('Sandbox unavailable, executing natively', { tool: tool.name });
      const context: ToolContext = {
        agentId,
        runId,
        signal: new AbortController().signal,
      };
      try {
        const result = await tool.execute(toolCall.arguments, context);
        return { callId: toolCall.id, name: toolCall.name, result };
      } catch (error) {
        return {
          callId: toolCall.id,
          name: toolCall.name,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const args = toolCall.arguments;
    const sandboxConfig = tool.sandbox!;

    const isWasm = sandboxConfig.type === 'wasm';
    const request = isWasm
      ? {
          command: [],
          stdin: JSON.stringify(args),
          timeout: tool.timeout,
        }
      : {
          command: ['sh', '-c', String(args.command ?? '')],
          cwd: args.cwd as string | undefined,
          env: args.env as Record<string, string> | undefined,
          timeout: tool.timeout,
        };

    const result = await this.sandboxManager.execute(request, sandboxConfig);

    if (!result.success) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: result.error,
      };
    }

    if (isWasm) {
      try {
        const parsed = JSON.parse(result.data!.stdout);
        return {
          callId: toolCall.id,
          name: toolCall.name,
          result: parsed,
        };
      } catch {
        return {
          callId: toolCall.id,
          name: toolCall.name,
          result: result.data!.stdout,
        };
      }
    }

    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: {
        stdout: result.data!.stdout,
        stderr: result.data!.stderr,
        exitCode: result.data!.exitCode,
        timedOut: result.data!.timedOut,
        duration: result.data!.duration,
        command: args.command,
      },
    };
  }

  /**
   * Get or create an LLM backend
   */
  private getBackend(modelString: string): LLMBackend {
    const { provider } = parseModel(modelString);
    const actualProvider = provider ?? this.config.llm?.defaultProvider ?? 'ollama';

    let backend = this.backends.get(actualProvider);
    if (!backend) {
      backend = createLLMBackend(actualProvider, this.config.llm);
      this.backends.set(actualProvider, backend);
    }

    return backend;
  }

  /**
   * Calculate cost based on model and tokens using dynamic model registry
   */
  private calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const { model: modelName } = parseModel(model);
    const price = getPrice(modelName);

    if (!price) {
      return 0;
    }

    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    if (this.memoryAdapter) {
      await this.memoryAdapter.disconnect();
      this.memoryAdapter = undefined;
      this.contextBuilder = undefined;
      this.memoryInitialized = false;
    }
    if (this.sandboxManager) {
      await this.sandboxManager.shutdown();
      this.sandboxManager = undefined;
      this.sandboxInitialized = false;
    }
    this.backends.clear();
  }
}
