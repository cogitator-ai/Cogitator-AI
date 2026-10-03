/**
 * Ollama LLM Backend
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  ToolChoice,
  Message,
  LLMResponseFormat,
  MessageContent,
  ReasoningConfig,
  ReasoningEffort,
  ToolSchema,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { BaseLLMBackend } from './base';
import {
  createLLMError,
  retryAfterFromHeaders,
  llmUnavailable,
  llmInvalidResponse,
  type LLMErrorContext,
} from './errors';
import { fetchImageAsBase64 } from '../utils/image-fetch';
import { getLogger } from '../logger';

interface OllamaConfig {
  baseUrl: string;
  apiKey?: string;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  /** Reasoning of thinking models, apart from `content` */
  thinking?: string;
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message?: OllamaMessage;
  error?: string;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaBackend extends BaseLLMBackend {
  readonly provider = 'ollama' as const;
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: OllamaConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const tools = this.applyToolChoice(request.tools, request.toolChoice);
    const endpoint = `${this.baseUrl}/api/chat`;
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
      endpoint,
    };

    const messages = await this.convertMessages(request.messages, request.signal);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: request.model,
          messages,
          tools: tools ? this.convertTools(tools) : undefined,
          format: this.convertResponseFormat(request.responseFormat),
          think: ollamaThink(request.model, request.reasoning),
          stream: false,
          options: {
            temperature: request.temperature,
            top_p: request.topP,
            num_predict: request.maxTokens,
            stop: request.stop,
          },
        }),
        signal: request.signal,
      });
    } catch (e) {
      throw llmUnavailable(ctx, 'Failed to connect to Ollama', e instanceof Error ? e : undefined);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw createLLMError(ctx, response.status, errorBody, {
        retryAfterOverride: retryAfterFromHeaders(response.headers),
      });
    }

    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) {
      throw llmUnavailable(ctx, `Ollama error: ${data.error}`);
    }
    if (!data.message) {
      throw llmInvalidResponse(ctx, 'Ollama response did not include a message');
    }
    return this.convertResponse(data, data.message);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const tools = this.applyToolChoice(request.tools, request.toolChoice);
    const endpoint = `${this.baseUrl}/api/chat`;
    const ctx: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
      endpoint,
    };

    const messages = await this.convertMessages(request.messages, request.signal);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: request.model,
          messages,
          tools: tools ? this.convertTools(tools) : undefined,
          format: this.convertResponseFormat(request.responseFormat),
          think: ollamaThink(request.model, request.reasoning),
          stream: true,
          options: {
            temperature: request.temperature,
            top_p: request.topP,
            num_predict: request.maxTokens,
            stop: request.stop,
          },
        }),
        signal: request.signal,
      });
    } catch (e) {
      throw llmUnavailable(ctx, 'Failed to connect to Ollama', e instanceof Error ? e : undefined);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw createLLMError(ctx, response.status, errorBody, {
        retryAfterOverride: retryAfterFromHeaders(response.headers),
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw llmInvalidResponse(ctx, 'No response body from stream');

    const decoder = new TextDecoder();
    let buffer = '';
    const id = this.generateId();
    let validChunks = 0;
    let parseErrors = 0;
    let sawToolCalls = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let data: OllamaChatResponse;
          try {
            data = JSON.parse(line) as OllamaChatResponse;
          } catch {
            parseErrors++;
            getLogger().warn('Malformed JSON in Ollama stream, skipping line', {
              line: line.slice(0, 200),
            });
            continue;
          }
          if (data.error) {
            throw llmUnavailable(ctx, `Ollama stream error: ${data.error}`);
          }
          validChunks++;

          const toolCalls = data.message?.tool_calls;
          if (toolCalls?.length) {
            sawToolCalls = true;
          }

          let finishReason: ChatStreamChunk['finishReason'];
          if (data.done) {
            if (sawToolCalls) {
              finishReason = 'tool_calls';
            } else if (data.done_reason === 'length') {
              finishReason = 'length';
            } else {
              finishReason = 'stop';
            }
          }

          const chunk: ChatStreamChunk = {
            id,
            delta: {
              content: data.message?.content || undefined,
              ...(data.message?.thinking && { reasoning: data.message.thinking }),
              toolCalls: toolCalls?.map((tc) => ({
                id: tc.id ?? `call_${nanoid(12)}`,
                name: tc.function.name,
                arguments: tc.function.arguments,
              })),
            },
            finishReason,
          };

          if (data.done && (data.prompt_eval_count || data.eval_count)) {
            chunk.usage = {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
              totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            };
          }

          yield chunk;
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    if (validChunks === 0 && parseErrors > 0) {
      throw llmInvalidResponse(
        ctx,
        `Ollama stream contained ${parseErrors} malformed JSON line(s) and 0 valid chunks`
      );
    }
  }

  private async convertMessages(
    messages: Message[],
    signal?: AbortSignal
  ): Promise<OllamaMessage[]> {
    return Promise.all(
      messages.map(async (m) => {
        const { text, images } = await this.extractContentAndImages(m.content, signal);
        const base: OllamaMessage = {
          role: m.role as OllamaMessage['role'],
          content: text,
          images: images.length > 0 ? images : undefined,
        };

        if (m.role === 'tool' && m.name) {
          base.tool_name = m.name;
        }

        if (m.role === 'assistant' && 'toolCalls' in m && Array.isArray(m.toolCalls)) {
          base.tool_calls = m.toolCalls.map((tc: ToolCall) => ({
            id: tc.id,
            function: {
              name: tc.name,
              arguments: tc.arguments as Record<string, unknown>,
            },
          }));
        }

        return base;
      })
    );
  }

  private async extractContentAndImages(
    content: MessageContent,
    signal?: AbortSignal
  ): Promise<{ text: string; images: string[] }> {
    if (typeof content === 'string') {
      return { text: content, images: [] };
    }

    if (!Array.isArray(content)) {
      return { text: String(content ?? ''), images: [] };
    }

    const textParts: string[] = [];
    const images: string[] = [];

    for (const part of content) {
      switch (part.type) {
        case 'text':
          textParts.push(part.text);
          break;
        case 'image_base64':
          images.push(part.image_base64.data);
          break;
        case 'image_url': {
          const fetched = await fetchImageAsBase64(part.image_url.url, { signal });
          images.push(fetched.data);
          break;
        }
      }
    }

    return { text: textParts.join(' '), images };
  }

  private convertTools(tools: ChatRequest['tools']): OllamaTool[] | undefined {
    if (!tools) return undefined;
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private convertResponse(data: OllamaChatResponse, message: OllamaMessage): ChatResponse {
    const toolCalls: ToolCall[] | undefined = message.tool_calls?.map((tc) => ({
      id: tc.id ?? `call_${nanoid(12)}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    let finishReason: ChatResponse['finishReason'];
    if (toolCalls?.length) {
      finishReason = 'tool_calls';
    } else if (data.done_reason === 'length') {
      finishReason = 'length';
    } else {
      finishReason = 'stop';
    }

    return {
      id: this.generateId(),
      content: message.content ?? '',
      ...(message.thinking && { reasoning: message.thinking }),
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      finishReason,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
    };
  }

  private convertResponseFormat(
    format: LLMResponseFormat | undefined
  ): 'json' | Record<string, unknown> | undefined {
    if (!format || format.type === 'text') {
      return undefined;
    }

    if (format.type === 'json_object') {
      return 'json';
    }

    return format.jsonSchema.schema;
  }

  private applyToolChoice(
    tools: ToolSchema[] | undefined,
    choice: ToolChoice | undefined
  ): ToolSchema[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    if (!choice || choice === 'auto') return tools;
    if (choice === 'none') return undefined;

    if (choice === 'required') return tools;

    return tools.filter((t) => t.name === choice.function.name);
  }
}

const OLLAMA_THINK_LEVELS: Readonly<Record<ReasoningEffort, 'low' | 'medium' | 'high'>> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/**
 * Ollama's `think` for a reasoning config: a level for models that take one
 * (gpt-oss), on or off for the rest (qwen3, deepseek-r1, ...).
 */
export function ollamaThink(
  model: string,
  reasoning: ReasoningConfig | undefined
): boolean | 'low' | 'medium' | 'high' | undefined {
  if (!reasoning) return undefined;
  if (reasoning.effort === 'none') return false;
  if (/gpt-oss/i.test(model) && reasoning.effort) return OLLAMA_THINK_LEVELS[reasoning.effort];
  return true;
}
