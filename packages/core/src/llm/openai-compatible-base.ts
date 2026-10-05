import OpenAI from 'openai';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  ToolCall,
  ToolChoice,
  Message,
  LLMResponseFormat,
  MessageContent,
  ContentPart,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';
import {
  LLMError,
  wrapSDKError,
  llmInvalidResponse,
  providerErrorIn,
  type LLMErrorContext,
} from './errors';
import { jsonInstruction, withSystemInstruction } from './json-instruction';

export abstract class OpenAICompatibleBackend extends BaseLLMBackend {
  protected abstract client: OpenAI;

  /**
   * The official OpenAI API rejects `max_tokens` for reasoning models and expects
   * `max_completion_tokens`; most OpenAI-compatible servers only understand `max_tokens`.
   */
  protected readonly maxTokensField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';

  private maxTokensParams(
    maxTokens: number | undefined
  ): { max_tokens?: number } | { max_completion_tokens?: number } {
    return this.maxTokensField === 'max_completion_tokens'
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
  }

  protected resolveModel(request: ChatRequest): string {
    return request.model;
  }

  /**
   * Whether the server enforces `response_format` while tools are offered and still lets the
   * model call them. The official OpenAI API does. Many OpenAI-compatible providers do not: they
   * force JSON from the first turn, so the model stops calling tools, or ignore the schema. For
   * those the schema goes into the system prompt instead, which their models follow reliably.
   */
  protected supportsResponseFormatWithTools(): boolean {
    return false;
  }

  /** The messages and `response_format` for a request, moving the schema into the prompt when needed. */
  private structuredOutput(request: ChatRequest): {
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    response_format: OpenAI.Chat.ChatCompletionCreateParams['response_format'];
  } {
    const format = request.responseFormat;
    const viaPrompt =
      format !== undefined &&
      format.type !== 'text' &&
      (request.tools?.length ?? 0) > 0 &&
      !this.supportsResponseFormatWithTools();
    if (!viaPrompt) {
      return {
        messages: this.convertMessages(request.messages),
        response_format: this.convertResponseFormat(format),
      };
    }
    const schema = format.type === 'json_schema' ? format.jsonSchema.schema : undefined;
    return {
      messages: this.convertMessages(
        withSystemInstruction(request.messages, jsonInstruction(schema))
      ),
      response_format: undefined,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = this.resolveModel(request);
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model,
      endpoint: this.client.baseURL,
    };

    let response: OpenAI.Chat.ChatCompletion;
    try {
      const params = {
        model,
        ...this.structuredOutput(request),
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
        tool_choice: this.convertToolChoice(request.toolChoice),
        temperature: request.temperature,
        top_p: request.topP,
        ...this.maxTokensParams(request.maxTokens),
        stop: request.stop,
        ...(request.reasoning?.effort && { reasoning_effort: request.reasoning.effort }),
      };

      response = request.signal
        ? await this.client.chat.completions.create(params, { signal: request.signal })
        : await this.client.chat.completions.create(params);
    } catch (e) {
      throw this.wrapAPIError(e, ctx);
    }

    const failure = providerErrorIn(response, ctx);
    if (failure) throw failure;
    const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
    if (!choice) {
      throw llmInvalidResponse(ctx, `No choices in ${this.provider} response`);
    }
    const message = choice.message;

    const toolCalls: ToolCall[] | undefined = message.tool_calls
      ?.filter((tc): tc is typeof tc & { type: 'function' } => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.tryParseJson(tc.function.arguments, ctx),
      }));

    const reasoning = reasoningTextOf(message);
    return {
      id: response.id,
      content: message.content ?? '',
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: toChatUsage(response.usage),
      ...(reasoning && { reasoning }),
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const model = this.resolveModel(request);
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model,
      endpoint: this.client.baseURL,
    };

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      const params = {
        model,
        ...this.structuredOutput(request),
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
        tool_choice: this.convertToolChoice(request.toolChoice),
        temperature: request.temperature,
        top_p: request.topP,
        ...this.maxTokensParams(request.maxTokens),
        stop: request.stop,
        stream: true as const,
        stream_options: { include_usage: true },
        ...(request.reasoning?.effort && { reasoning_effort: request.reasoning.effort }),
      };

      stream = request.signal
        ? await this.client.chat.completions.create(params, { signal: request.signal })
        : await this.client.chat.completions.create(params);
    } catch (e) {
      throw this.wrapAPIError(e, ctx);
    }

    const toolCallsAccum = new Map<number, { id?: string; name?: string }>();
    const toolCallArgsAccum = new Map<number, string>();

    for await (const chunk of this.readStream(stream, ctx)) {
      const failure = providerErrorIn(chunk, ctx);
      if (failure) throw failure;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;

      if (!choice && chunk.usage) {
        yield { id: chunk.id, delta: {}, usage: toChatUsage(chunk.usage) };
        continue;
      }

      if (!choice) continue;

      const delta = choice.delta;
      const usage = chunk.usage ? toChatUsage(chunk.usage) : undefined;
      const reasoningDelta = reasoningTextOf(delta);

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
          arguments: this.tryParseJson(toolCallArgsAccum.get(index) ?? '{}', ctx),
        }));
      }

      if (!finalToolCalls && choice.finish_reason && toolCallsAccum.size > 0) {
        finalToolCalls = Array.from(toolCallsAccum.entries()).map(([index, partial]) => ({
          id: partial.id ?? '',
          name: partial.name ?? '',
          arguments: this.tryParseJson(toolCallArgsAccum.get(index) ?? '{}', ctx),
        }));
      }

      yield {
        id: chunk.id,
        delta: {
          content: delta.content ?? undefined,
          ...(reasoningDelta && { reasoning: reasoningDelta }),
          toolCalls: finalToolCalls,
        },
        finishReason: choice.finish_reason
          ? finalToolCalls
            ? 'tool_calls'
            : this.mapFinishReason(choice.finish_reason)
          : undefined,
        ...(usage ? { usage } : {}),
      };
    }
  }

  /**
   * The chunks of a stream, with the provider error the SDK raises while reading one made an
   * `LLMError`: the OpenAI SDK throws an `APIError` without a status when an event carries
   * `{ error }`, before the chunk is handed out. Anything else, an abort included, goes on as is.
   */
  private async *readStream<T>(stream: AsyncIterable<T>, ctx: LLMErrorContext): AsyncGenerator<T> {
    try {
      for await (const chunk of stream) yield chunk;
    } catch (error) {
      if (error instanceof LLMError || !(error instanceof Error)) throw error;
      const { status, error: payload } = error as Error & { status?: unknown; error?: unknown };
      const failure =
        status === undefined ? providerErrorIn({ error: payload }, ctx, error) : undefined;
      throw failure ?? error;
    }
  }

  /**
   * Chat Completions takes only text in tool messages, so the images of tool
   * results follow the tool messages of their turn in one user message.
   */
  protected convertMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const converted: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    let toolImages: OpenAI.Chat.ChatCompletionContentPart[] = [];
    const flushToolImages = () => {
      if (toolImages.length === 0) return;
      converted.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Images returned by the tool calls above:' },
          ...toolImages,
        ],
      });
      toolImages = [];
    };

    for (const m of messages) {
      if (m.role !== 'tool') flushToolImages();
      switch (m.role) {
        case 'system':
          converted.push({ role: 'system', content: this.getTextContent(m.content) });
          break;
        case 'user':
          converted.push({ role: 'user', content: this.convertContent(m.content) });
          break;
        case 'assistant': {
          const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
            role: 'assistant' as const,
            content: this.getTextContent(m.content),
          };
          const toolCalls = (m as Message & { toolCalls?: ToolCall[] }).toolCalls;
          if (toolCalls && toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            }));
          }
          converted.push(assistantMsg);
          break;
        }
        case 'tool':
          converted.push({
            role: 'tool',
            content: this.getTextContent(m.content),
            tool_call_id: m.toolCallId ?? '',
          });
          if (typeof m.content !== 'string') {
            toolImages.push(
              ...m.content
                .filter((part) => part.type !== 'text')
                .map((part) => this.convertContentPart(part))
            );
          }
          break;
      }
    }
    flushToolImages();
    return converted;
  }

  protected convertContent(
    content: MessageContent
  ): string | OpenAI.Chat.ChatCompletionContentPart[] {
    if (typeof content === 'string') {
      return content;
    }

    return content.map((part) => this.convertContentPart(part));
  }

  protected convertContentPart(part: ContentPart): OpenAI.Chat.ChatCompletionContentPart {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'image_url':
        return {
          type: 'image_url',
          image_url: {
            url: part.image_url.url,
            detail: part.image_url.detail,
          },
        };
      case 'image_base64':
        return {
          type: 'image_url',
          image_url: {
            url: `data:${part.image_base64.media_type};base64,${part.image_base64.data}`,
          },
        };
    }
  }

  protected getTextContent(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }

  protected mapFinishReason(reason: string | null): ChatResponse['finishReason'] {
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

  protected tryParseJson(str: string, ctx: LLMErrorContext): Record<string, unknown> {
    return parseToolCallArguments(str, ctx);
  }

  protected wrapAPIError(error: unknown, ctx: LLMErrorContext): LLMError {
    return wrapSDKError(error, ctx);
  }

  protected convertResponseFormat(
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

  protected convertToolChoice(
    choice: ToolChoice | undefined
  ): OpenAI.Chat.ChatCompletionCreateParams['tool_choice'] {
    if (!choice) return undefined;

    if (typeof choice === 'string') {
      return choice;
    }

    return {
      type: 'function',
      function: { name: choice.function.name },
    };
  }
}

/**
 * Parse the JSON arguments string of an OpenAI-style function call into an object.
 * Empty strings and `null` become `{}`; anything that is not a JSON object is rejected.
 */
export function parseToolCallArguments(str: string, ctx: LLMErrorContext): Record<string, unknown> {
  if (!str.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch (e) {
    throw new LLMError(
      `Failed to parse tool call arguments: ${str.slice(0, 100)}`,
      ErrorCode.LLM_INVALID_RESPONSE,
      ctx,
      { cause: e instanceof Error ? e : undefined }
    );
  }
  if (parsed === null) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LLMError(
      `Tool call arguments must be a JSON object: ${str.slice(0, 100)}`,
      ErrorCode.LLM_INVALID_RESPONSE,
      ctx
    );
  }
  return parsed as Record<string, unknown>;
}

function toChatUsage(usage: OpenAI.CompletionUsage | null | undefined): ChatUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  const cost = reportedCost(usage);
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/** The USD cost some OpenAI-compatible services add to `usage` (OpenRouter's `usage.cost`). */
function reportedCost(usage: OpenAI.CompletionUsage | null | undefined): number | undefined {
  const cost = (usage as { cost?: unknown } | null | undefined)?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * Reasoning text OpenAI-compatible servers attach to a message or delta:
 * `reasoning_content` (DeepSeek, vLLM) or `reasoning` (Groq, OpenRouter).
 */
function reasoningTextOf(message: object): string | undefined {
  const fields = message as { reasoning_content?: unknown; reasoning?: unknown };
  const text = fields.reasoning_content ?? fields.reasoning;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}
