import type {
  JSONSchema7,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  ContentPart,
  LLMBackend,
  LLMBackendProvider,
  LLMResponseFormat,
  Message,
  ReasoningConfig,
  ToolCall,
  ToolChoice,
} from '@cogitator-ai/types';
import { LLMError } from '@cogitator-ai/core';
import { ErrorCode } from '@cogitator-ai/types';
import { isRecord, toJSONValue, type JSONObject, type JSONValue } from './json.js';
import type { AISDKLanguageModel } from './types.js';
import type {
  LanguageModelV1FunctionToolCall,
  LanguageModelV1GenerateResult,
  LanguageModelV1ImagePart,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
  LanguageModelV1TextPart,
  LanguageModelV1ToolResultPart,
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

interface ReasoningPart {
  type: 'reasoning';
  text: string;
  providerOptions?: Record<string, JSONObject>;
}

type ToolOutput<TMedia> =
  | { type: 'text'; value: string }
  | { type: 'json'; value: JSONValue }
  | { type: 'error-text'; value: string }
  | { type: 'content'; value: Array<TextPart | TMedia> };

interface ToolResultPart<TMedia> {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ToolOutput<TMedia>;
}

type ModernMessage<TData, TMedia> =
  | { role: 'system'; content: string }
  | { role: 'user'; content: Array<TextPart | FilePart<TData>> }
  | { role: 'assistant'; content: Array<TextPart | ReasoningPart | ToolCallPart> }
  | { role: 'tool'; content: ToolResultPart<TMedia>[] };

type V4FileData = { type: 'url'; url: URL } | { type: 'data'; data: string };

/** An image of a tool result in the `content` output of a v2 prompt */
type V2ToolMedia = { type: 'media'; data: string; mediaType: string };
/** An image of a tool result in the `content` output of a v3 prompt */
type V3ToolMedia =
  { type: 'image-data'; data: string; mediaType: string } | { type: 'image-url'; url: string };
/** An image of a tool result in the `content` output of a v4 prompt */
type V4ToolMedia = { type: 'file'; data: V4FileData; mediaType: string };

/** How a prompt of one specification version carries images: in user messages and tool results */
interface PromptMedia<TData, TMedia> {
  fileData(source: ImageSource): TData;
  toolMedia(source: ImageSource): TMedia | undefined;
}

const V2_MEDIA: PromptMedia<URL | string, V2ToolMedia> = {
  fileData: (source) => (source.kind === 'url' ? source.url : source.data),
  toolMedia: (source) =>
    source.kind === 'data'
      ? { type: 'media', data: source.data, mediaType: source.mediaType }
      : undefined,
};

const V3_MEDIA: PromptMedia<URL | string, V3ToolMedia> = {
  fileData: V2_MEDIA.fileData,
  toolMedia: (source) =>
    source.kind === 'data'
      ? { type: 'image-data', data: source.data, mediaType: source.mediaType }
      : { type: 'image-url', url: source.url.href },
};

const V4_MEDIA: PromptMedia<V4FileData, V4ToolMedia> = {
  fileData: (source) =>
    source.kind === 'url' ? { type: 'url', url: source.url } : { type: 'data', data: source.data },
  toolMedia: (source) => ({
    type: 'file',
    data: V4_MEDIA.fileData(source),
    mediaType: source.kind === 'data' ? source.mediaType : 'image',
  }),
};

/**
 * Reasoning an AI SDK model returned before a tool call, kept in `ToolCall.replay.precedingItems`
 * so it is sent back with the call (Anthropic needs its thinking blocks, with their signatures,
 * before a `tool_use` it answers). Other backends skip these items.
 */
type AISDKReasoningItem =
  | {
      type: 'ai-sdk-reasoning';
      text: string;
      providerOptions?: Record<string, JSONObject>;
      signature?: string;
    }
  | { type: 'ai-sdk-redacted-reasoning'; data: string };

interface ModernContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
  providerExecuted?: boolean;
  providerMetadata?: unknown;
}

function reasoningItemsOf(call: ToolCall): AISDKReasoningItem[] {
  const items: AISDKReasoningItem[] = [];
  for (const item of call.replay?.precedingItems ?? []) {
    if (item.type === 'ai-sdk-reasoning' && typeof item.text === 'string') {
      items.push({
        type: 'ai-sdk-reasoning',
        text: item.text,
        ...(isProviderOptions(item.providerOptions) && { providerOptions: item.providerOptions }),
        ...(typeof item.signature === 'string' && { signature: item.signature }),
      });
    } else if (item.type === 'ai-sdk-redacted-reasoning' && typeof item.data === 'string') {
      items.push({ type: 'ai-sdk-redacted-reasoning', data: item.data });
    }
  }
  return items;
}

function isProviderOptions(value: unknown): value is Record<string, JSONObject> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

/** Provider metadata as the provider options it is sent back as, keeping only JSON objects. */
function providerOptionsOf(metadata: unknown): Record<string, JSONObject> | undefined {
  if (!isRecord(metadata)) return undefined;
  const options: Record<string, JSONObject> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const json = toJSONValue(value);
    if (isRecord(json)) options[key] = json as JSONObject;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function mergeProviderOptions(
  current: Record<string, JSONObject> | undefined,
  next: Record<string, JSONObject> | undefined
): Record<string, JSONObject> | undefined {
  if (!next) return current;
  if (!current) return next;
  const merged: Record<string, JSONObject> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = { ...(merged[key] ?? {}), ...value };
  }
  return merged;
}

/** A tool call with the reasoning that came before it and its own provider metadata. */
function withReplay(
  call: ToolCall,
  reasoning: readonly AISDKReasoningItem[],
  providerMetadata: unknown
): ToolCall {
  const metadata = providerOptionsOf(providerMetadata);
  if (reasoning.length === 0 && !metadata) return call;
  return {
    ...call,
    replay: {
      ...call.replay,
      ...(reasoning.length > 0 && { precedingItems: [...reasoning] }),
      ...(metadata && { providerMetadata: metadata }),
    },
  };
}

/**
 * Reasoning blocks of a streamed response, by block id, until the tool call they precede: text
 * from the deltas, provider metadata (a signature, redacted data) merged from start, deltas and
 * end.
 */
class ReasoningCollector {
  private blocks = new Map<string, { text: string; options?: Record<string, JSONObject> }>();
  private v1Items: AISDKReasoningItem[] = [];
  private v1Text = '';

  modern(id: string, delta: string, metadata: unknown): void {
    const block = this.blocks.get(id) ?? { text: '' };
    block.text += delta;
    block.options = mergeProviderOptions(block.options, providerOptionsOf(metadata));
    this.blocks.set(id, block);
  }

  v1Delta(delta: string): void {
    this.v1Text += delta;
  }

  v1Signature(signature: string): void {
    this.v1Items.push({ type: 'ai-sdk-reasoning', text: this.v1Text, signature });
    this.v1Text = '';
  }

  v1Redacted(data: string): void {
    this.flushV1Text();
    this.v1Items.push({ type: 'ai-sdk-redacted-reasoning', data });
  }

  /** The reasoning collected since the last call, which now precedes this one */
  take(): AISDKReasoningItem[] {
    this.flushV1Text();
    const items: AISDKReasoningItem[] = [
      ...this.v1Items,
      ...[...this.blocks.values()].map((block): AISDKReasoningItem => ({
        type: 'ai-sdk-reasoning',
        text: block.text,
        ...(block.options && { providerOptions: block.options }),
      })),
    ];
    this.blocks.clear();
    this.v1Items = [];
    return items;
  }

  private flushV1Text(): void {
    if (!this.v1Text) return;
    this.v1Items.push({ type: 'ai-sdk-reasoning', text: this.v1Text });
    this.v1Text = '';
  }
}

/**
 * A tool message as the output of an AI SDK tool result: images as media of a `content` output,
 * `{"error": "..."}` (how a failed call reaches the model) as `error-text`, JSON as `json`.
 */
function toolOutputOf<TMedia>(
  content: Message['content'],
  toolMedia: (source: ImageSource) => TMedia | undefined
): ToolOutput<TMedia> {
  if (typeof content !== 'string') {
    const value: Array<TextPart | TMedia> = [];
    for (const part of content) {
      const image = imageSourceOf(part);
      const media = image ? toolMedia(image) : undefined;
      if (media) value.push(media);
      else if (part.type === 'text') value.push({ type: 'text', text: part.text });
      else if (image) value.push({ type: 'text', text: `[image: ${describeImage(image)}]` });
    }
    return { type: 'content', value };
  }
  const json = parseToolOutput(content);
  if (json === undefined) return { type: 'text', value: content };
  const error = toolErrorOf(json);
  return error === undefined ? { type: 'json', value: json } : { type: 'error-text', value: error };
}

function toolErrorOf(json: JSONValue): string | undefined {
  if (!isRecord(json)) return undefined;
  const keys = Object.keys(json);
  return keys.length === 1 && typeof json.error === 'string' ? json.error : undefined;
}

function describeImage(source: ImageSource): string {
  return source.kind === 'url' ? source.url.href : source.mediaType;
}

interface ParsedTurn {
  id?: string;
  content: string;
  reasoning?: string;
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
    case 'content-filter':
      return 'content_filter';
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
    cacheWriteTokens: usage?.inputTokens.cacheWrite,
    reasoningTokens: usage?.outputTokens.reasoning,
  };
}

function reasoningFromV1(
  reasoning: LanguageModelV1GenerateResult['reasoning']
): string | undefined {
  if (reasoning === undefined) return undefined;
  const text =
    typeof reasoning === 'string'
      ? reasoning
      : reasoning
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
  return text || undefined;
}

/**
 * The provider-neutral `reasoning` call option of the v4 specification. `max` has no v4
 * level, so it asks for the highest one; `budgetTokens` and `summary` are provider settings.
 */
function v4ReasoningOf(
  reasoning: ReasoningConfig | undefined
): LanguageModelV4CallOptions['reasoning'] {
  const effort = reasoning?.effort;
  return effort === 'max' ? 'xhigh' : effort;
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
  readonly provider: LLMBackendProvider;

  private readonly model: AISDKLanguageModel;
  private thoughtSignatureKey: string | undefined;

  constructor(model: AISDKLanguageModel) {
    this.model = model;
    this.provider = model.provider ?? 'ai-sdk';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const turn = await this.generate(request);
    return {
      id: turn.id ?? `aisdk-${Date.now()}`,
      content: turn.content,
      ...(turn.reasoning && { reasoning: turn.reasoning }),
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
        case 'reasoning':
          yield { id: chunkId, delta: { reasoning: event.delta } };
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
    const reasoning = new ReasoningCollector();
    switch (model.specificationVersion) {
      case 'v1': {
        const { stream } = await model.doStream(this.v1Options(request));
        for await (const part of readStream(stream)) {
          const event = this.fromV1StreamPart(part, reasoning);
          if (event) yield event;
        }
        break;
      }
      case 'v2': {
        const { stream } = await model.doStream(this.modernOptions(request, V2_MEDIA));
        for await (const part of readStream(stream)) {
          const event = this.fromModernStreamPart(part, reasoning);
          if (event) yield event;
        }
        break;
      }
      case 'v3': {
        const { stream } = await model.doStream(this.modernOptions(request, V3_MEDIA));
        for await (const part of readStream(stream)) {
          const event = this.fromModernStreamPart(part, reasoning);
          if (event) yield event;
        }
        break;
      }
      case 'v4': {
        const { stream } = await model.doStream(this.v4Options(request));
        for await (const part of readStream(stream)) {
          const event = this.fromModernStreamPart(part, reasoning);
          if (event) yield event;
        }
        break;
      }
    }
  }

  private fromV1StreamPart(
    part: LanguageModelV1StreamPart,
    reasoning: ReasoningCollector
  ): StreamEvent | undefined {
    switch (part.type) {
      case 'text-delta':
        return part.textDelta ? { type: 'text', delta: part.textDelta } : undefined;
      case 'reasoning':
        reasoning.v1Delta(part.textDelta);
        return part.textDelta ? { type: 'reasoning', delta: part.textDelta } : undefined;
      case 'reasoning-signature':
        reasoning.v1Signature(part.signature);
        return undefined;
      case 'redacted-reasoning':
        reasoning.v1Redacted(part.data);
        return undefined;
      case 'tool-call':
        return {
          type: 'tool-call',
          toolCall: withReplay(this.fromV1ToolCall(part), reasoning.take(), undefined),
        };
      case 'finish':
        return { type: 'finish', finishReason: part.finishReason, usage: usageFromV1(part.usage) };
      case 'error':
        throw toError(part.error);
      default:
        return undefined;
    }
  }

  private fromModernStreamPart(
    part: LanguageModelV2StreamPart | LanguageModelV3StreamPart | LanguageModelV4StreamPart,
    reasoning: ReasoningCollector
  ): StreamEvent | undefined {
    switch (part.type) {
      case 'text-delta':
        return part.delta ? { type: 'text', delta: part.delta } : undefined;
      case 'reasoning-start':
      case 'reasoning-end':
        reasoning.modern(part.id, '', part.providerMetadata);
        return undefined;
      case 'reasoning-delta':
        reasoning.modern(part.id, part.delta, part.providerMetadata);
        return part.delta ? { type: 'reasoning', delta: part.delta } : undefined;
      case 'tool-call': {
        if (part.providerExecuted) return undefined;
        const toolCall = this.fromModernToolCall(part);
        return toolCall
          ? {
              type: 'tool-call',
              toolCall: withReplay(toolCall, reasoning.take(), part.providerMetadata),
            }
          : undefined;
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
        const reasoning = v1ReasoningItems(result.reasoning);
        return {
          id: result.response?.id,
          content: result.text ?? '',
          reasoning: reasoningFromV1(result.reasoning),
          toolCalls: (result.toolCalls ?? []).map((call, index) =>
            withReplay(this.fromV1ToolCall(call), index === 0 ? reasoning : [], undefined)
          ),
          finishReason: result.finishReason,
          usage: usageFromV1(result.usage),
        };
      }
      case 'v2': {
        const result = await model.doGenerate(this.modernOptions(request, V2_MEDIA));
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
            ? await model.doGenerate(this.modernOptions(request, V3_MEDIA))
            : await model.doGenerate(this.v4Options(request));
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
    const reasoning: string[] = [];
    let precedingReasoning: AISDKReasoningItem[] = [];
    const toolCalls: ToolCall[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        text += part.text;
      } else if (part.type === 'reasoning') {
        if (part.text) reasoning.push(part.text);
        const providerOptions = providerOptionsOf(part.providerMetadata);
        precedingReasoning.push({
          type: 'ai-sdk-reasoning',
          text: part.text ?? '',
          ...(providerOptions && { providerOptions }),
        });
      } else if (part.type === 'tool-call' && !part.providerExecuted) {
        const toolCall = this.fromModernToolCall(part);
        if (toolCall) {
          toolCalls.push(withReplay(toolCall, precedingReasoning, part.providerMetadata));
          precedingReasoning = [];
        }
      }
    }
    return {
      id,
      content: text,
      ...(reasoning.length > 0 && { reasoning: reasoning.join('\n\n') }),
      toolCalls,
      finishReason,
      usage,
    };
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

  private modernOptions<TData, TMedia>(request: ChatRequest, media: PromptMedia<TData, TMedia>) {
    const tools = request.tools?.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as JSONSchema7,
    }));
    const hasTools = tools !== undefined && tools.length > 0;
    return {
      prompt: this.toModernPrompt(request.messages, media),
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

  private v4Options(request: ChatRequest) {
    const reasoning = v4ReasoningOf(request.reasoning);
    return {
      ...this.modernOptions(request, V4_MEDIA),
      ...(reasoning !== undefined && { reasoning }),
    };
  }

  private toModernPrompt<TData, TMedia>(
    messages: Message[],
    media: PromptMedia<TData, TMedia>
  ): ModernMessage<TData, TMedia>[] {
    const prompt: ModernMessage<TData, TMedia>[] = [];

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
                data: media.fileData(image),
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
          const calls = toolCallsOf(message);
          const content: Array<TextPart | ReasoningPart | ToolCallPart> = [];
          for (const item of calls.flatMap(reasoningItemsOf)) {
            if (item.type !== 'ai-sdk-reasoning') continue;
            content.push({
              type: 'reasoning',
              text: item.text,
              ...(item.providerOptions && { providerOptions: item.providerOptions }),
            });
          }
          if (text) content.push({ type: 'text', text });
          for (const call of calls) {
            content.push({
              type: 'tool-call',
              toolCallId: call.id,
              toolName: call.name,
              input: call.arguments,
              providerOptions: this.callProviderOptions(call),
            });
          }
          if (content.length > 0) prompt.push({ role: 'assistant', content });
          break;
        }
        case 'tool': {
          const part: ToolResultPart<TMedia> = {
            type: 'tool-result',
            toolCallId: message.toolCallId ?? '',
            toolName: message.name ?? '',
            output: toolOutputOf(message.content, media.toolMedia),
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

  /** The provider options a tool call is sent back with: its own metadata, else its thought signature. */
  private callProviderOptions(call: ToolCall): Record<string, JSONObject> | undefined {
    const metadata = call.replay?.providerMetadata;
    if (isProviderOptions(metadata)) return metadata;
    return this.thoughtSignatureOptions(call);
  }

  private thoughtSignatureOptions(call: ToolCall): Record<string, JSONObject> | undefined {
    if (!call.thoughtSignature) return undefined;
    const key = this.thoughtSignatureKey ?? this.model.provider.split('.')[0];
    return { [key]: { thoughtSignature: call.thoughtSignature } };
  }
}

type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
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

/** The reasoning of a v1 response as replay items for its first tool call. */
function v1ReasoningItems(
  reasoning: LanguageModelV1GenerateResult['reasoning']
): AISDKReasoningItem[] {
  if (reasoning === undefined) return [];
  if (typeof reasoning === 'string') {
    return reasoning ? [{ type: 'ai-sdk-reasoning', text: reasoning }] : [];
  }
  return reasoning.map((part): AISDKReasoningItem =>
    part.type === 'text'
      ? {
          type: 'ai-sdk-reasoning',
          text: part.text,
          ...(part.signature !== undefined && { signature: part.signature }),
        }
      : { type: 'ai-sdk-redacted-reasoning', data: part.data }
  );
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
            ...toolCalls.flatMap(reasoningItemsOf).map((item) =>
              item.type === 'ai-sdk-reasoning'
                ? {
                    type: 'reasoning' as const,
                    text: item.text,
                    ...(item.signature !== undefined && { signature: item.signature }),
                  }
                : { type: 'redacted-reasoning' as const, data: item.data }
            ),
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
        const output = parseToolOutput(text);
        const error = output === undefined ? undefined : toolErrorOf(output);
        const images =
          typeof message.content === 'string'
            ? []
            : message.content.flatMap((item) => {
                const image = imageSourceOf(item);
                return image?.kind === 'data'
                  ? [{ type: 'image' as const, data: image.data, mimeType: image.mediaType }]
                  : [];
              });
        const part: LanguageModelV1ToolResultPart = {
          type: 'tool-result',
          toolCallId: message.toolCallId ?? '',
          toolName: message.name ?? '',
          result: error ?? output ?? text,
          ...(error !== undefined && { isError: true }),
          ...(images.length > 0 && {
            content: [...(text ? [{ type: 'text' as const, text }] : []), ...images],
          }),
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
