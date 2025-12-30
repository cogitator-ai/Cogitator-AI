/**
 * Zod schemas for memory configuration validation
 */

import { z } from 'zod';

export const MemoryProviderSchema = z.enum(['memory', 'redis', 'postgres']);

export const InMemoryConfigSchema = z.object({
  provider: z.literal('memory'),
  maxEntries: z.number().positive().optional(),
});

export const RedisConfigSchema = z.object({
  provider: z.literal('redis'),
  url: z.string().url(),
  keyPrefix: z.string().optional(),
  ttl: z.number().positive().optional(),
});

export const PostgresConfigSchema = z.object({
  provider: z.literal('postgres'),
  connectionString: z.string(),
  schema: z.string().optional(),
  poolSize: z.number().positive().optional(),
});

export const MemoryAdapterConfigSchema = z.discriminatedUnion('provider', [
  InMemoryConfigSchema,
  RedisConfigSchema,
  PostgresConfigSchema,
]);

export const ContextStrategySchema = z.enum(['recent', 'relevant', 'hybrid']);

export const ContextBuilderConfigSchema = z.object({
  maxTokens: z.number().positive(),
  reserveTokens: z.number().positive().optional(),
  strategy: ContextStrategySchema,
  includeSystemPrompt: z.boolean().optional(),
  includeFacts: z.boolean().optional(),
  includeSemanticContext: z.boolean().optional(),
});

export const EmbeddingProviderSchema = z.enum(['openai', 'ollama']);

export const OpenAIEmbeddingConfigSchema = z.object({
  provider: z.literal('openai'),
  apiKey: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

export const OllamaEmbeddingConfigSchema = z.object({
  provider: z.literal('ollama'),
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

export const EmbeddingServiceConfigSchema = z.discriminatedUnion('provider', [
  OpenAIEmbeddingConfigSchema,
  OllamaEmbeddingConfigSchema,
]);
