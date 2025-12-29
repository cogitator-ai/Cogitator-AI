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
} from '@cogitator/types';
import { Agent } from './agent.js';
import { ToolRegistry } from './registry.js';
import { createLLMBackend, parseModel } from './llm/index.js';

export class Cogitator {
  private config: CogitatorConfig;
  private backends: Map<LLMProvider, LLMBackend> = new Map();
  public readonly tools: ToolRegistry = new ToolRegistry();

  constructor(config: CogitatorConfig = {}) {
    this.config = config;
  }

  /**
   * Run an agent with the given input
   */
  async run(agent: Agent, options: RunOptions): Promise<RunResult> {
    const runId = `run_${nanoid(12)}`;
    const threadId = options.threadId ?? `thread_${nanoid(12)}`;
    const startTime = Date.now();
    const spans: Span[] = [];

    // Register agent's tools
    const registry = new ToolRegistry();
    registry.registerMany(agent.tools);

    // Get LLM backend
    const backend = this.getBackend(agent.model);
    const { model } = parseModel(agent.model);

    // Build initial messages
    const messages: Message[] = [
      { role: 'system', content: agent.instructions },
      { role: 'user', content: options.input },
    ];

    // Add context if provided
    if (options.context) {
      const contextStr = Object.entries(options.context)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n');
      messages[0].content += `\n\nContext:\n${contextStr}`;
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
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Check if we need to call tools
      if (response.finishReason === 'tool_calls' && response.toolCalls) {
        for (const toolCall of response.toolCalls) {
          allToolCalls.push(toolCall);
          options.onToolCall?.(toolCall);

          const toolSpanStart = Date.now();
          const result = await this.executeTool(
            registry,
            toolCall,
            runId,
            agent.id
          );

          spans.push({
            name: `tool.${toolCall.name}`,
            startTime: toolSpanStart,
            endTime: Date.now(),
            duration: Date.now() - toolSpanStart,
            attributes: { toolName: toolCall.name },
          });

          options.onToolResult?.(result);

          // Add tool result message
          messages.push({
            role: 'tool',
            content: JSON.stringify(result.result),
            toolCallId: toolCall.id,
            name: toolCall.name,
          });
        }
      } else {
        // No more tool calls, we're done
        break;
      }
    }

    const endTime = Date.now();
    const lastAssistantMessage = messages
      .filter((m) => m.role === 'assistant')
      .pop();

    return {
      output: lastAssistantMessage?.content ?? '',
      runId,
      agentId: agent.id,
      threadId,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        cost: this.calculateCost(
          agent.model,
          totalInputTokens,
          totalOutputTokens
        ),
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
    inputTokens = messages.reduce(
      (acc, m) => acc + Math.ceil(m.content.length / 4),
      0
    );

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
    const actualProvider =
      provider ?? this.config.llm?.defaultProvider ?? 'ollama';

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
  private calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    // Simplified pricing (per 1M tokens)
    const pricing: Record<string, { input: number; output: number }> = {
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

    return (
      (inputTokens * price.input) / 1_000_000 +
      (outputTokens * price.output) / 1_000_000
    );
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    this.backends.clear();
  }
}
