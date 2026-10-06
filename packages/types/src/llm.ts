/**
 * LLM Backend types
 */

import type { Message, ToolCall } from './message';
import type { ToolSchema } from './tool';

/** The backend a model string runs on, and the model name that backend expects. */
export interface ModelRoute {
  backend: LLMBackend;
  model: string;
}

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

/**
 * The provider name a backend reports: a built-in {@link LLMProvider}, or the
 * name of a backend of your own (`llm.backends`) or of a registered plugin.
 */
export type LLMBackendProvider = LLMProvider | (string & {});

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
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/**
 * How hard a reasoning model thinks, from `none` (no thinking where the model
 * allows turning it off, otherwise its lowest level) to `max`. Each backend
 * maps it to its provider: Anthropic `output_config.effort` with adaptive
 * thinking (or a thinking budget on older Claude models), OpenAI
 * `reasoning.effort`, Gemini `thinkingConfig`, Ollama `think`.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReasoningConfig {
  effort?: ReasoningEffort;
  /**
   * Thinking token budget, for providers that take one: Gemini 2.5
   * `thinkingBudget` and Claude models before 4.6. Ignored elsewhere.
   */
  budgetTokens?: number;
  /**
   * Return a readable summary of the reasoning: `ChatResponse.reasoning`, and
   * `delta.reasoning` while streaming. Providers never return the raw chain
   * of thought; without it most return nothing.
   */
  summary?: boolean;
}

/**
 * Provider prompt caching. Anthropic caches the stable prefix of a request
 * (tools, system prompt, history) only when asked, so the backend marks it;
 * OpenAI and Gemini cache on their own and report the hits.
 */
export interface PromptCacheConfig {
  /** How long Anthropic keeps a cached prefix (default `5m`) */
  ttl?: '5m' | '1h';
}

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
  reasoning?: ReasoningConfig;
  /** Prompt caching; `false` turns it off where the provider allows */
  cache?: PromptCacheConfig | false;
  /** Abort signal for cancelling the provider request. */
  signal?: AbortSignal;
}

/**
 * Why a model turn ended, the same for every provider:
 * - `stop`: the model finished its answer
 * - `tool_calls`: the model asked for the calls in `toolCalls`, all of them complete
 * - `length`: the output hit the token limit, so the answer is cut off; a turn cut inside a tool
 *   call carries no tool calls, since they may be incomplete
 * - `content_filter`: the provider's safety system withheld or cut the answer
 * - `refusal`: the model declined to answer; `content` holds its explanation when it gave one
 * - `error`: the provider ended the turn abnormally, e.g. with malformed output
 *
 * Only `tool_calls` runs tools. Backends report the provider's own reason and the runtime settles
 * the turn with `normalizeTurn` from `@cogitator-ai/core`, so a turn with complete tool calls is a
 * tool turn even when the provider reported `stop` for it.
 */
export type FinishReason =
  'stop' | 'tool_calls' | 'length' | 'content_filter' | 'refusal' | 'error';

export interface ChatResponse {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  usage: ChatUsage;
  /** Readable summary of the model's reasoning, when the provider returned one */
  reasoning?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input tokens served from the provider prompt cache; already counted in `inputTokens`. */
  cachedInputTokens?: number;
  /** Input tokens written to the provider prompt cache; already counted in `inputTokens`. */
  cacheWriteTokens?: number;
  /**
   * The part of `cacheWriteTokens` written with the 1-hour TTL, which Anthropic bills at twice
   * the input price instead of the 5-minute write price.
   */
  cacheWrite1hTokens?: number;
  /** Hidden reasoning tokens; already counted in `outputTokens`. */
  reasoningTokens?: number;
  /**
   * What the provider charged for this call in USD, when it reports it (OpenRouter does). The
   * runtime prefers it over prices from the model registry.
   */
  cost?: number;
}

export interface ChatStreamChunk {
  id: string;
  delta: {
    content?: string;
    /** Piece of the reasoning summary */
    reasoning?: string;
    toolCalls?: Partial<ToolCall>[];
  };
  /** Set on the chunk that ends the turn */
  finishReason?: FinishReason;
  /** Usage data, typically included only in the final chunk */
  usage?: ChatUsage;
}

export interface LLMBackend {
  readonly provider: LLMBackendProvider;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;
  complete?(request: Omit<ChatRequest, 'model'> & { model?: string }): Promise<ChatResponse>;
}

/**
 * How the runtime retries LLM calls that fail with a retryable error: rate
 * limits, 5xx, timeouts and dropped connections. A stream is retried only
 * until its first chunk arrives.
 */
export interface LLMRetryConfig {
  /** Attempts after the first one (default 2) */
  maxRetries?: number;
  /** Delay before the first retry when the provider names none, doubled on each retry (default 1000 ms) */
  baseDelay?: number;
  /** Cap for that backoff (default 30000 ms) */
  maxDelay?: number;
  /** Longest `Retry-After` worth waiting for; a longer one fails the call at once (default 60000 ms) */
  maxRetryAfter?: number;
  /** Called before each retry */
  onRetry?: (event: LLMRetryEvent) => void;
}

export interface LLMRetryEvent {
  provider: string;
  model: string;
  /** The retry about to start, from 1 */
  attempt: number;
  /** Milliseconds until it starts */
  delay: number;
  error: Error;
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
  /**
   * Wire API used for the official OpenAI provider. Defaults to `'responses'` for api.openai.com
   * and to `'chat-completions'` when `baseUrl` points at another OpenAI-compatible server.
   */
  api?: OpenAIWireApi;
}

export type OpenAIWireApi = 'responses' | 'chat-completions';

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
