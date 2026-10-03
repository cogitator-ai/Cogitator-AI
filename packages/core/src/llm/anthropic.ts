/**
 * Anthropic LLM Backend
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  ToolChoice,
  Message,
  MessageContent,
  ContentPart,
} from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';
import { type LLMError, wrapSDKError, type LLMErrorContext } from './errors';
import {
  createWarnOnce,
  forcedToolChoiceInstruction,
  jsonOutputInstruction,
  mapClaudeStopReason,
  resolveClaudeSampling,
  supportsForcedToolChoice,
  supportsNativeStructuredOutput,
} from './claude-models';
import { toClaudeStrictJsonSchema } from './claude-json-schema';
import { getLogger } from '../logger';

interface AnthropicConfig {
  apiKey: string;
}

const JSON_RESPONSE_TOOL = '__json_response';

interface AnthropicToolInput {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export class AnthropicBackend extends BaseLLMBackend {
  static readonly DEFAULT_MODEL = 'claude-sonnet-5-5';

  readonly provider = 'anthropic' as const;
  private client: Anthropic;
  private readonly warnOnce = createWarnOnce();

  constructor(config: AnthropicConfig) {
    super();
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = this.resolveModel(request.model);
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model,
    };

    const { system, messages } = this.convertMessages(request.messages);
    const { tools, toolChoice, systemSuffix, outputConfig } = this.prepareJsonMode(request, model);

    const allTools = [
      ...(request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as AnthropicToolInput,
      })) ?? []),
      ...tools,
    ];

    let response: Anthropic.Message;
    try {
      const params = {
        model,
        system: this.buildSystemPrompt(system, systemSuffix),
        messages,
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: toolChoice,
        max_tokens: request.maxTokens ?? 4096,
        ...this.buildSamplingParams(model, request),
        stop_sequences: request.stop,
        ...(outputConfig && { output_config: outputConfig }),
      };

      response = request.signal
        ? await this.client.messages.create(params, { signal: request.signal })
        : await this.client.messages.create(params);
    } catch (e) {
      throw this.wrapAnthropicError(e, ctx);
    }

    const toolCalls: ToolCall[] = [];
    let content = '';
    let jsonSchemaResponse: Record<string, unknown> | null = null;

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (block.name === JSON_RESPONSE_TOOL) {
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
      finishReason:
        jsonSchemaResponse && toolCalls.length === 0
          ? 'stop'
          : mapClaudeStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const model = this.resolveModel(request.model);
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model,
    };

    const { system, messages } = this.convertMessages(request.messages);
    const { tools, toolChoice, systemSuffix, outputConfig } = this.prepareJsonMode(request, model);

    const allTools = [
      ...(request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as AnthropicToolInput,
      })) ?? []),
      ...tools,
    ];

    let stream: ReturnType<typeof this.client.messages.stream>;
    try {
      const params = {
        model,
        system: this.buildSystemPrompt(system, systemSuffix),
        messages,
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: toolChoice,
        max_tokens: request.maxTokens ?? 4096,
        ...this.buildSamplingParams(model, request),
        stop_sequences: request.stop,
        ...(outputConfig && { output_config: outputConfig }),
      };

      stream = request.signal
        ? this.client.messages.stream(params, { signal: request.signal })
        : this.client.messages.stream(params);
    } catch (e) {
      throw this.wrapAnthropicError(e, ctx);
    }

    const id = this.generateId();
    const toolCalls: ToolCall[] = [];
    let currentToolCall: Partial<ToolCall> | null = null;
    let currentToolName = '';
    let inputJson = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let jsonSchemaContent = '';
    let streamStopReason: string | null = null;

    try {
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
            currentToolCall.arguments = this.parseToolInput(inputJson, currentToolName);

            if (currentToolName === JSON_RESPONSE_TOOL) {
              jsonSchemaContent = JSON.stringify(currentToolCall.arguments);
            } else {
              toolCalls.push(currentToolCall as ToolCall);
            }
            currentToolCall = null;
            currentToolName = '';
          }
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
          const stopReason = (event as { delta?: { stop_reason?: string | null } }).delta
            ?.stop_reason;
          if (stopReason) {
            streamStopReason = stopReason;
          }
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
            finishReason:
              toolCalls.length > 0
                ? 'tool_calls'
                : jsonSchemaContent
                  ? 'stop'
                  : mapClaudeStopReason(streamStopReason),
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            },
          };
        }
      }
    } catch (e) {
      throw this.wrapAnthropicError(e, ctx);
    }
  }

  private parseToolInput(inputJson: string, toolName: string): Record<string, unknown> {
    if (!inputJson.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(inputJson) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (e) {
      getLogger().warn('Failed to parse tool call arguments in Anthropic stream', {
        toolName,
        inputJson: inputJson.slice(0, 200),
        error: e instanceof Error ? e.message : String(e),
      });
      return {};
    }
  }

  private buildSystemPrompt(system: string, suffix: string): string | undefined {
    const combined = [system, suffix].filter((part) => part.length > 0).join('\n\n');
    return combined.length > 0 ? combined : undefined;
  }

  private convertMessages(messages: Message[]): {
    system: string;
    messages: Anthropic.MessageParam[];
  } {
    const systemParts: string[] = [];
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const m of messages) {
      switch (m.role) {
        case 'system': {
          const text = this.getTextContent(m.content);
          if (text) systemParts.push(text);
          break;
        }
        case 'user':
          anthropicMessages.push({
            role: 'user',
            content: this.convertContent(m.content),
          });
          break;
        case 'assistant':
          anthropicMessages.push({
            role: 'assistant',
            content: this.convertAssistantContent(m),
          });
          break;
        case 'tool': {
          const toolResult: Anthropic.ToolResultBlockParam = {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: this.getTextContent(m.content),
          };
          const previous = anthropicMessages[anthropicMessages.length - 1];
          if (
            previous?.role === 'user' &&
            Array.isArray(previous.content) &&
            previous.content.length > 0 &&
            previous.content.every((block) => block.type === 'tool_result')
          ) {
            previous.content.push(toolResult);
          } else {
            anthropicMessages.push({ role: 'user', content: [toolResult] });
          }
          break;
        }
      }
    }

    return { system: systemParts.join('\n\n'), messages: anthropicMessages };
  }

  private convertContent(content: MessageContent): string | Anthropic.ContentBlockParam[] {
    if (typeof content === 'string') {
      return content;
    }

    return content.map((part) => this.convertContentPart(part));
  }

  private convertAssistantContent(message: Message): string | Anthropic.ContentBlockParam[] {
    const content = this.convertContent(message.content);
    const toolCalls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      return content;
    }

    const blocks: Anthropic.ContentBlockParam[] =
      typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content;

    blocks.push(
      ...toolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      }))
    );

    return blocks;
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

  private resolveModel(model: string): string {
    const trimmed = model.trim();
    return trimmed.length > 0 ? trimmed : AnthropicBackend.DEFAULT_MODEL;
  }

  private buildSamplingParams(
    model: string,
    request: ChatRequest
  ): Pick<Anthropic.MessageCreateParams, 'temperature' | 'top_p'> {
    const { temperature, topP } = resolveClaudeSampling(model, {
      temperature: request.temperature,
      topP: request.topP,
    });
    return {
      ...(temperature !== undefined && { temperature }),
      ...(topP !== undefined && { top_p: topP }),
    };
  }

  private prepareJsonMode(
    request: ChatRequest,
    model: string
  ): {
    tools: Array<{ name: string; description: string; input_schema: AnthropicToolInput }>;
    toolChoice: Anthropic.MessageCreateParams['tool_choice'];
    systemSuffix: string;
    outputConfig?: Anthropic.OutputConfig;
  } {
    const format = request.responseFormat;

    if (!format || format.type === 'text' || format.type === 'json_object') {
      const { toolChoice, instruction } = this.convertToolChoice(request.toolChoice, model);
      const jsonInstruction = format?.type === 'json_object' ? jsonOutputInstruction() : '';
      return {
        tools: [],
        toolChoice,
        systemSuffix: [instruction, jsonInstruction].filter((part) => part.length > 0).join('\n\n'),
      };
    }

    const { jsonSchema } = format;

    if (supportsNativeStructuredOutput(model)) {
      const { toolChoice, instruction } = this.convertToolChoice(request.toolChoice, model);
      const schema = toClaudeStrictJsonSchema(jsonSchema.schema);
      if (jsonSchema.description && typeof schema.description !== 'string') {
        schema.description = jsonSchema.description;
      }
      return {
        tools: [],
        toolChoice,
        systemSuffix: instruction,
        outputConfig: { format: { type: 'json_schema', schema } },
      };
    }

    if (request.tools?.length) {
      const { toolChoice, instruction } = this.convertToolChoice(request.toolChoice, model);
      return {
        tools: [],
        toolChoice,
        systemSuffix: [instruction, jsonOutputInstruction(jsonSchema.schema)]
          .filter((part) => part.length > 0)
          .join('\n\n'),
      };
    }

    const schema = jsonSchema.schema;
    const inputSchema: AnthropicToolInput = {
      ...schema,
      type: 'object',
      properties: (schema.properties ?? {}) as Record<string, unknown>,
      required: schema.required as string[] | undefined,
    };

    const jsonSchemaTool = {
      name: JSON_RESPONSE_TOOL,
      description: jsonSchema.description ?? 'Respond with structured JSON data',
      input_schema: inputSchema,
    };

    return {
      tools: [jsonSchemaTool],
      toolChoice: { type: 'tool' as const, name: JSON_RESPONSE_TOOL },
      systemSuffix: '',
    };
  }

  /**
   * Map a provider-neutral tool choice to Anthropic's `tool_choice`. Models that
   * reject forced tool use (Claude Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1 and
   * later) get `auto` plus a system-prompt instruction naming the required tool,
   * and a one-time warning is logged per model and choice kind.
   */
  private convertToolChoice(
    choice: ToolChoice | undefined,
    model: string
  ): { toolChoice: Anthropic.MessageCreateParams['tool_choice']; instruction: string } {
    if (!choice) return { toolChoice: undefined, instruction: '' };

    if (choice === 'auto') return { toolChoice: { type: 'auto' }, instruction: '' };
    if (choice === 'none') return { toolChoice: { type: 'none' }, instruction: '' };

    const toolName = choice === 'required' ? undefined : choice.function.name;
    if (supportsForcedToolChoice(model)) {
      return {
        toolChoice: toolName ? { type: 'tool', name: toolName } : { type: 'any' },
        instruction: '',
      };
    }

    this.warnOnce(
      `forced-tool-choice:${model}:${toolName ? 'tool' : 'any'}`,
      `${model} does not support forced tool use; falling back to tool_choice "auto" with a system-prompt instruction`,
      { provider: this.provider, model, requested: toolName ?? 'required' }
    );
    return { toolChoice: { type: 'auto' }, instruction: forcedToolChoiceInstruction(toolName) };
  }

  private wrapAnthropicError(error: unknown, ctx: LLMErrorContext): LLMError {
    return wrapSDKError(error, ctx);
  }
}
