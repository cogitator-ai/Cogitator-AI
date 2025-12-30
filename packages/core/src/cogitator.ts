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
} from '@cogitator/types';
import {
  InMemoryAdapter,
  RedisAdapter,
  PostgresAdapter,
  ContextBuilder,
  countMessageTokens,
  type ContextBuilderDeps,
} from '@cogitator/memory';
import { type Agent } from './agent.js';
import { ToolRegistry } from './registry.js';
import { createLLMBackend, parseModel } from './llm/index.js';

export class Cogitator {
  private config: CogitatorConfig;
  private backends = new Map<LLMProvider, LLMBackend>();
  public readonly tools: ToolRegistry = new ToolRegistry();

  private memoryAdapter?: MemoryAdapter;
  private contextBuilder?: ContextBuilder;
  private memoryInitialized = false;

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

    // Build the correct adapter based on provider
    if (provider === 'memory') {
      adapter = new InMemoryAdapter({
        provider: 'memory',
        ...this.config.memory.inMemory,
      });
    } else if (provider === 'redis') {
      const url = this.config.memory.redis?.url;
      if (!url) {
        console.warn('Redis adapter requires url in config');
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
        console.warn('Postgres adapter requires connectionString in config');
        return;
      }
      adapter = new PostgresAdapter({
        provider: 'postgres',
        connectionString,
        ...this.config.memory.postgres,
      });
    } else {
      console.warn(`Unknown memory provider: ${provider}`);
      return;
    }

    const result = await adapter.connect();
    if (!result.success) {
      console.warn('Memory adapter connection failed:', result.error);
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
   * Build initial messages for a run, loading history if memory is enabled
   */
  private async buildInitialMessages(
    agent: Agent,
    options: RunOptions,
    threadId: string
  ): Promise<Message[]> {
    // If no memory or disabled, use simple approach
    if (!this.memoryAdapter || options.useMemory === false) {
      return [
        { role: 'system', content: agent.instructions },
        { role: 'user', content: options.input },
      ];
    }

    // Ensure thread exists
    const threadResult = await this.memoryAdapter.getThread(threadId);
    if (!threadResult.success || !threadResult.data) {
      await this.memoryAdapter.createThread(agent.id, { agentId: agent.id });
    }

    // Use ContextBuilder if available and history loading is enabled
    if (this.contextBuilder && options.loadHistory !== false) {
      const ctx = await this.contextBuilder.build({
        threadId,
        agentId: agent.id,
        systemPrompt: agent.instructions,
      });
      // Add current user input
      return [...ctx.messages, { role: 'user', content: options.input }];
    }

    // Fallback: manual history load
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
      console.warn('Failed to save memory entry:', error);
    }
  }

  /**
   * Run an agent with the given input
   */
  async run(agent: Agent, options: RunOptions): Promise<RunResult> {
    const runId = `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const startTime = Date.now();
    const spans: Span[] = [];

    // Initialize memory on first run if configured
    if (this.config.memory?.adapter && !this.memoryInitialized) {
      await this.initializeMemory();
    }

    // Register agent's tools
    const registry = new ToolRegistry();
    registry.registerMany(agent.tools);

    // Get LLM backend
    const backend = this.getBackend(agent.model);
    const { model } = parseModel(agent.model);

    // Build initial messages (with history if memory enabled)
    const messages = await this.buildInitialMessages(agent, options, threadId);

    // Add context if provided
    if (options.context && messages.length > 0 && messages[0].role === 'system') {
      const contextStr = Object.entries(options.context)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n');
      messages[0].content += `\n\nContext:\n${contextStr}`;
    }

    // Save user input to memory (if this is a new message, not from history)
    if (this.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
      await this.saveEntry(threadId, { role: 'user', content: options.input });
    }

    const allToolCalls: ToolCall[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;
    const maxIterations = agent.config.maxIterations ?? 10;

    // Main agent loop
    while (iterations < maxIterations) {
      iterations++;

      const llmSpanStart = Date.now();

      // Call LLM
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

      spans.push({
        name: 'llm.inference',
        startTime: llmSpanStart,
        endTime: Date.now(),
        duration: Date.now() - llmSpanStart,
        attributes: { model, iteration: iterations },
      });

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      // Add assistant message
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
      };
      messages.push(assistantMessage);

      // Save assistant message to memory
      if (this.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
        await this.saveEntry(threadId, assistantMessage, response.toolCalls);
      }

      // Check if we need to call tools
      if (response.finishReason === 'tool_calls' && response.toolCalls) {
        for (const toolCall of response.toolCalls) {
          allToolCalls.push(toolCall);
          options.onToolCall?.(toolCall);

          const toolSpanStart = Date.now();
          const result = await this.executeTool(registry, toolCall, runId, agent.id);

          spans.push({
            name: `tool.${toolCall.name}`,
            startTime: toolSpanStart,
            endTime: Date.now(),
            duration: Date.now() - toolSpanStart,
            attributes: { toolName: toolCall.name },
          });

          options.onToolResult?.(result);

          // Add tool result message
          const toolMessage: Message = {
            role: 'tool',
            content: JSON.stringify(result.result),
            toolCallId: toolCall.id,
            name: toolCall.name,
          };
          messages.push(toolMessage);

          // Save tool message to memory
          if (this.memoryAdapter && options.saveHistory !== false && options.useMemory !== false) {
            await this.saveEntry(threadId, toolMessage, undefined, [result]);
          }
        }
      } else {
        // No more tool calls, we're done
        break;
      }
    }

    const endTime = Date.now();
    const lastAssistantMessage = messages.filter((m) => m.role === 'assistant').pop();

    return {
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
        traceId: `trace_${nanoid(12)}`,
        spans,
      },
    };
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
        outputTokens++;
      }
      if (chunk.delta.toolCalls) {
        toolCalls = chunk.delta.toolCalls as ToolCall[];
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
    }

    // Estimate input tokens (rough)
    inputTokens = messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);

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
   * Calculate cost based on model and tokens
   */
  private calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    // Simplified pricing (per 1M tokens)
    const pricing: Partial<Record<string, { input: number; output: number }>> = {
      'gpt-4o': { input: 2.5, output: 10 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'gpt-4-turbo': { input: 10, output: 30 },
      'claude-3-5-sonnet': { input: 3, output: 15 },
      'claude-3-opus': { input: 15, output: 75 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
    };

    const { model: modelName } = parseModel(model);
    const price = pricing[modelName];

    if (!price) {
      // Local models are free
      return 0;
    }

    return (inputTokens * price.input) / 1_000_000 + (outputTokens * price.output) / 1_000_000;
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
    this.backends.clear();
  }
}
