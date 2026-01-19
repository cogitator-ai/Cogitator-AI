/**
 * LLM Backend types
 */

import type { Message, ToolCall } from './message';
import type { ToolSchema } from './tool';

export type LLMProvider =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'vllm'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'deepseek';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export type LLMResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; jsonSchema: JsonSchemaFormat };

export interface JsonSchemaFormat {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  stream?: boolean;
  responseFormat?: LLMResponseFormat;
}

export interface ChatResponse {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ChatStreamChunk {
  id: string;
  delta: {
    content?: string;
    toolCalls?: Partial<ToolCall>[];
  };
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  /** Usage data, typically included only in the final chunk */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface LLMBackend {
  readonly provider: LLMProvider;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;
  complete?(request: Omit<ChatRequest, 'model'> & { model?: string }): Promise<ChatResponse>;
}
