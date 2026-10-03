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
import {
  createWarnOnce,
  forcedToolChoiceInstruction,
  jsonOutputInstruction,
  mapClaudeStopReason,
  resolveClaudeSampling,
  supportsBedrockStructuredOutput,
  supportsForcedToolChoice,
} from './claude-models';
import { toClaudeStrictJsonSchema } from './claude-json-schema';
import { fetchImageAsBase64 } from '../utils/image-fetch';
import { getLogger } from '../logger';

type DocumentType =
  null | boolean | number | string | DocumentType[] | { [key: string]: DocumentType };

interface BedrockRuntimeClientType {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

interface SystemContentBlock {
  text: string;
}

interface ToolResultContentBlock {
  text: string;
}

interface ToolResultBlock {
  toolUseId: string;
  content: ToolResultContentBlock[];
}

interface ContentBlock {
  text?: string;
  image?: {
    format: 'png' | 'jpeg' | 'gif' | 'webp';
    source: { bytes: Uint8Array };
  };
  toolUse?: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
  toolResult?: ToolResultBlock;
}

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

interface InferenceConfiguration {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: { json: DocumentType };
}

interface BedrockTool {
  toolSpec?: ToolSpec;
}

interface ToolChoiceConfig {
  auto?: Record<string, never>;
  any?: Record<string, never>;
  tool?: { name: string };
}

interface ToolConfiguration {
  tools?: BedrockTool[];
  toolChoice?: ToolChoiceConfig;
}

interface OutputConfiguration {
  textFormat?: {
    type: 'json_schema';
    structure: {
      jsonSchema: {
        schema: string;
        name?: string;
        description?: string;
      };
    };
  };
}

interface ConverseCommandInput {
  modelId: string;
  messages: BedrockMessage[];
  system?: SystemContentBlock[];
  toolConfig?: ToolConfiguration;
  inferenceConfig?: InferenceConfiguration;
  outputConfig?: OutputConfiguration;
}

interface ConverseCommandOutput {
  output?: {
    message?: {
      content?: ContentBlock[];
    };
  };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

type ConverseStreamCommandInput = ConverseCommandInput;

interface StreamEvent {
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: {
      toolUse?: {
        toolUseId?: string;
        name?: string;
      };
    };
  };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: {
      text?: string;
      toolUse?: {
        input?: string;
      };
    };
  };
  contentBlockStop?: {
    contentBlockIndex?: number;
  };
  messageStop?: {
    stopReason?: string;
  };
  metadata?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
}

interface ConverseStreamCommandOutput {
  stream?: AsyncIterable<StreamEvent>;
}

interface BedrockConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Retries the provider's SDK makes on its own; leave unset for the SDK default. The runtime passes 0 and retries itself. */
  maxRetries?: number;
}

export class BedrockBackend extends BaseLLMBackend {
  readonly provider = 'bedrock' as const;
  private config: BedrockConfig;
  private clientPromise: Promise<BedrockRuntimeClientType> | null = null;
  private readonly warnOnce = createWarnOnce();

  constructor(config: BedrockConfig) {
    super();
    this.config = config;
  }

  private async getClient(): Promise<BedrockRuntimeClientType> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const ctx: LLMErrorContext = { provider: this.provider };
        try {
          const moduleName = '@aws-sdk/client-bedrock-runtime';
          const { BedrockRuntimeClient } = await import(/* webpackIgnore: true */ moduleName);

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

          if (this.config.maxRetries !== undefined) {
            clientConfig.maxAttempts = this.config.maxRetries + 1;
          }

          return new BedrockRuntimeClient(clientConfig);
        } catch {
          this.clientPromise = null;
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
    const moduleName = '@aws-sdk/client-bedrock-runtime';
    const { ConverseCommand } = await import(/* webpackIgnore: true */ moduleName);

    const input = await this.buildConverseInput(request);

    let response: ConverseCommandOutput;
    try {
      const command = new ConverseCommand(input as ConverseCommandInput);
      response = (await (request.signal
        ? client.send(command, { abortSignal: request.signal })
        : client.send(command))) as ConverseCommandOutput;
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
    const moduleName = '@aws-sdk/client-bedrock-runtime';
    const { ConverseStreamCommand } = await import(/* webpackIgnore: true */ moduleName);

    const input: ConverseStreamCommandInput = await this.buildConverseInput(request);

    const command = new ConverseStreamCommand(input as ConverseStreamCommandInput);
    let response: ConverseStreamCommandOutput;
    try {
      response = (await (request.signal
        ? client.send(command, { abortSignal: request.signal })
        : client.send(command))) as ConverseStreamCommandOutput;
    } catch (e) {
      throw this.wrapBedrockError(e, ctx);
    }

    const id = this.generateId();
    const toolCalls: ToolCall[] = [];
    const toolCallInputs = new Map<number, { id: string; name: string; input: string }>();

    if (!response.stream) {
      return;
    }

    try {
      for await (const event of response.stream) {
        yield* this.processStreamEvent(event, id, toolCalls, toolCallInputs);
      }
    } catch (e) {
      throw this.wrapBedrockError(e, ctx);
    }
  }

  private *processStreamEvent(
    event: StreamEvent,
    id: string,
    toolCalls: ToolCall[],
    toolCallInputs: Map<number, { id: string; name: string; input: string }>
  ): Generator<ChatStreamChunk> {
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
      const finishReason = mapClaudeStopReason(event.messageStop.stopReason);
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

  private async convertMessages(
    messages: Message[],
    signal?: AbortSignal
  ): Promise<{
    system: string | null;
    messages: BedrockMessage[];
  }> {
    const systemParts: string[] = [];
    const bedrockMessages: BedrockMessage[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case 'system': {
          const text = this.getTextContent(msg.content);
          if (text) systemParts.push(text);
          break;
        }

        case 'user':
          bedrockMessages.push({
            role: 'user',
            content: await this.convertContentToBlocks(msg.content, signal),
          });
          break;

        case 'assistant': {
          const blocks = await this.convertContentToBlocks(msg.content, signal);
          const toolCalls = (msg as Message & { toolCalls?: ToolCall[] }).toolCalls;
          if (toolCalls && toolCalls.length > 0) {
            blocks.push(
              ...toolCalls.map((tc) => ({
                toolUse: {
                  toolUseId: tc.id,
                  name: tc.name,
                  input: tc.arguments as DocumentType,
                },
              }))
            );
          }
          bedrockMessages.push({
            role: 'assistant',
            content: blocks,
          });
          break;
        }

        case 'tool': {
          const toolResultBlock: ContentBlock = {
            toolResult: {
              toolUseId: msg.toolCallId ?? '',
              content: [{ text: this.getTextContent(msg.content) }],
            },
          };
          const previous = bedrockMessages[bedrockMessages.length - 1];
          if (
            previous?.role === 'user' &&
            previous.content.length > 0 &&
            previous.content.every((block) => block.toolResult !== undefined)
          ) {
            previous.content.push(toolResultBlock);
          } else {
            bedrockMessages.push({ role: 'user', content: [toolResultBlock] });
          }
          break;
        }
      }
    }

    return {
      system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
      messages: bedrockMessages,
    };
  }

  private async convertContentToBlocks(
    content: MessageContent,
    signal?: AbortSignal
  ): Promise<ContentBlock[]> {
    if (typeof content === 'string') {
      return content ? [{ text: content }] : [];
    }

    const blocks = await Promise.all(content.map((part) => this.convertContentPart(part, signal)));
    return blocks.filter((b): b is ContentBlock => b !== null);
  }

  private async convertContentPart(
    part: ContentPart,
    signal?: AbortSignal
  ): Promise<ContentBlock | null> {
    switch (part.type) {
      case 'text':
        return { text: part.text };
      case 'image_base64':
        return {
          image: {
            format: (part.image_base64.media_type.split('/')[1] || 'png') as
              'png' | 'jpeg' | 'gif' | 'webp',
            source: {
              bytes: Uint8Array.from(atob(part.image_base64.data), (c) => c.charCodeAt(0)),
            },
          },
        };
      case 'image_url': {
        const fetched = await fetchImageAsBase64(part.image_url.url, { signal });
        const format = (fetched.mediaType.split('/')[1] || 'png') as
          'png' | 'jpeg' | 'gif' | 'webp';
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

  private buildInferenceConfig(request: ChatRequest): InferenceConfiguration | undefined {
    const inferenceConfig: InferenceConfiguration = {};
    if (request.maxTokens !== undefined) inferenceConfig.maxTokens = request.maxTokens;

    const { temperature, topP } = resolveClaudeSampling(request.model, {
      temperature: request.temperature,
      topP: request.topP,
    });
    if (temperature !== undefined) inferenceConfig.temperature = temperature;
    if (topP !== undefined) inferenceConfig.topP = topP;
    if (request.stop) inferenceConfig.stopSequences = request.stop;

    return Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined;
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

  /**
   * Map a provider-neutral tool choice to Converse `toolChoice`. Claude models that
   * reject forced tool use (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1 and later)
   * get `auto` plus a system-prompt instruction naming the required tool, and a
   * one-time warning is logged per model and choice kind.
   */
  private convertToolChoice(
    choice: ToolChoice | undefined,
    model: string
  ): { toolChoice: ToolChoiceConfig | undefined; instruction: string } {
    if (!choice || choice === 'none') return { toolChoice: undefined, instruction: '' };
    if (choice === 'auto') return { toolChoice: { auto: {} }, instruction: '' };

    const toolName = choice === 'required' ? undefined : choice.function.name;
    if (supportsForcedToolChoice(model)) {
      return {
        toolChoice: toolName ? { tool: { name: toolName } } : { any: {} },
        instruction: '',
      };
    }

    this.warnOnce(
      `forced-tool-choice:${model}:${toolName ? 'tool' : 'any'}`,
      `${model} does not support forced tool use; falling back to toolChoice "auto" with a system-prompt instruction`,
      { provider: this.provider, model, requested: toolName ?? 'required' }
    );
    return { toolChoice: { auto: {} }, instruction: forcedToolChoiceInstruction(toolName) };
  }

  /**
   * JSON output for Converse: `outputConfig.textFormat` where Bedrock enforces the
   * schema (Claude 4.5 – 4.6), otherwise a system-prompt instruction.
   */
  private prepareResponseFormat(request: ChatRequest): {
    outputConfig?: OutputConfiguration;
    instruction: string;
  } {
    const format = request.responseFormat;
    if (!format || format.type === 'text') return { instruction: '' };
    if (format.type === 'json_object') return { instruction: jsonOutputInstruction() };

    const { jsonSchema } = format;
    if (!supportsBedrockStructuredOutput(request.model)) {
      return { instruction: jsonOutputInstruction(jsonSchema.schema) };
    }

    return {
      instruction: '',
      outputConfig: {
        textFormat: {
          type: 'json_schema',
          structure: {
            jsonSchema: {
              schema: JSON.stringify(toClaudeStrictJsonSchema(jsonSchema.schema)),
              name: jsonSchema.name,
              ...(jsonSchema.description && { description: jsonSchema.description }),
            },
          },
        },
      },
    };
  }

  private async buildConverseInput(request: ChatRequest): Promise<ConverseCommandInput> {
    const { system, messages } = await this.convertMessages(request.messages, request.signal);
    const input: ConverseCommandInput = {
      modelId: request.model,
      messages,
    };

    const hasTools = request.tools !== undefined && request.tools.length > 0;
    const { toolChoice, instruction: toolInstruction } = hasTools
      ? this.convertToolChoice(request.toolChoice, request.model)
      : { toolChoice: undefined, instruction: '' };

    if (hasTools) {
      input.toolConfig = {
        tools: (request.tools ?? []).map((t) => this.convertTool(t)),
        ...(toolChoice && { toolChoice }),
      };
    }

    const { outputConfig, instruction: formatInstruction } = this.prepareResponseFormat(request);
    if (outputConfig) {
      input.outputConfig = outputConfig;
    }

    const systemText = [system ?? '', toolInstruction, formatInstruction]
      .filter((part) => part.length > 0)
      .join('\n\n');
    if (systemText) {
      input.system = [{ text: systemText }];
    }

    const inferenceConfig = this.buildInferenceConfig(request);
    if (inferenceConfig) {
      input.inferenceConfig = inferenceConfig;
    }

    return input;
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
      finishReason: mapClaudeStopReason(response.stopReason),
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
      },
    };
  }

  private tryParseJson(str: string): Record<string, unknown> {
    if (!str.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(str) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (e) {
      getLogger().warn('Failed to parse tool call JSON in Bedrock stream', {
        input: str.slice(0, 200),
        error: e instanceof Error ? e.message : String(e),
      });
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
