/**
 * Anthropic LLM Backend
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  Message,
} from '@cogitator/types';
import { BaseLLMBackend } from './base.js';

interface AnthropicConfig {
  apiKey: string;
}

interface AnthropicToolInput {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export class AnthropicBackend extends BaseLLMBackend {
  readonly provider = 'anthropic' as const;
  private client: Anthropic;

  constructor(config: AnthropicConfig) {
    super();
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = this.convertMessages(request.messages);

    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as AnthropicToolInput,
    }));

    const response = await this.client.messages.create({
      model: request.model,
      system,
      messages,
      tools,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stop,
    });

    const toolCalls: ToolCall[] = [];
    let content = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      id: response.id,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const { system, messages } = this.convertMessages(request.messages);

    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as AnthropicToolInput,
    }));

    const stream = this.client.messages.stream({
      model: request.model,
      system,
      messages,
      tools,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stop,
    });

    const id = this.generateId();
    const toolCalls: ToolCall[] = [];
    let currentToolCall: Partial<ToolCall> | null = null;
    let inputJson = '';

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolCall = {
            id: block.id,
            name: block.name,
            arguments: {},
          };
          inputJson = '';
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield {
            id,
            delta: { content: delta.text },
          };
        } else if (delta.type === 'input_json_delta') {
          inputJson += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolCall) {
          try {
            currentToolCall.arguments = JSON.parse(inputJson) as Record<string, unknown>;
          } catch {
            currentToolCall.arguments = {};
          }
          toolCalls.push(currentToolCall as ToolCall);
          currentToolCall = null;
        }
      } else if (event.type === 'message_stop') {
        yield {
          id,
          delta: {
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        };
      }
    }
  }

  private convertMessages(messages: Message[]): {
    system: string;
    messages: Anthropic.MessageParam[];
  } {
    let system = '';
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const m of messages) {
      switch (m.role) {
        case 'system':
          system = m.content;
          break;
        case 'user':
          anthropicMessages.push({
            role: 'user',
            content: m.content,
          });
          break;
        case 'assistant':
          anthropicMessages.push({
            role: 'assistant',
            content: m.content,
          });
          break;
        case 'tool':
          anthropicMessages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId ?? '',
                content: m.content,
              },
            ],
          });
          break;
      }
    }

    return { system, messages: anthropicMessages };
  }

  private mapStopReason(reason: string | null): ChatResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }
}
