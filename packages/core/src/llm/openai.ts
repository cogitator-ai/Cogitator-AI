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
  LLMResponseFormat,
} from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';

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
      response_format: this.convertResponseFormat(request.responseFormat),
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
      response_format: this.convertResponseFormat(request.responseFormat),
    });

    const toolCallsAccum = new Map<number, { id?: string; name?: string }>();
    const toolCallArgsAccum = new Map<number, string>();

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
          });

          if (tc.function?.arguments) {
            const existingArgs = toolCallArgsAccum.get(tc.index) ?? '';
            toolCallArgsAccum.set(tc.index, existingArgs + tc.function.arguments);
          }
        }
      }

      let finalToolCalls: ToolCall[] | undefined;
      if (choice.finish_reason === 'tool_calls') {
        finalToolCalls = Array.from(toolCallsAccum.entries()).map(([index, partial]) => ({
          id: partial.id ?? '',
          name: partial.name ?? '',
          arguments: this.tryParseJson(toolCallArgsAccum.get(index) ?? '{}'),
        }));
      }

      yield {
        id: chunk.id,
        delta: {
          content: delta.content ?? undefined,
          toolCalls: finalToolCalls,
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

  private convertResponseFormat(
    format: LLMResponseFormat | undefined
  ): OpenAI.Chat.ChatCompletionCreateParams['response_format'] {
    if (!format) return undefined;

    switch (format.type) {
      case 'text':
        return { type: 'text' };
      case 'json_object':
        return { type: 'json_object' };
      case 'json_schema':
        return {
          type: 'json_schema',
          json_schema: {
            name: format.jsonSchema.name,
            description: format.jsonSchema.description,
            schema: format.jsonSchema.schema,
            strict: format.jsonSchema.strict ?? true,
          },
        };
    }
  }
}
