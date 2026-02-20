import { z } from 'zod';
import type { RAGPipeline } from './rag-pipeline';

export interface RAGTool<TParams = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams) => Promise<unknown>;
}

const SearchParamsSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

type SearchParams = z.infer<typeof SearchParamsSchema>;

const IngestParamsSchema = z.object({
  source: z.string(),
});

type IngestParams = z.infer<typeof IngestParamsSchema>;

export function createSearchTool(pipeline: RAGPipeline): RAGTool<SearchParams> {
  return {
    name: 'rag_search',
    description: 'Search the knowledge base using semantic search',
    parameters: SearchParamsSchema,
    execute: async ({ query, limit, threshold }) => {
      try {
        const results = await pipeline.query(query, { topK: limit, threshold });
        return { success: true, query, results, count: results.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function createIngestTool(pipeline: RAGPipeline): RAGTool<IngestParams> {
  return {
    name: 'rag_ingest',
    description: 'Ingest documents into the knowledge base',
    parameters: IngestParamsSchema,
    execute: async ({ source }) => {
      try {
        const { documents, chunks } = await pipeline.ingest(source);
        return { success: true, source, documents, chunks };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function ragTools(pipeline: RAGPipeline): [RAGTool<SearchParams>, RAGTool<IngestParams>] {
  return [createSearchTool(pipeline), createIngestTool(pipeline)];
}
