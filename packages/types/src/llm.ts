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
  | 'azure'
  | 'bedrock'
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

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
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

/**
 * Type-safe provider configuration interfaces
 */

export interface OllamaProviderConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface AnthropicProviderConfig {
  apiKey: string;
}

export interface GoogleProviderConfig {
  apiKey: string;
}

export interface AzureProviderConfig {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  deployment?: string;
}

export interface BedrockProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface VLLMProviderConfig {
  baseUrl: string;
}

export interface MistralProviderConfig {
  apiKey: string;
}

export interface GroqProviderConfig {
  apiKey: string;
}

export interface TogetherProviderConfig {
  apiKey: string;
}

export interface DeepSeekProviderConfig {
  apiKey: string;
}

/**
 * Map of provider names to their config types
 */
export interface ProviderConfigMap {
  ollama: OllamaProviderConfig;
  openai: OpenAIProviderConfig;
  anthropic: AnthropicProviderConfig;
  google: GoogleProviderConfig;
  azure: AzureProviderConfig;
  bedrock: BedrockProviderConfig;
  vllm: VLLMProviderConfig;
  mistral: MistralProviderConfig;
  groq: GroqProviderConfig;
  together: TogetherProviderConfig;
  deepseek: DeepSeekProviderConfig;
}

/**
 * All provider configs as a partial record
 */
export type LLMProvidersConfig = {
  [K in LLMProvider]?: ProviderConfigMap[K];
};

/**
 * Discriminated union for type-safe backend initialization
 */
export type LLMBackendConfig =
  | { provider: 'ollama'; config: OllamaProviderConfig }
  | { provider: 'openai'; config: OpenAIProviderConfig }
  | { provider: 'anthropic'; config: AnthropicProviderConfig }
  | { provider: 'google'; config: GoogleProviderConfig }
  | { provider: 'azure'; config: AzureProviderConfig }
  | { provider: 'bedrock'; config: BedrockProviderConfig }
  | { provider: 'vllm'; config: VLLMProviderConfig }
  | { provider: 'mistral'; config: MistralProviderConfig }
  | { provider: 'groq'; config: GroqProviderConfig }
  | { provider: 'together'; config: TogetherProviderConfig }
  | { provider: 'deepseek'; config: DeepSeekProviderConfig };
