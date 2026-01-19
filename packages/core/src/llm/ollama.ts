/**
 * Ollama LLM Backend
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
  Message,
  LLMResponseFormat,
  MessageContent,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { BaseLLMBackend } from './base';

interface OllamaConfig {
  baseUrl: string;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
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
  message: OllamaMessage;
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

  constructor(config: OllamaConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: this.convertMessages(request.messages),
        tools: request.tools ? this.convertTools(request.tools) : undefined,
        format: this.convertResponseFormat(request.responseFormat),
        stream: false,
        options: {
          temperature: request.temperature,
          top_p: request.topP,
          num_predict: request.maxTokens,
          stop: request.stop,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status.toString()} - ${error}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    return this.convertResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: this.convertMessages(request.messages),
        tools: request.tools ? this.convertTools(request.tools) : undefined,
        format: this.convertResponseFormat(request.responseFormat),
        stream: true,
        options: {
          temperature: request.temperature,
          top_p: request.topP,
          num_predict: request.maxTokens,
          stop: request.stop,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status.toString()} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const id = this.generateId();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line) as OllamaChatResponse;

        const chunk: ChatStreamChunk = {
          id,
          delta: {
            content: data.message.content,
            toolCalls: data.message.tool_calls?.map((tc) => ({
              id: `call_${nanoid(12)}`,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })),
          },
          finishReason: data.done ? (data.message.tool_calls ? 'tool_calls' : 'stop') : undefined,
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
  }

  private convertMessages(messages: Message[]): OllamaMessage[] {
    return messages.map((m) => {
      const { text, images } = this.extractContentAndImages(m.content);
      return {
        role: m.role as OllamaMessage['role'],
        content: text,
        images: images.length > 0 ? images : undefined,
      };
    });
  }

  private extractContentAndImages(content: MessageContent): { text: string; images: string[] } {
    if (typeof content === 'string') {
      return { text: content, images: [] };
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
        case 'image_url':
          break;
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

  private convertResponse(data: OllamaChatResponse): ChatResponse {
    const toolCalls: ToolCall[] | undefined = data.message.tool_calls?.map((tc) => ({
      id: `call_${nanoid(12)}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      id: this.generateId(),
      content: data.message.content,
      toolCalls,
      finishReason: toolCalls ? 'tool_calls' : 'stop',
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
}
