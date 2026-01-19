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
  MessageContent,
  ContentPart,
} from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';

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
    const { tools, toolChoice, systemSuffix } = this.prepareJsonMode(request);

    const allTools = [
      ...(request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as AnthropicToolInput,
      })) ?? []),
      ...tools,
    ];

    const response = await this.client.messages.create({
      model: request.model,
      system: systemSuffix ? `${system}\n\n${systemSuffix}` : system,
      messages,
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: toolChoice,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stop,
    });

    const toolCalls: ToolCall[] = [];
    let content = '';
    let jsonSchemaResponse: Record<string, unknown> | null = null;

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (block.name === '__json_response') {
          jsonSchemaResponse = block.input as Record<string, unknown>;
        } else {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
        }
      }
    }

    if (jsonSchemaResponse) {
      content = JSON.stringify(jsonSchemaResponse);
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
    const { tools, toolChoice, systemSuffix } = this.prepareJsonMode(request);

    const allTools = [
      ...(request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as AnthropicToolInput,
      })) ?? []),
      ...tools,
    ];

    const stream = this.client.messages.stream({
      model: request.model,
      system: systemSuffix ? `${system}\n\n${systemSuffix}` : system,
      messages,
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: toolChoice,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stop,
    });

    const id = this.generateId();
    const toolCalls: ToolCall[] = [];
    let currentToolCall: Partial<ToolCall> | null = null;
    let currentToolName = '';
    let inputJson = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let jsonSchemaContent = '';

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolCall = {
            id: block.id,
            name: block.name,
            arguments: {},
          };
          currentToolName = block.name;
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

          if (currentToolName === '__json_response') {
            jsonSchemaContent = JSON.stringify(currentToolCall.arguments);
          } else {
            toolCalls.push(currentToolCall as ToolCall);
          }
          currentToolCall = null;
          currentToolName = '';
        }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens;
      } else if (event.type === 'message_stop') {
        if (jsonSchemaContent) {
          yield {
            id,
            delta: { content: jsonSchemaContent },
          };
        }

        yield {
          id,
          delta: {
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
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
          system = this.getTextContent(m.content);
          break;
        case 'user':
          anthropicMessages.push({
            role: 'user',
            content: this.convertContent(m.content),
          });
          break;
        case 'assistant':
          anthropicMessages.push({
            role: 'assistant',
            content: this.convertContent(m.content),
          });
          break;
        case 'tool':
          anthropicMessages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId ?? '',
                content: this.getTextContent(m.content),
              },
            ],
          });
          break;
      }
    }

    return { system, messages: anthropicMessages };
  }

  private convertContent(content: MessageContent): string | Anthropic.ContentBlockParam[] {
    if (typeof content === 'string') {
      return content;
    }

    return content.map((part) => this.convertContentPart(part));
  }

  private convertContentPart(part: ContentPart): Anthropic.ContentBlockParam {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'image_url':
        return {
          type: 'image',
          source: {
            type: 'url',
            url: part.image_url.url,
          },
        };
      case 'image_base64':
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.image_base64.media_type,
            data: part.image_base64.data,
          },
        };
    }
  }

  private getTextContent(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
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

  private prepareJsonMode(request: ChatRequest): {
    tools: Array<{ name: string; description: string; input_schema: AnthropicToolInput }>;
    toolChoice: Anthropic.MessageCreateParams['tool_choice'];
    systemSuffix: string;
  } {
    const format = request.responseFormat;

    if (!format || format.type === 'text') {
      return { tools: [], toolChoice: undefined, systemSuffix: '' };
    }

    if (format.type === 'json_object') {
      return {
        tools: [],
        toolChoice: undefined,
        systemSuffix:
          'You must respond with valid JSON only. Do not include any text before or after the JSON object.',
      };
    }

    const schema = format.jsonSchema.schema;
    const inputSchema: AnthropicToolInput = {
      type: 'object',
      properties: (schema.properties ?? {}) as Record<string, unknown>,
      required: schema.required as string[] | undefined,
      ...schema,
    };

    const jsonSchemaTool = {
      name: '__json_response',
      description: format.jsonSchema.description ?? 'Respond with structured JSON data',
      input_schema: inputSchema,
    };

    return {
      tools: [jsonSchemaTool],
      toolChoice: { type: 'tool' as const, name: '__json_response' },
      systemSuffix: '',
    };
  }
}
