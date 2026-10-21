import type { Embedding, EmbeddingDeleteFilter, SearchFilter } from '@cogitator-ai/types';

/** The source types a filter allows, none when it allows every type */
export function filterSourceTypes(filter: SearchFilter | undefined): Embedding['sourceType'][] {
  const types = filter?.sourceType;
  if (types === undefined) return [];
  return Array.isArray(types) ? types : [types];
}

/**
 * Whether an embedding passes a search filter. Agent and thread scoping use `metadata.agentId` /
 * `metadata.threadId`, a user filter also lets through embeddings of no user, and `metadata`
 * conditions match values exactly.
 */
export function matchesSearchFilter(
  embedding: Pick<Embedding, 'sourceType' | 'metadata'>,
  filter: SearchFilter | undefined
): boolean {
  if (!filter) return true;
  const metadata = embedding.metadata;
  const types = filterSourceTypes(filter);
  if (types.length > 0 && !types.includes(embedding.sourceType)) return false;
  if (filter.agentId && metadata?.agentId !== filter.agentId) return false;
  if (filter.threadId && metadata?.threadId !== filter.threadId) return false;
  if (filter.userId) {
    const owner = metadata?.userId;
    if (owner !== undefined && owner !== null && owner !== filter.userId) return false;
  }
  if (filter.metadata) {
    for (const [key, value] of Object.entries(filter.metadata)) {
      if (metadata?.[key] !== value) return false;
    }
  }
  return true;
}

/** Whether a delete filter names at least one condition, so it cannot wipe a whole store. */
export function hasDeleteCondition(filter: EmbeddingDeleteFilter): boolean {
  return Boolean(
    filterSourceTypes(filter).length > 0 ||
    filter.agentId ||
    filter.threadId ||
    (filter.metadata && Object.keys(filter.metadata).length > 0)
  );
}

export const EMPTY_DELETE_FILTER_ERROR =
  'deleteByFilter needs at least one condition (sourceType, agentId, threadId or metadata)';
