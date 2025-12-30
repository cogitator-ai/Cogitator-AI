/**
 * OpenAI LLM Backend
 */

import OpenAI from 'openai';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  Message,
} from '@cogitator/types';
import { BaseLLMBackend } from './base.js';

interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
}

export class OpenAIBackend extends BaseLLMBackend {
  readonly provider = 'openai' as const;
  private client: OpenAI;

  constructor(config: OpenAIConfig) {
    super();
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      messages: this.convertMessages(request.messages),
      tools: request.tools
        ? request.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stop: request.stop,
    });

    const choice = response.choices[0];
    const message = choice.message;

    const toolCalls: ToolCall[] | undefined = message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      id: response.id,
      content: message.content ?? '',
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: request.model,
      messages: this.convertMessages(request.messages),
      tools: request.tools
        ? request.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stop: request.stop,
      stream: true,
      stream_options: { include_usage: true },
    });

    const toolCallsAccum = new Map<number, Partial<ToolCall>>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (!choice && chunk.usage) {
        yield {
          id: chunk.id,
          delta: {},
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        };
        continue;
      }

      if (!choice) continue;

      const delta = choice.delta;

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsAccum.get(tc.index) ?? {};
          toolCallsAccum.set(tc.index, {
            id: tc.id ?? existing.id,
            name: tc.function?.name ?? existing.name,
            arguments: {
              ...existing.arguments,
              ...this.tryParseJson(tc.function?.arguments ?? ''),
            },
          });
        }
      }

      yield {
        id: chunk.id,
        delta: {
          content: delta.content ?? undefined,
          toolCalls:
            choice.finish_reason === 'tool_calls'
              ? (Array.from(toolCallsAccum.values()) as ToolCall[])
              : undefined,
        },
        finishReason: choice.finish_reason ? this.mapFinishReason(choice.finish_reason) : undefined,
      };
    }
  }

  private convertMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });
  }

  private mapFinishReason(reason: string | null): ChatResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
      case 'length':
        return 'length';
      default:
        return 'stop';
    }
  }

  private tryParseJson(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
