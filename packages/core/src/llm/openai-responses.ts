import { z } from 'zod';
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseTextConfig,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import type { Reasoning } from 'openai/resources/shared';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  ContentPart,
  LLMResponseFormat,
  Message,
  MessageContent,
  ReasoningConfig,
  ToolCall,
  ToolCallReplayState,
  ToolChoice,
  ToolSchema,
} from '@cogitator-ai/types';
import { createLLMError, llmInvalidResponse, type LLMError, type LLMErrorContext } from './errors';
import { parseToolCallArguments } from './openai-compatible-base';

export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';

const REASONING_MODEL_PATTERN = /^(?:ft:)?(?:o\d|gpt-(?:[5-9]|\d{2,}))/;
const CHAT_VARIANT_PATTERN = /-chat(?:-|$)/;

/**
 * Reasoning models (o-series, GPT-5 and later) reject sampling parameters and return
 * reasoning items that have to be replayed between tool-call turns.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return REASONING_MODEL_PATTERN.test(id) && !CHAT_VARIANT_PATTERN.test(id);
}

export type ResponsesRequestParams = Omit<ResponseCreateParamsBase, 'stream'>;

export function buildResponsesParams(request: ChatRequest, model: string): ResponsesRequestParams {
  const reasoning = isOpenAIReasoningModel(model);
  const { instructions, input } = toResponsesInput(request.messages, reasoning);

  return {
    model,
    input,
    ...(instructions ? { instructions } : {}),
    tools: request.tools?.length ? request.tools.map(toFunctionTool) : undefined,
    tool_choice: toToolChoice(request.toolChoice),
    max_output_tokens: request.maxTokens,
    text: toTextConfig(request.responseFormat),
    store: false,
    ...(reasoning
      ? {
          include: ['reasoning.encrypted_content'],
          ...(request.reasoning && { reasoning: toReasoningParam(request.reasoning) }),
        }
      : { temperature: request.temperature, top_p: request.topP }),
  };
}

function toReasoningParam(config: ReasoningConfig): Reasoning {
  return {
    ...(config.effort && { effort: config.effort }),
    ...(config.summary && { summary: 'auto' as const }),
  };
}

export function parseResponsesResponse(response: Response, ctx: LLMErrorContext): ChatResponse {
  if (response.status === 'failed') {
    throw toResponsesError(response.error, ctx);
  }

  const { content, toolCalls, reasoning } = parseOutput(response.output, ctx);

  return {
    id: response.id,
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: toFinishReason(response, toolCalls.length > 0),
    usage: toUsage(response.usage),
    ...(reasoning && { reasoning }),
  };
}

/**
 * Translate Responses API server-sent events into Cogitator stream chunks: text deltas are
 * forwarded as they arrive, tool calls and usage are emitted once with the terminal chunk.
 */
export async function* readResponsesStream(
  stream: AsyncIterable<ResponseStreamEvent>,
  ctx: LLMErrorContext
): AsyncGenerator<ChatStreamChunk> {
  const items = new Map<number, ResponseOutputItem>();
  let responseId = '';

  for await (const event of stream) {
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        responseId = event.response.id;
        break;

      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (event.delta) {
          yield { id: responseId, delta: { content: event.delta } };
        }
        break;

      case 'response.reasoning_summary_text.delta':
        if (event.delta) {
          yield { id: responseId, delta: { reasoning: event.delta } };
        }
        break;

      case 'response.output_item.added':
      case 'response.output_item.done':
        items.set(event.output_index, event.item);
        break;

      case 'response.function_call_arguments.delta': {
        const item = items.get(event.output_index);
        if (item?.type === 'function_call') {
          items.set(event.output_index, { ...item, arguments: item.arguments + event.delta });
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const item = items.get(event.output_index);
        if (item?.type === 'function_call') {
          items.set(event.output_index, { ...item, arguments: event.arguments });
        }
        break;
      }

      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response;
        const output =
          response.output.length > 0
            ? response.output
            : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        const { toolCalls } = parseOutput(output, ctx);
        yield {
          id: response.id || responseId,
          delta: toolCalls.length > 0 ? { toolCalls } : {},
          finishReason: toFinishReason(response, toolCalls.length > 0),
          usage: toUsage(response.usage),
        };
        return;
      }

      case 'response.failed':
        throw toResponsesError(event.response.error, ctx);

      case 'error':
        throw toResponsesError({ code: event.code, message: event.message }, ctx);
    }
  }

  throw llmInvalidResponse(ctx, 'Response stream ended before a terminal event');
}

function toResponsesInput(
  messages: Message[],
  replayReasoning: boolean
): { instructions?: string; input: ResponseInputItem[] } {
  let start = 0;
  const instructions: string[] = [];
  while (start < messages.length && messages[start].role === 'system') {
    const text = getTextContent(messages[start].content);
    if (text) instructions.push(text);
    start++;
  }

  const input = messages.slice(start).flatMap((m) => toInputItems(m, replayReasoning));
  return { instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined, input };
}

function toInputItems(message: Message, replayReasoning: boolean): ResponseInputItem[] {
  switch (message.role) {
    case 'system':
      return [{ type: 'message', role: 'system', content: getTextContent(message.content) }];
    case 'user':
      return [{ type: 'message', role: 'user', content: toInputContent(message.content) }];
    case 'tool':
      return [
        {
          type: 'function_call_output',
          call_id: message.toolCallId ?? '',
          output: getTextContent(message.content),
        },
      ];
    case 'assistant':
      return toAssistantItems(message, replayReasoning);
  }
}

function toAssistantItems(message: Message, replayReasoning: boolean): ResponseInputItem[] {
  const toolCalls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls ?? [];
  const callItems = toolCalls.flatMap((tc): ResponseInputItem[] => [
    ...toReplayItems(tc.replay, replayReasoning),
    toFunctionCallItem(tc),
  ]);

  const text = getTextContent(message.content);
  const textAlreadyReplayed = callItems.some((item) => item.type === 'message');
  if (!text || textAlreadyReplayed) {
    return callItems;
  }

  const textItem: EasyInputMessage = { type: 'message', role: 'assistant', content: text };
  return [textItem, ...callItems];
}

function toFunctionCallItem(toolCall: ToolCall): ResponseFunctionToolCall {
  return {
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.arguments),
    ...(toolCall.replay?.itemId ? { id: toolCall.replay.itemId } : {}),
  };
}

const replayReasoningSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
  encrypted_content: z.string().min(1),
});

const replayMessageSchema = z.object({
  type: z.literal('message'),
  id: z.string(),
  role: z.literal('assistant'),
  status: z.enum(['in_progress', 'completed', 'incomplete']),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('output_text'), text: z.string() }),
      z.object({ type: z.literal('refusal'), refusal: z.string() }),
    ])
  ),
});

const replayItemSchema = z.discriminatedUnion('type', [replayReasoningSchema, replayMessageSchema]);

function toReplayItems(
  replay: ToolCallReplayState | undefined,
  replayReasoning: boolean
): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const raw of replay?.precedingItems ?? []) {
    const parsed = replayItemSchema.safeParse(raw);
    if (!parsed.success) continue;

    const item = parsed.data;
    if (item.type === 'reasoning') {
      if (!replayReasoning) continue;
      const reasoning: ResponseReasoningItem = {
        type: 'reasoning',
        id: item.id,
        summary: item.summary,
        encrypted_content: item.encrypted_content,
      };
      items.push(reasoning);
    } else {
      const output: ResponseOutputMessage = {
        type: 'message',
        id: item.id,
        role: 'assistant',
        status: item.status,
        content: item.content.map((part) =>
          part.type === 'output_text'
            ? { type: 'output_text', text: part.text, annotations: [] }
            : { type: 'refusal', refusal: part.refusal }
        ),
      };
      items.push(output);
    }
  }
  return items;
}

function captureReasoning(item: ResponseReasoningItem): Record<string, unknown> | undefined {
  if (!item.encrypted_content) return undefined;
  return {
    type: 'reasoning',
    id: item.id,
    summary: item.summary.map((s) => ({ type: 'summary_text', text: s.text })),
    encrypted_content: item.encrypted_content,
  };
}

function captureMessage(item: ResponseOutputMessage): Record<string, unknown> {
  return {
    type: 'message',
    id: item.id,
    role: 'assistant',
    status: item.status,
    content: item.content.map((part) =>
      part.type === 'output_text'
        ? { type: 'output_text', text: part.text }
        : { type: 'refusal', refusal: part.refusal }
    ),
  };
}

function parseOutput(
  output: ResponseOutputItem[],
  ctx: LLMErrorContext
): { content: string; toolCalls: ToolCall[]; reasoning: string } {
  let content = '';
  const toolCalls: ToolCall[] = [];
  const summaries: string[] = [];
  let preceding: Record<string, unknown>[] = [];

  for (const item of output) {
    switch (item.type) {
      case 'reasoning': {
        summaries.push(...item.summary.map((part) => part.text).filter((text) => text.length > 0));
        const captured = captureReasoning(item);
        if (captured) preceding.push(captured);
        break;
      }
      case 'message':
        content += item.content
          .map((part) => (part.type === 'output_text' ? part.text : part.refusal))
          .join('');
        preceding.push(captureMessage(item));
        break;
      case 'function_call': {
        if (item.status === 'incomplete') break;
        const toolCall: ToolCall = {
          id: item.call_id,
          name: item.name,
          arguments: parseToolCallArguments(item.arguments, ctx),
        };
        const replay = toReplayState(item.id, preceding);
        if (replay) toolCall.replay = replay;
        toolCalls.push(toolCall);
        preceding = [];
        break;
      }
    }
  }

  return { content, toolCalls, reasoning: summaries.join('\n\n') };
}

function toReplayState(
  itemId: string | undefined,
  precedingItems: Record<string, unknown>[]
): ToolCallReplayState | undefined {
  if (!itemId && precedingItems.length === 0) return undefined;
  return {
    ...(itemId ? { itemId } : {}),
    ...(precedingItems.length > 0 ? { precedingItems } : {}),
  };
}

function toFinishReason(
  response: Pick<Response, 'status' | 'incomplete_details'>,
  hasToolCalls: boolean
): ChatResponse['finishReason'] {
  switch (response.status) {
    case 'incomplete':
      return response.incomplete_details?.reason === 'content_filter' ? 'error' : 'length';
    case 'failed':
    case 'cancelled':
      return 'error';
    default:
      return hasToolCalls ? 'tool_calls' : 'stop';
  }
}

function toUsage(usage: ResponseUsage | null | undefined): ChatUsage {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  };
}

function toResponsesError(
  error: { code: string | null; message: string } | null | undefined,
  ctx: LLMErrorContext
): LLMError {
  const code = error?.code ?? 'response_failed';
  const message = error?.message ?? 'The model failed to generate a response';
  return createLLMError(ctx, statusForErrorCode(code), `${code}: ${message}`);
}

function statusForErrorCode(code: string): number {
  switch (code) {
    case 'rate_limit_exceeded':
      return 429;
    case 'server_error':
    case 'vector_store_timeout':
      return 500;
    default:
      return 400;
  }
}

function toFunctionTool(tool: ToolSchema): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

function toToolChoice(
  choice: ToolChoice | undefined
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

function toTextConfig(format: LLMResponseFormat | undefined): ResponseTextConfig | undefined {
  if (!format) return undefined;

  switch (format.type) {
    case 'text':
      return { format: { type: 'text' } };
    case 'json_object':
      return { format: { type: 'json_object' } };
    case 'json_schema':
      return {
        format: {
          type: 'json_schema',
          name: format.jsonSchema.name,
          description: format.jsonSchema.description,
          schema: format.jsonSchema.schema,
          strict: format.jsonSchema.strict ?? true,
        },
      };
  }
}

function toInputContent(content: MessageContent): string | ResponseInputContent[] {
  if (typeof content === 'string') return content;
  return content.map(toInputPart);
}

function toInputPart(part: ContentPart): ResponseInputContent {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text };
    case 'image_url':
      return {
        type: 'input_image',
        image_url: part.image_url.url,
        detail: part.image_url.detail ?? 'auto',
      };
    case 'image_base64':
      return {
        type: 'input_image',
        image_url: `data:${part.image_base64.media_type};base64,${part.image_base64.data}`,
        detail: 'auto',
      };
  }
}

function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}
