import type {
  JSONSchema7,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  ContentPart,
  LLMBackend,
  LLMProvider,
  LLMResponseFormat,
  Message,
  ToolCall,
  ToolChoice,
} from '@cogitator-ai/types';
import { LLMError } from '@cogitator-ai/core';
import { ErrorCode } from '@cogitator-ai/types';
import { isRecord, type JSONObject, type JSONValue } from './json.js';
import type { AISDKLanguageModel } from './types.js';
import type {
  LanguageModelV1FunctionToolCall,
  LanguageModelV1ImagePart,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
  LanguageModelV1TextPart,
  LanguageModelV1Usage,
} from './v1-types.js';

type CogitatorFinishReason = ChatResponse['finishReason'];

type ImageSource = { kind: 'url'; url: URL } | { kind: 'data'; data: string; mediaType: string };

interface TextPart {
  type: 'text';
  text: string;
}

interface FilePart<TData> {
  type: 'file';
  data: TData;
  mediaType: string;
}

interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  providerOptions?: Record<string, JSONObject>;
}

interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: { type: 'text'; value: string } | { type: 'json'; value: JSONValue };
}

type ModernMessage<TData> =
  | { role: 'system'; content: string }
  | { role: 'user'; content: Array<TextPart | FilePart<TData>> }
  | { role: 'assistant'; content: Array<TextPart | ToolCallPart> }
  | { role: 'tool'; content: ToolResultPart[] };

type V4FileData = { type: 'url'; url: URL } | { type: 'data'; data: string };

interface ModernContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
  providerExecuted?: boolean;
  providerMetadata?: unknown;
}

interface ParsedTurn {
  id?: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: ChatUsage;
}

const DATA_URL = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s;

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function imageSourceOf(part: ContentPart): ImageSource | undefined {
  if (part.type === 'image_base64') {
    return { kind: 'data', data: part.image_base64.data, mediaType: part.image_base64.media_type };
  }
  if (part.type === 'image_url') {
    const match = DATA_URL.exec(part.image_url.url);
    if (match) return { kind: 'data', data: match[2], mediaType: match[1] ?? 'image/*' };
    return { kind: 'url', url: new URL(part.image_url.url) };
  }
  return undefined;
}

function toolCallsOf(message: Message): ToolCall[] {
  const toolCalls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls;
  return toolCalls ?? [];
}

function parseToolOutput(content: string): JSONValue | undefined {
  try {
    return JSON.parse(content) as JSONValue;
  } catch {
    return undefined;
  }
}

function finishReasonOf(reason: string, hasToolCalls: boolean): CogitatorFinishReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function usageFromV1(usage: LanguageModelV1Usage | undefined): ChatUsage {
  const inputTokens = finiteOrZero(usage?.promptTokens);
  const outputTokens = finiteOrZero(usage?.completionTokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function usageFromV2(usage: LanguageModelV2Usage | undefined): ChatUsage {
  const inputTokens = finiteOrZero(usage?.inputTokens);
  const outputTokens = finiteOrZero(usage?.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    reasoningTokens: usage?.reasoningTokens,
  };
}

function usageFromV3(usage: LanguageModelV3Usage | undefined): ChatUsage {
  const inputTokens = finiteOrZero(usage?.inputTokens.total);
  const outputTokens = finiteOrZero(usage?.outputTokens.total);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: usage?.inputTokens.cacheRead,
    reasoningTokens: usage?.outputTokens.reasoning,
  };
}

function thoughtSignatureOf(metadata: unknown): { key: string; signature: string } | undefined {
  if (!isRecord(metadata)) return undefined;
  for (const [key, value] of Object.entries(metadata)) {
    if (isRecord(value) && typeof value.thoughtSignature === 'string') {
      return { key, signature: value.thoughtSignature };
    }
  }
  return undefined;
}

function mapToolChoice(
  choice: ToolChoice | undefined
):
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'required' }
  | { type: 'tool'; toolName: string }
  | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') return { type: choice };
  return { type: 'tool', toolName: choice.function.name };
}

function mapResponseFormat(
  format: LLMResponseFormat | undefined
):
  | { type: 'text' }
  | { type: 'json'; schema?: JSONSchema7; name?: string; description?: string }
  | undefined {
  switch (format?.type) {
    case undefined:
      return undefined;
    case 'text':
      return { type: 'text' };
    case 'json_object':
      return { type: 'json' };
    case 'json_schema':
      return {
        type: 'json',
        schema: format.jsonSchema.schema as JSONSchema7,
        name: format.jsonSchema.name,
        description: format.jsonSchema.description,
      };
  }
}

/**
 * Cogitator `LLMBackend` backed by an AI SDK language model. Supports every language model
 * specification the AI SDK has shipped: v1 (ai@4), v2 (ai@5), v3 (ai@6) and v4 (ai@7).
 */
export class AISDKBackend implements LLMBackend {
  readonly provider: LLMProvider;

  private readonly model: AISDKLanguageModel;
  private thoughtSignatureKey: string | undefined;

  constructor(model: AISDKLanguageModel) {
    this.model = model;
    this.provider = (model.provider ?? 'ai-sdk') as LLMProvider;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const turn = await this.generate(request);
    return {
      id: turn.id ?? `aisdk-${Date.now()}`,
      content: turn.content,
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
      finishReason: finishReasonOf(turn.finishReason, turn.toolCalls.length > 0),
      usage: turn.usage,
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const chunkId = `aisdk-stream-${Date.now()}`;
    let hasToolCalls = false;

    for await (const event of this.streamEvents(request)) {
      switch (event.type) {
        case 'text':
          yield { id: chunkId, delta: { content: event.delta } };
          break;
        case 'tool-call':
          hasToolCalls = true;
          yield { id: chunkId, delta: { toolCalls: [event.toolCall] } };
          break;
        case 'finish':
          yield {
            id: chunkId,
            delta: {},
            finishReason: finishReasonOf(event.finishReason, hasToolCalls),
            usage: event.usage,
          };
          break;
      }
    }
  }

  private async *streamEvents(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const model = this.model;
    switch (model.specificationVersion) {
      case 'v1': {
        const { stream } = await model.doStream(this.v1Options(request));
        for await (const part of readStream(stream)) {
          const event = this.fromV1StreamPart(part);
          if (event) yield event;
        }
        break;
      }
      case 'v2': {
        const { stream } = await model.doStream(this.modernOptions(request, toV2FileData));
        for await (const part of readStream(stream)) {
          const event = this.fromModernStreamPart(part);
          if (event) yield event;
        }
        break;
      }
      case 'v3': {
        const { stream } = await model.doStream(this.modernOptions(request, toV2FileData));
        for await (const part of readStream(stream)) {
          const event = this.fromModernStreamPart(part);
          if (event) yield event;
        }
        break;
      }
      case 'v4': {
        const { stream } = await model.doStream(this.modernOptions(request, toV4FileData));
        for await (const part of readStream(stream)) {
          const event = this.fromModernStreamPart(part);
          if (event) yield event;
        }
        break;
      }
    }
  }

  private fromV1StreamPart(part: LanguageModelV1StreamPart): StreamEvent | undefined {
    switch (part.type) {
      case 'text-delta':
        return part.textDelta ? { type: 'text', delta: part.textDelta } : undefined;
      case 'tool-call':
        return { type: 'tool-call', toolCall: this.fromV1ToolCall(part) };
      case 'finish':
        return { type: 'finish', finishReason: part.finishReason, usage: usageFromV1(part.usage) };
      case 'error':
        throw toError(part.error);
      default:
        return undefined;
    }
  }

  private fromModernStreamPart(
    part: LanguageModelV2StreamPart | LanguageModelV3StreamPart | LanguageModelV4StreamPart
  ): StreamEvent | undefined {
    switch (part.type) {
      case 'text-delta':
        return part.delta ? { type: 'text', delta: part.delta } : undefined;
      case 'tool-call': {
        if (part.providerExecuted) return undefined;
        const toolCall = this.fromModernToolCall(part);
        return toolCall ? { type: 'tool-call', toolCall } : undefined;
      }
      case 'finish':
        return typeof part.finishReason === 'string'
          ? {
              type: 'finish',
              finishReason: part.finishReason,
              usage: usageFromV2(part.usage as LanguageModelV2Usage),
            }
          : {
              type: 'finish',
              finishReason: part.finishReason.unified,
              usage: usageFromV3(part.usage as LanguageModelV3Usage),
            };
      case 'error':
        throw toError(part.error);
      default:
        return undefined;
    }
  }

  private async generate(request: ChatRequest): Promise<ParsedTurn> {
    const model = this.model;
    switch (model.specificationVersion) {
      case 'v1': {
        const result = await model.doGenerate(this.v1Options(request));
        return {
          id: result.response?.id,
          content: result.text ?? '',
          toolCalls: (result.toolCalls ?? []).map((call) => this.fromV1ToolCall(call)),
          finishReason: result.finishReason,
          usage: usageFromV1(result.usage),
        };
      }
      case 'v2': {
        const result = await model.doGenerate(this.modernOptions(request, toV2FileData));
        return this.modernTurn(
          result.content,
          result.finishReason,
          usageFromV2(result.usage),
          result.response?.id
        );
      }
      case 'v3':
      case 'v4': {
        const result =
          model.specificationVersion === 'v3'
            ? await model.doGenerate(this.modernOptions(request, toV2FileData))
            : await model.doGenerate(this.modernOptions(request, toV4FileData));
        return this.modernTurn(
          result.content,
          result.finishReason.unified,
          usageFromV3(result.usage),
          result.response?.id
        );
      }
    }
  }

  private modernTurn(
    content: ReadonlyArray<ModernContentPart>,
    finishReason: string,
    usage: ChatUsage,
    id: string | undefined
  ): ParsedTurn {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        text += part.text;
      } else if (part.type === 'tool-call' && !part.providerExecuted) {
        const toolCall = this.fromModernToolCall(part);
        if (toolCall) toolCalls.push(toolCall);
      }
    }
    return { id, content: text, toolCalls, finishReason, usage };
  }

  private fromV1ToolCall(call: LanguageModelV1FunctionToolCall): ToolCall {
    return {
      id: call.toolCallId,
      name: call.toolName,
      arguments: this.parseArguments(call.args, call.toolName),
    };
  }

  private fromModernToolCall(part: ModernContentPart): ToolCall | undefined {
    if (part.toolCallId === undefined || part.toolName === undefined) return undefined;
    const toolCall: ToolCall = {
      id: part.toolCallId,
      name: part.toolName,
      arguments: this.parseArguments(part.input ?? '', part.toolName),
    };
    const thought = thoughtSignatureOf(part.providerMetadata);
    if (thought) {
      this.thoughtSignatureKey = thought.key;
      toolCall.thoughtSignature = thought.signature;
    }
    return toolCall;
  }

  private parseArguments(input: string, toolName: string): Record<string, unknown> {
    if (!input.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new LLMError(
        `Failed to parse arguments of tool call "${toolName}": ${input.slice(0, 100)}`,
        ErrorCode.LLM_INVALID_RESPONSE,
        { provider: this.model.provider, model: this.model.modelId },
        { cause: error instanceof Error ? error : undefined }
      );
    }
    if (parsed === null) return {};
    if (!isRecord(parsed)) {
      throw new LLMError(
        `Arguments of tool call "${toolName}" must be a JSON object: ${input.slice(0, 100)}`,
        ErrorCode.LLM_INVALID_RESPONSE,
        { provider: this.model.provider, model: this.model.modelId }
      );
    }
    return parsed;
  }

  private v1Options(request: ChatRequest) {
    const tools = request.tools?.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JSONSchema7,
    }));
    return {
      inputFormat: 'messages' as const,
      mode: {
        type: 'regular' as const,
        tools: tools && tools.length > 0 ? tools : undefined,
        toolChoice: tools && tools.length > 0 ? mapToolChoice(request.toolChoice) : undefined,
      },
      prompt: toV1Prompt(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      stopSequences: request.stop,
      responseFormat: mapResponseFormat(request.responseFormat),
      abortSignal: request.signal,
    };
  }

  private modernOptions<TData>(request: ChatRequest, toFileData: (source: ImageSource) => TData) {
    const tools = request.tools?.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as JSONSchema7,
    }));
    const hasTools = tools !== undefined && tools.length > 0;
    return {
      prompt: this.toModernPrompt(request.messages, toFileData),
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      stopSequences: request.stop,
      tools: hasTools ? tools : undefined,
      toolChoice: hasTools ? mapToolChoice(request.toolChoice) : undefined,
      responseFormat: mapResponseFormat(request.responseFormat),
      abortSignal: request.signal,
    };
  }

  private toModernPrompt<TData>(
    messages: Message[],
    toFileData: (source: ImageSource) => TData
  ): ModernMessage<TData>[] {
    const prompt: ModernMessage<TData>[] = [];

    for (const message of messages) {
      switch (message.role) {
        case 'system':
          prompt.push({ role: 'system', content: textOf(message.content) });
          break;
        case 'user': {
          const content: Array<TextPart | FilePart<TData>> = [];
          for (const part of typeof message.content === 'string'
            ? [{ type: 'text' as const, text: message.content }]
            : message.content) {
            const image = imageSourceOf(part);
            if (image) {
              content.push({
                type: 'file',
                data: toFileData(image),
                mediaType: image.kind === 'data' ? image.mediaType : 'image/*',
              });
            } else if (part.type === 'text') {
              content.push({ type: 'text', text: part.text });
            }
          }
          prompt.push({ role: 'user', content });
          break;
        }
        case 'assistant': {
          const text = textOf(message.content);
          const content: Array<TextPart | ToolCallPart> = text ? [{ type: 'text', text }] : [];
          for (const call of toolCallsOf(message)) {
            content.push({
              type: 'tool-call',
              toolCallId: call.id,
              toolName: call.name,
              input: call.arguments,
              providerOptions: this.thoughtSignatureOptions(call),
            });
          }
          if (content.length > 0) prompt.push({ role: 'assistant', content });
          break;
        }
        case 'tool': {
          const text = textOf(message.content);
          const json = parseToolOutput(text);
          const part: ToolResultPart = {
            type: 'tool-result',
            toolCallId: message.toolCallId ?? '',
            toolName: message.name ?? '',
            output:
              json === undefined ? { type: 'text', value: text } : { type: 'json', value: json },
          };
          const previous = prompt[prompt.length - 1];
          if (previous?.role === 'tool') {
            previous.content.push(part);
          } else {
            prompt.push({ role: 'tool', content: [part] });
          }
          break;
        }
      }
    }

    return prompt;
  }

  private thoughtSignatureOptions(call: ToolCall): Record<string, JSONObject> | undefined {
    if (!call.thoughtSignature) return undefined;
    const key = this.thoughtSignatureKey ?? this.model.provider.split('.')[0];
    return { [key]: { thoughtSignature: call.thoughtSignature } };
  }
}

type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; toolCall: ToolCall }
  | { type: 'finish'; finishReason: string; usage: ChatUsage };

async function* readStream<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toV2FileData(source: ImageSource): URL | string {
  return source.kind === 'url' ? source.url : source.data;
}

function toV4FileData(source: ImageSource): V4FileData {
  return source.kind === 'url'
    ? { type: 'url', url: source.url }
    : { type: 'data', data: source.data };
}

function toV1Prompt(messages: Message[]): LanguageModelV1Prompt {
  const prompt: LanguageModelV1Prompt = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        prompt.push({ role: 'system', content: textOf(message.content) });
        break;
      case 'user': {
        const content: Array<LanguageModelV1TextPart | LanguageModelV1ImagePart> = [];
        for (const part of typeof message.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : message.content) {
          const image = imageSourceOf(part);
          if (image) {
            content.push(
              image.kind === 'url'
                ? { type: 'image', image: image.url }
                : {
                    type: 'image',
                    image: Uint8Array.from(Buffer.from(image.data, 'base64')),
                    mimeType: image.mediaType,
                  }
            );
          } else if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          }
        }
        prompt.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const text = textOf(message.content);
        const toolCalls = toolCallsOf(message);
        if (!text && toolCalls.length === 0) break;
        prompt.push({
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...toolCalls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              args: call.arguments,
            })),
          ],
        });
        break;
      }
      case 'tool': {
        const text = textOf(message.content);
        const part = {
          type: 'tool-result' as const,
          toolCallId: message.toolCallId ?? '',
          toolName: message.name ?? '',
          result: parseToolOutput(text) ?? text,
        };
        const previous = prompt[prompt.length - 1];
        if (previous?.role === 'tool') {
          previous.content.push(part);
        } else {
          prompt.push({ role: 'tool', content: [part] });
        }
        break;
      }
    }
  }

  return prompt;
}

export function fromAISDK(model: AISDKLanguageModel): LLMBackend {
  return new AISDKBackend(model);
}
