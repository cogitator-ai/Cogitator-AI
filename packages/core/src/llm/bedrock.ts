/**
 * AWS Bedrock LLM Backend
 *
 * Uses AWS Bedrock's Converse API for unified chat interface.
 * Supports Claude, Llama, Mistral, Cohere, and Amazon Titan models.
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  ToolChoice,
  Message,
  MessageContent,
  ContentPart,
  ToolSchema,
} from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';
import { createLLMError, llmUnavailable, llmConfigError, type LLMErrorContext } from './errors';
import { fetchImageAsBase64 } from '../utils/image-fetch';

type DocumentType =
  | null
  | boolean
  | number
  | string
  | DocumentType[]
  | { [key: string]: DocumentType };

type BedrockRuntimeClientType = InstanceType<
  typeof import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient
>;
type ConverseCommandInput = import('@aws-sdk/client-bedrock-runtime').ConverseCommandInput;
type ConverseCommandOutput = import('@aws-sdk/client-bedrock-runtime').ConverseCommandOutput;
type ConverseStreamCommandInput =
  import('@aws-sdk/client-bedrock-runtime').ConverseStreamCommandInput;
type ConverseStreamCommandOutput =
  import('@aws-sdk/client-bedrock-runtime').ConverseStreamCommandOutput;
type BedrockMessage = import('@aws-sdk/client-bedrock-runtime').Message;
type ContentBlock = import('@aws-sdk/client-bedrock-runtime').ContentBlock;
type BedrockTool = import('@aws-sdk/client-bedrock-runtime').Tool;
type ToolConfiguration = import('@aws-sdk/client-bedrock-runtime').ToolConfiguration;
type InferenceConfiguration = import('@aws-sdk/client-bedrock-runtime').InferenceConfiguration;

interface BedrockConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class BedrockBackend extends BaseLLMBackend {
  readonly provider = 'bedrock' as const;
  private config: BedrockConfig;
  private clientPromise: Promise<BedrockRuntimeClientType> | null = null;

  constructor(config: BedrockConfig) {
    super();
    this.config = config;
  }

  private async getClient(): Promise<BedrockRuntimeClientType> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const ctx: LLMErrorContext = { provider: this.provider };
        try {
          const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');

          const clientConfig: Record<string, unknown> = {};
          if (this.config.region) {
            clientConfig.region = this.config.region;
          }
          if (this.config.accessKeyId && this.config.secretAccessKey) {
            clientConfig.credentials = {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey,
            };
          }

          return new BedrockRuntimeClient(clientConfig);
        } catch {
          throw llmConfigError(
            ctx,
            'AWS SDK not installed. Run: pnpm add @aws-sdk/client-bedrock-runtime'
          );
        }
      })();
    }
    return this.clientPromise;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
    };

    const client = await this.getClient();
    const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');

    const { system, messages } = await this.convertMessages(request.messages);
    const input: ConverseCommandInput = {
      modelId: request.model,
      messages,
    };

    if (system) {
      input.system = [{ text: system }];
    }

    if (request.tools && request.tools.length > 0) {
      input.toolConfig = {
        tools: request.tools.map((t) => this.convertTool(t)),
      };

      const toolChoice = this.convertToolChoice(request.toolChoice);
      if (toolChoice) {
        input.toolConfig.toolChoice = toolChoice;
      }
    }

    const inferenceConfig: InferenceConfiguration = {};
    if (request.maxTokens) inferenceConfig.maxTokens = request.maxTokens;
    if (request.temperature) inferenceConfig.temperature = request.temperature;
    if (request.topP) inferenceConfig.topP = request.topP;
    if (request.stop) inferenceConfig.stopSequences = request.stop;

    if (Object.keys(inferenceConfig).length > 0) {
      input.inferenceConfig = inferenceConfig;
    }

    let response: ConverseCommandOutput;
    try {
      const command = new ConverseCommand(input);
      response = await client.send(command);
    } catch (e) {
      throw this.wrapBedrockError(e, ctx);
    }

    return this.parseResponse(response);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
    };

    const client = await this.getClient();
    const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');

    const { system, messages } = await this.convertMessages(request.messages);
    const input: ConverseStreamCommandInput = {
      modelId: request.model,
      messages,
    };

    if (system) {
      input.system = [{ text: system }];
    }

    if (request.tools && request.tools.length > 0) {
      input.toolConfig = {
        tools: request.tools.map((t) => this.convertTool(t)),
      };

      const toolChoice = this.convertToolChoice(request.toolChoice);
      if (toolChoice) {
        input.toolConfig.toolChoice = toolChoice;
      }
    }

    const inferenceConfig: InferenceConfiguration = {};
    if (request.maxTokens) inferenceConfig.maxTokens = request.maxTokens;
    if (request.temperature) inferenceConfig.temperature = request.temperature;
    if (request.topP) inferenceConfig.topP = request.topP;
    if (request.stop) inferenceConfig.stopSequences = request.stop;

    if (Object.keys(inferenceConfig).length > 0) {
      input.inferenceConfig = inferenceConfig;
    }

    const command = new ConverseStreamCommand(input);
    let response: ConverseStreamCommandOutput;
    try {
      response = await client.send(command);
    } catch (e) {
      throw this.wrapBedrockError(e, ctx);
    }

    const id = this.generateId();
    const toolCalls: ToolCall[] = [];
    const toolCallInputs = new Map<number, { id: string; name: string; input: string }>();

    if (!response.stream) {
      return;
    }

    for await (const event of response.stream) {
      if (event.contentBlockStart?.start?.toolUse) {
        const idx = event.contentBlockStart.contentBlockIndex ?? 0;
        toolCallInputs.set(idx, {
          id: event.contentBlockStart.start.toolUse.toolUseId ?? '',
          name: event.contentBlockStart.start.toolUse.name ?? '',
          input: '',
        });
      }

      if (event.contentBlockDelta) {
        const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
        const delta = event.contentBlockDelta.delta;

        if (delta?.text) {
          yield {
            id,
            delta: { content: delta.text },
          };
        }

        if (delta?.toolUse?.input) {
          const existing = toolCallInputs.get(idx);
          if (existing) {
            existing.input += delta.toolUse.input;
          }
        }
      }

      if (event.contentBlockStop) {
        const idx = event.contentBlockStop.contentBlockIndex ?? 0;
        const toolCall = toolCallInputs.get(idx);
        if (toolCall) {
          toolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            arguments: this.tryParseJson(toolCall.input),
          });
        }
      }

      if (event.messageStop) {
        const finishReason = this.mapStopReason(event.messageStop.stopReason);
        yield {
          id,
          delta: {
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finishReason,
        };
      }

      if (event.metadata?.usage) {
        yield {
          id,
          delta: {},
          usage: {
            inputTokens: event.metadata.usage.inputTokens ?? 0,
            outputTokens: event.metadata.usage.outputTokens ?? 0,
            totalTokens: event.metadata.usage.totalTokens ?? 0,
          },
        };
      }
    }
  }

  private async convertMessages(messages: Message[]): Promise<{
    system: string | null;
    messages: BedrockMessage[];
  }> {
    let system: string | null = null;
    const bedrockMessages: BedrockMessage[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          system = this.getTextContent(msg.content);
          break;

        case 'user':
          bedrockMessages.push({
            role: 'user',
            content: await this.convertContentToBlocks(msg.content),
          });
          break;

        case 'assistant':
          bedrockMessages.push({
            role: 'assistant',
            content: await this.convertContentToBlocks(msg.content),
          });
          break;

        case 'tool':
          bedrockMessages.push({
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: msg.toolCallId ?? '',
                  content: [{ text: this.getTextContent(msg.content) }],
                },
              },
            ],
          });
          break;
      }
    }

    return { system, messages: bedrockMessages };
  }

  private async convertContentToBlocks(content: MessageContent): Promise<ContentBlock[]> {
    if (typeof content === 'string') {
      return content ? [{ text: content }] : [];
    }

    const blocks = await Promise.all(content.map((part) => this.convertContentPart(part)));
    return blocks.filter((b): b is ContentBlock => b !== null);
  }

  private async convertContentPart(part: ContentPart): Promise<ContentBlock | null> {
    switch (part.type) {
      case 'text':
        return { text: part.text };
      case 'image_base64':
        return {
          image: {
            format: (part.image_base64.media_type.split('/')[1] || 'png') as
              | 'png'
              | 'jpeg'
              | 'gif'
              | 'webp',
            source: {
              bytes: Uint8Array.from(atob(part.image_base64.data), (c) => c.charCodeAt(0)),
            },
          },
        };
      case 'image_url': {
        const fetched = await fetchImageAsBase64(part.image_url.url);
        const format = (fetched.mediaType.split('/')[1] || 'png') as
          | 'png'
          | 'jpeg'
          | 'gif'
          | 'webp';
        return {
          image: {
            format,
            source: {
              bytes: Uint8Array.from(atob(fetched.data), (c) => c.charCodeAt(0)),
            },
          },
        };
      }
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

  private convertTool(tool: ToolSchema): BedrockTool {
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: tool.parameters as DocumentType,
        },
      },
    };
  }

  private convertToolChoice(
    choice: ToolChoice | undefined
  ): ToolConfiguration['toolChoice'] | undefined {
    if (!choice) return undefined;

    if (typeof choice === 'string') {
      switch (choice) {
        case 'auto':
          return { auto: {} };
        case 'none':
          return undefined;
        case 'required':
          return { any: {} };
      }
    }

    return { tool: { name: choice.function.name } };
  }

  private parseResponse(response: ConverseCommandOutput): ChatResponse {
    const message = response.output?.message;
    let content = '';
    const toolCalls: ToolCall[] = [];

    if (message?.content) {
      for (const block of message.content) {
        if ('text' in block && block.text) {
          content += block.text;
        } else if ('toolUse' in block && block.toolUse) {
          toolCalls.push({
            id: block.toolUse.toolUseId ?? '',
            name: block.toolUse.name ?? '',
            arguments: (block.toolUse.input as Record<string, unknown>) ?? {},
          });
        }
      }
    }

    return {
      id: this.generateId(),
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.mapStopReason(response.stopReason),
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
      },
    };
  }

  private mapStopReason(reason: string | undefined): ChatResponse['finishReason'] {
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

  private tryParseJson(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private wrapBedrockError(error: unknown, ctx: LLMErrorContext): never {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('throttl') || message.includes('rate')) {
        throw createLLMError({ ...ctx, statusCode: 429 }, 429, error.message);
      }
      if (
        message.includes('access denied') ||
        message.includes('unauthorized') ||
        message.includes('credentials')
      ) {
        throw createLLMError({ ...ctx, statusCode: 403 }, 403, error.message);
      }
      if (message.includes('not found') || message.includes('does not exist')) {
        throw createLLMError({ ...ctx, statusCode: 404 }, 404, error.message);
      }
      if (message.includes('validation') || message.includes('invalid')) {
        throw createLLMError({ ...ctx, statusCode: 400 }, 400, error.message);
      }

      throw llmUnavailable(ctx, error.message, error);
    }

    throw llmUnavailable(ctx, String(error));
  }
}
