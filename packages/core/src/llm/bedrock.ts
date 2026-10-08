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
  ChatUsage,
  ToolCall,
  ToolChoice,
  Message,
  MessageContent,
  ContentPart,
  ToolSchema,
} from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';
import { ErrorCode } from '@cogitator-ai/types';
import {
  LLMError,
  createLLMError,
  llmUnavailable,
  llmConfigError,
  type LLMErrorContext,
} from './errors';
import { finishRunsTools, normalizeTurn, toolCallArguments } from './turn';
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
import {
  claudeThinkingParams,
  thinkingBlocksOf,
  type ClaudeThinkingBlock,
  type ClaudeThinkingParams,
} from './anthropic-thinking';
import { fetchImageAsBase64 } from '../utils/image-fetch';

type DocumentType =
  null | boolean | number | string | DocumentType[] | { [key: string]: DocumentType };

interface BedrockRuntimeClientType {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

type SystemContentBlock = { text: string } | { cachePoint: CachePoint };

interface CachePoint {
  type: 'default';
}

interface ReasoningContentBlock {
  reasoningText?: { text: string; signature?: string };
  redactedContent?: Uint8Array;
}

type ToolResultContentBlock = Pick<ContentBlock, 'text' | 'image'>;

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
  reasoningContent?: ReasoningContentBlock;
  cachePoint?: CachePoint;
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
  additionalModelRequestFields?: Record<string, unknown>;
}

interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

interface ConverseCommandOutput {
  output?: {
    message?: {
      content?: ContentBlock[];
    };
  };
  stopReason?: string;
  usage?: BedrockUsage;
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
      reasoningContent?: { text?: string; signature?: string; redactedContent?: Uint8Array };
    };
  };
  contentBlockStop?: {
    contentBlockIndex?: number;
  };
  messageStop?: {
    stopReason?: string;
  };
  metadata?: {
    usage?: BedrockUsage;
  };
}

interface ConverseStreamCommandOutput {
  stream?: AsyncIterable<StreamEvent>;
}

interface BedrockConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Session token of temporary credentials, sent with the static keys */
  sessionToken?: string;
  /** Named profile from the shared AWS config files */
  profile?: string;
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
          if (this.config.profile) {
            clientConfig.profile = this.config.profile;
          }
          if (this.config.accessKeyId && this.config.secretAccessKey) {
            clientConfig.credentials = {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey,
              ...(this.config.sessionToken ? { sessionToken: this.config.sessionToken } : {}),
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
    const state: StreamState = {
      toolUses: [],
      toolCallInputs: new Map(),
      reasoning: new Map(),
      thinking: [],
    };

    if (!response.stream) {
      return;
    }

    try {
      for await (const event of response.stream) {
        yield* this.processStreamEvent(event, id, state);
      }
    } catch (e) {
      if (e instanceof LLMError) throw e;
      throw this.wrapBedrockError(e, ctx);
    }
  }

  private *processStreamEvent(
    event: StreamEvent,
    id: string,
    state: StreamState
  ): Generator<ChatStreamChunk> {
    const { toolUses, toolCallInputs } = state;
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

      if (delta?.reasoningContent) {
        const block = state.reasoning.get(idx) ?? {};
        const { text, signature, redactedContent } = delta.reasoningContent;
        if (text) {
          block.reasoningText = {
            text: (block.reasoningText?.text ?? '') + text,
            signature: block.reasoningText?.signature,
          };
          yield { id, delta: { reasoning: text } };
        }
        if (signature) {
          block.reasoningText = { text: block.reasoningText?.text ?? '', signature };
        }
        if (redactedContent) block.redactedContent = redactedContent;
        state.reasoning.set(idx, block);
      }
    }

    if (event.contentBlockStop) {
      const idx = event.contentBlockStop.contentBlockIndex ?? 0;
      const toolCall = toolCallInputs.get(idx);
      const reasoning = state.reasoning.get(idx);
      if (reasoning) {
        const item = toThinkingItem(reasoning);
        if (item) state.thinking.push(item);
      } else if (toolCall) {
        toolUses.push({ ...toolCall, thinking: state.thinking });
        toolCallInputs.delete(idx);
        state.thinking = [];
      }
    }

    if (event.messageStop) {
      const finishReason = mapClaudeStopReason(event.messageStop.stopReason);
      const toolCalls = finishRunsTools(finishReason)
        ? toolUses.map((use) => ({
            id: use.id,
            name: use.name,
            ...toolCallArguments(use.input),
            ...(use.thinking.length > 0 && { replay: { precedingItems: use.thinking } }),
          }))
        : [];
      const end = normalizeTurn({ finishReason, toolCalls });
      yield { id, delta: { toolCalls: end.toolCalls }, finishReason: end.finishReason };
    }

    if (event.metadata?.usage) {
      yield { id, delta: {}, usage: toChatUsage(event.metadata.usage) };
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
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');

    for (const [index, msg] of messages.entries()) {
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
          const text = await this.convertContentToBlocks(msg.content, signal);
          const toolCalls = (msg as Message & { toolCalls?: ToolCall[] }).toolCalls ?? [];
          const withThinking = index > lastUser;
          const calls = toolCalls.map((tc) => ({
            thinking: withThinking ? thinkingBlocksOf(tc).map(toReasoningContent) : [],
            toolUse: {
              toolUse: { toolUseId: tc.id, name: tc.name, input: tc.arguments as DocumentType },
            },
          }));
          const [first, ...rest] = calls;
          bedrockMessages.push({
            role: 'assistant',
            content: first
              ? [
                  ...first.thinking,
                  ...text,
                  first.toolUse,
                  ...rest.flatMap((call) => [...call.thinking, call.toolUse]),
                ]
              : text,
          });
          break;
        }

        case 'tool': {
          const toolResultBlock: ContentBlock = {
            toolResult: {
              toolUseId: msg.toolCallId ?? '',
              content:
                typeof msg.content === 'string'
                  ? [{ text: msg.content }]
                  : await this.convertContentToBlocks(msg.content, signal),
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

  private buildInferenceConfig(
    request: ChatRequest,
    thinking: ClaudeThinkingParams
  ): InferenceConfiguration | undefined {
    const inferenceConfig: InferenceConfiguration = {};
    const budgetThinking = thinking.thinking?.type === 'enabled';
    if (budgetThinking) inferenceConfig.maxTokens = thinking.maxTokens;
    else if (request.maxTokens !== undefined) inferenceConfig.maxTokens = request.maxTokens;

    const { temperature, topP } = budgetThinking
      ? {}
      : resolveClaudeSampling(request.model, {
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

    const forcedTool = toolChoice?.any !== undefined || toolChoice?.tool !== undefined;
    const reasoning = claudeThinkingParams(
      request.model,
      request.reasoning,
      request.maxTokens ?? 4096
    );
    const thinking =
      reasoning.budgetThinking && forcedTool ? { ...reasoning, thinking: undefined } : reasoning;
    const additional = {
      ...(thinking.thinking && { thinking: thinking.thinking }),
      ...(thinking.effort && { output_config: { effort: thinking.effort } }),
    };
    if (Object.keys(additional).length > 0) {
      input.additionalModelRequestFields = additional;
    }

    const inferenceConfig = this.buildInferenceConfig(request, thinking);
    if (inferenceConfig) {
      input.inferenceConfig = inferenceConfig;
    }

    if (request.cache) {
      input.system = [...(input.system ?? []), { cachePoint: { type: 'default' } }];
      const last = input.messages.at(-1);
      if (last) last.content = [...last.content, { cachePoint: { type: 'default' } }];
    }

    return input;
  }

  private parseResponse(response: ConverseCommandOutput): ChatResponse {
    const message = response.output?.message;
    let content = '';
    let reasoning = '';
    let thinking: Record<string, unknown>[] = [];
    const toolCalls: ToolCall[] = [];

    if (message?.content) {
      for (const block of message.content) {
        if ('text' in block && block.text) {
          content += block.text;
        } else if (block.reasoningContent) {
          reasoning += block.reasoningContent.reasoningText?.text ?? '';
          const item = toThinkingItem(block.reasoningContent);
          if (item) thinking.push(item);
        } else if ('toolUse' in block && block.toolUse) {
          toolCalls.push({
            id: block.toolUse.toolUseId ?? '',
            name: block.toolUse.name ?? '',
            arguments: (block.toolUse.input as Record<string, unknown>) ?? {},
            ...(thinking.length > 0 && { replay: { precedingItems: thinking } }),
          });
          thinking = [];
        }
      }
    }

    return normalizeTurn({
      id: this.generateId(),
      content,
      toolCalls,
      finishReason: mapClaudeStopReason(response.stopReason),
      usage: toChatUsage(response.usage ?? {}),
      ...(reasoning && { reasoning }),
    });
  }

  /**
   * An AWS SDK error as an `LLMError`, classified by the exception's name, then by its HTTP
   * status, and only for errors with neither by whole words of its message.
   */
  private wrapBedrockError(error: unknown, ctx: LLMErrorContext): never {
    if (!(error instanceof Error)) throw llmUnavailable(ctx, String(error));

    if (error.name === 'ModelTimeoutException') {
      throw new LLMError(error.message, ErrorCode.LLM_TIMEOUT, ctx, {
        cause: error,
        retryable: true,
      });
    }
    const status =
      BEDROCK_EXCEPTION_STATUS[error.name] ??
      (error as AWSServiceError).$metadata?.httpStatusCode ??
      statusFromMessage(error.message);
    if (status !== undefined) {
      throw createLLMError({ ...ctx, statusCode: status }, status, error.message, {
        cause: error,
      });
    }
    throw llmUnavailable(ctx, error.message, error);
  }
}

/** The HTTP status each Bedrock Runtime exception stands for, as the runtime should treat it. */
const BEDROCK_EXCEPTION_STATUS: Record<string, number> = {
  ValidationException: 400,
  UnrecognizedClientException: 401,
  ExpiredTokenException: 401,
  AccessDeniedException: 403,
  ResourceNotFoundException: 404,
  ThrottlingException: 429,
  ServiceQuotaExceededException: 429,
  InternalServerException: 500,
  ModelErrorException: 502,
  ModelStreamErrorException: 502,
  ServiceUnavailableException: 503,
  ModelNotReadyException: 503,
};

interface AWSServiceError extends Error {
  $metadata?: { httpStatusCode?: number };
}

/** A status for an error that carries neither an exception name nor an HTTP status. */
function statusFromMessage(message: string): number | undefined {
  const lower = message.toLowerCase();
  if (/\bthrottl|\brate limit|\btoo many requests\b/.test(lower)) return 429;
  if (/\baccess denied\b|\bnot authorized\b|\bunauthorized\b|\bsecurity token\b/.test(lower)) {
    return 403;
  }
  return undefined;
}

interface StreamState {
  /** Finished `toolUse` blocks, kept as raw JSON until the turn's stop reason is known */
  toolUses: Array<{ id: string; name: string; input: string; thinking: Record<string, unknown>[] }>;
  toolCallInputs: Map<number, { id: string; name: string; input: string }>;
  reasoning: Map<number, ReasoningContentBlock>;
  thinking: Record<string, unknown>[];
}

/**
 * Bedrock reports uncached input apart from cache reads and writes, like the
 * Anthropic API; the total input is their sum.
 */
function toChatUsage(usage: BedrockUsage): ChatUsage {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const inputTokens = (usage.inputTokens ?? 0) + cacheRead + cacheWrite;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead > 0 && { cachedInputTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
  };
}

/** A Bedrock reasoning block in the format Claude thinking blocks are kept in. */
function toThinkingItem(block: ReasoningContentBlock): Record<string, unknown> | undefined {
  if (block.redactedContent) {
    return {
      type: 'redacted_thinking',
      data: Buffer.from(block.redactedContent).toString('base64'),
    };
  }
  if (block.reasoningText?.signature) {
    return {
      type: 'thinking',
      thinking: block.reasoningText.text,
      signature: block.reasoningText.signature,
    };
  }
  return undefined;
}

function toReasoningContent(block: ClaudeThinkingBlock): ContentBlock {
  return block.type === 'thinking'
    ? { reasoningContent: { reasoningText: { text: block.thinking, signature: block.signature } } }
    : { reasoningContent: { redactedContent: Buffer.from(block.data, 'base64') } };
}
