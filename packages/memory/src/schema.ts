/**
 * Zod schemas for memory configuration validation
 */

import { z } from 'zod';

export const MemoryProviderSchema = z.enum([
  'memory',
  'redis',
  'postgres',
  'sqlite',
  'mongodb',
  'qdrant',
]);

export const InMemoryConfigSchema = z.object({
  provider: z.literal('memory'),
  maxEntries: z.number().positive().optional(),
});

export const RedisConfigSchema = z.object({
  provider: z.literal('redis'),
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().positive().optional(),
  cluster: z
    .object({
      nodes: z.array(z.object({ host: z.string(), port: z.number() })),
      scaleReads: z.enum(['master', 'slave', 'all']).optional(),
    })
    .optional(),
  keyPrefix: z.string().optional(),
  ttl: z.number().positive().optional(),
  password: z.string().optional(),
});

export const PostgresConfigSchema = z.object({
  provider: z.literal('postgres'),
  connectionString: z.string(),
  schema: z.string().optional(),
  poolSize: z.number().positive().optional(),
});

export const SQLiteConfigSchema = z.object({
  provider: z.literal('sqlite'),
  path: z.string(),
  walMode: z.boolean().optional(),
});

export const MongoDBConfigSchema = z.object({
  provider: z.literal('mongodb'),
  uri: z.string(),
  database: z.string().optional(),
  collectionPrefix: z.string().optional(),
});

export const QdrantConfigSchema = z.object({
  provider: z.literal('qdrant'),
  url: z.string().optional(),
  apiKey: z.string().optional(),
  collection: z.string().optional(),
  dimensions: z.number().positive(),
});

export const MemoryAdapterConfigSchema = z.discriminatedUnion('provider', [
  InMemoryConfigSchema,
  RedisConfigSchema,
  PostgresConfigSchema,
  SQLiteConfigSchema,
  MongoDBConfigSchema,
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

export const EmbeddingProviderSchema = z.enum(['openai', 'ollama', 'google']);

export const OpenAIEmbeddingConfigSchema = z.object({
  provider: z.literal('openai'),
  apiKey: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
  dimensions: z.number().positive().optional(),
});

export const OllamaEmbeddingConfigSchema = z.object({
  provider: z.literal('ollama'),
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

export const GoogleEmbeddingConfigSchema = z.object({
  provider: z.literal('google'),
  apiKey: z.string(),
  model: z.string().optional(),
  dimensions: z.number().positive().optional(),
});

export const EmbeddingServiceConfigSchema = z.discriminatedUnion('provider', [
  OpenAIEmbeddingConfigSchema,
  OllamaEmbeddingConfigSchema,
  GoogleEmbeddingConfigSchema,
]);
