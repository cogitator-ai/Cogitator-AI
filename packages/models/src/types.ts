import { z } from 'zod';

export const ModelCapabilitiesSchema = z.object({
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsFunctions: z.boolean().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsJson: z.boolean().optional(),
});

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/** Prices in USD per million tokens. */
export const ModelPricingSchema = z.object({
  input: z.number(),
  output: z.number(),
  /** Input served from the provider's prompt cache */
  inputCached: z.number().optional(),
  /** Input written to the prompt cache (Anthropic charges extra for it), with the default 5-minute TTL */
  inputCacheWrite: z.number().optional(),
  /** Input written to the prompt cache with the 1-hour TTL (Anthropic charges twice the input price) */
  inputCacheWrite1h: z.number().optional(),
  outputCached: z.number().optional(),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ModelInfoSchema = z.object({
  /** The model's name at its provider, e.g. `gpt-6-luna` or `deepseek/deepseek-v4-pro` on OpenRouter. */
  id: z.string(),
  provider: z.string(),
  /**
   * The key the LiteLLM catalogue lists the model under, e.g. `openrouter/deepseek/deepseek-v4-pro`
   * or `gpt-6-luna`. Absent on built-in models the catalogue does not list.
   */
  catalogId: z.string().optional(),
  displayName: z.string(),
  pricing: ModelPricingSchema,
  contextWindow: z.number(),
  maxOutputTokens: z.number().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  deprecated: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  /**
   * What the model does: `chat` (the default) answers messages, `decision`
   * answers typed questions with probabilities through `cog.decide()` and
   * cannot chat.
   */
  kind: z.enum(['chat', 'decision']).optional(),
});

export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().optional(),
  models: z.array(z.string()),
});

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export interface ModelFilter {
  provider?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  minContextWindow?: number;
  maxPricePerMillion?: number;
  excludeDeprecated?: boolean;
}

export interface CacheOptions {
  ttl: number;
  storage: 'memory' | 'file';
  filePath?: string;
}

export interface RegistryOptions {
  cache?: CacheOptions;
  autoRefresh?: boolean;
  refreshInterval?: number;
  fallbackToBuiltin?: boolean;
}

export interface LiteLLMModelEntry {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_character?: number;
  output_cost_per_character?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_vision?: boolean;
  supports_response_schema?: boolean;
  supports_tool_choice?: boolean;
  tool_use_system_prompt_tokens?: number;
  supports_assistant_prefill?: boolean;
  deprecation_date?: string;
  source?: string;
}

export type LiteLLMModelData = Record<string, LiteLLMModelEntry>;
