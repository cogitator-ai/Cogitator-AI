import OpenAI from 'openai';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  ToolChoice,
  Message,
  LLMResponseFormat,
  MessageContent,
  ContentPart,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { BaseLLMBackend } from './base';
import { LLMError, wrapSDKError, llmInvalidResponse, type LLMErrorContext } from './errors';

export abstract class OpenAICompatibleBackend extends BaseLLMBackend {
  protected abstract client: OpenAI;

  protected resolveModel(request: ChatRequest): string {
    return request.model;
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
      response = await this.client.chat.completions.create({
        model,
        messages: this.convertMessages(request.messages),
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
        max_tokens: request.maxTokens,
        stop: request.stop,
        response_format: this.convertResponseFormat(request.responseFormat),
      });
    } catch (e) {
      throw this.wrapAPIError(e, ctx);
    }

    const choice = response.choices[0];
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

    return {
      id: response.id,
      content: message.content ?? '',
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
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
      stream = await this.client.chat.completions.create({
        model,
        messages: this.convertMessages(request.messages),
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
        max_tokens: request.maxTokens,
        stop: request.stop,
        stream: true,
        stream_options: { include_usage: true },
        response_format: this.convertResponseFormat(request.responseFormat),
      });
    } catch (e) {
      throw this.wrapAPIError(e, ctx);
    }

    const toolCallsAccum = new Map<number, { id?: string; name?: string }>();
    const toolCallArgsAccum = new Map<number, string>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (!choice && chunk.usage) {
        yield {
          id: chunk.id,
          delta: {},
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        };
        continue;
      }

      if (!choice) continue;

      const delta = choice.delta;

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
          toolCalls: finalToolCalls,
        },
        finishReason: choice.finish_reason
          ? finalToolCalls
            ? 'tool_calls'
            : this.mapFinishReason(choice.finish_reason)
          : undefined,
      };
    }
  }

  protected convertMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
      switch (m.role) {
        case 'system':
          return {
            role: 'system' as const,
            content: this.getTextContent(m.content),
          };
        case 'user':
          return {
            role: 'user' as const,
            content: this.convertContent(m.content),
          };
        case 'assistant':
          return {
            role: 'assistant' as const,
            content: this.getTextContent(m.content),
          };
        case 'tool':
          return {
            role: 'tool' as const,
            content: this.getTextContent(m.content),
            tool_call_id: m.toolCallId ?? '',
          };
      }
    });
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
    try {
      return JSON.parse(str) as Record<string, unknown>;
    } catch (e) {
      throw new LLMError(
        `Failed to parse tool call arguments: ${str.slice(0, 100)}`,
        ErrorCode.LLM_INVALID_RESPONSE,
        ctx,
        { cause: e instanceof Error ? e : undefined }
      );
    }
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
