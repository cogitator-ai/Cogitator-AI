import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { RAGPipeline } from './rag-pipeline.js';

export interface RAGTool<TParams = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams) => Promise<unknown>;
}

const SearchParamsSchema = z.object({
  query: z.string().min(1).describe('Search query for the knowledge base'),
  limit: z.number().int().positive().optional().describe('Maximum number of results to return'),
  threshold: z.number().min(0).max(1).optional().describe('Minimum relevance score (0-1)'),
});

type SearchParams = z.infer<typeof SearchParamsSchema>;

const IngestParamsSchema = z.object({
  source: z.string().min(1).describe('File path, directory or URL to ingest'),
});

type IngestParams = z.infer<typeof IngestParamsSchema>;

export function createSearchTool(pipeline: RAGPipeline): RAGTool<SearchParams> {
  return {
    name: 'rag_search',
    description: 'Search the knowledge base using semantic search',
    parameters: SearchParamsSchema,
    execute: async (params) => {
      try {
        const { query, limit, threshold } = SearchParamsSchema.parse(params);
        const results = await pipeline.query(query, { topK: limit, threshold });
        return { success: true, query, results, count: results.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface IngestToolOptions {
  /**
   * Restrict local sources to these directories (symlinks are resolved). When set, any
   * path outside them is rejected. Strongly recommended when the tool is exposed to an LLM.
   */
  allowedRoots?: string[];
  /** Allow http(s) URLs as sources. Defaults to `true`. */
  allowUrls?: boolean;
}

function isUrl(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function assertAllowedSource(source: string, options: IngestToolOptions): Promise<void> {
  if (isUrl(source)) {
    if (options.allowUrls === false) {
      throw new Error('URL sources are not allowed');
    }
    return;
  }

  if (!options.allowedRoots) return;

  const target = await canonicalPath(source);
  for (const root of options.allowedRoots) {
    const canonicalRoot = await canonicalPath(root);
    const rel = relative(canonicalRoot, target);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  }
  throw new Error(`Source "${source}" is outside the allowed directories`);
}

export function createIngestTool(
  pipeline: RAGPipeline,
  options: IngestToolOptions = {}
): RAGTool<IngestParams> {
  return {
    name: 'rag_ingest',
    description: 'Ingest documents into the knowledge base',
    parameters: IngestParamsSchema,
    execute: async (params) => {
      try {
        const { source } = IngestParamsSchema.parse(params);
        await assertAllowedSource(source, options);
        const { documents, chunks } = await pipeline.ingest(source);
        return { success: true, source, documents, chunks };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function ragTools(
  pipeline: RAGPipeline,
  ingestOptions?: IngestToolOptions
): [RAGTool<SearchParams>, RAGTool<IngestParams>] {
  return [createSearchTool(pipeline), createIngestTool(pipeline, ingestOptions)];
}
