import { z } from 'zod';

export const ChunkingStrategySchema = z.enum(['fixed', 'recursive', 'semantic']);

export const ChunkingConfigSchema = z.object({
  strategy: ChunkingStrategySchema,
  chunkSize: z.number().int().positive(),
  chunkOverlap: z.number().int().nonnegative().default(0),
  separators: z.array(z.string()).optional(),
});

export const RetrievalStrategySchema = z.enum(['similarity', 'mmr', 'hybrid', 'multi-query']);

export const RetrievalConfigSchema = z.object({
  strategy: RetrievalStrategySchema.default('similarity'),
  topK: z.number().int().positive().default(10),
  threshold: z.number().min(0).max(1).default(0.0),
  mmrLambda: z.number().min(0).max(1).optional(),
  multiQueryCount: z.number().int().positive().optional(),
});

const retrievalDefaults = RetrievalConfigSchema.parse({});

export const RerankingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  topN: z.number().int().positive().optional(),
});

export const RAGPipelineConfigSchema = z.object({
  chunking: ChunkingConfigSchema,
  retrieval: RetrievalConfigSchema.default(retrievalDefaults),
  reranking: RerankingConfigSchema.optional(),
});

export type ChunkingConfigInput = z.input<typeof ChunkingConfigSchema>;
export type RetrievalConfigInput = z.input<typeof RetrievalConfigSchema>;
export type RAGPipelineConfigInput = z.input<typeof RAGPipelineConfigSchema>;
