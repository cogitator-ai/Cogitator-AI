import { z } from 'zod';
import {
  calendarDate,
  isMemoryItemAdapter,
  MemoryItems,
  MemoryRetriever,
  MIN_COSINE,
  normalizeName,
  visibleIn,
  type MessageIndex,
} from '@cogitator-ai/memory';
import type {
  BaseToolContext,
  EmbeddingService,
  MemoryAdapter,
  MemoryEntity,
  MemoryEntry,
  MemoryItem,
  MemoryItemScope,
} from '@cogitator-ai/types';
import { tool, toolset } from '../tool';

/** Names of the tools {@link createMemorySearchTools} makes */
export const MEMORY_SEARCH_TOOLS = ['search_memory', 'open_turns', 'list_entities'] as const;

/** Characters of a turn a search shows before it is opened */
const EXCERPT_CHARS = 280;
/** Turns one call of `open_turns` opens at most, those around them aside */
const OPEN_AT_MOST = 10;
/** Vectors of memory items the tools keep, the used least lately dropped past it */
const ITEM_VECTORS_KEPT = 5_000;
/** Turns of the thread a vector search returns at most */
const VECTOR_HITS = 50;

export interface MemorySearchToolsConfig {
  /** The thread store turns are read from, and memory items when it keeps them */
  memory: MemoryAdapter;
  /** The id the agent's memory items are kept under (`memoryAgentId(agent)`) */
  agentId: string;
  /** Memory items to search, those of `memory` by default when it keeps them */
  items?: MemoryItems;
  /** Embeds the query and the memory items, so both are found by meaning too */
  embedding?: EmbeddingService;
  /** Finds turns of a thread by their vectors without embedding them again */
  messageIndex?: MessageIndex;
  /** IANA time zone the dates of turns are shown in, UTC by default */
  timeZone?: string;
}

const searchParams = z.object({
  query: z.string().min(1).describe('What to look for in memory, in your own words'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('How many results to return at most (default 8)'),
});

const openParams = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(OPEN_AT_MOST)
    .describe('Ids of turns to open, as search_memory returned them'),
  around: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('How many turns before and after each one to open too (default 1)'),
});

const entitiesParams = z.object({
  query: z
    .string()
    .optional()
    .describe('Part of a name to filter by, such as a person, a place or a project'),
});

/** `YYYY-MM-DD` of `date` on the calendar of `timeZone` */
function dayOf(date: Date, timeZone: string): string {
  const { year, month, day } = calendarDate(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function textOf(entry: MemoryEntry): string {
  return typeof entry.message.content === 'string' ? entry.message.content : '';
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * Tools for an agent to search its memory in steps of its own: `search_memory` finds earlier
 * turns of the thread and memory items for a query, ranked like the `hybrid` context ranks them,
 * `open_turns` reads turns whole with the turns around them, and `list_entities` names the
 * people, places and things memory knows. What a run sees is the memory of its user and its
 * thread, under the agent's memory id and its runtime id.
 *
 * Results carry references to cite, `[item:<id>]` for an item a search returned and
 * `[turn:<id>]` for a turn `open_turns` opened. With the `memoryCitations()` middleware, a
 * reference to what the run never opened is taken out of the answer.
 */
export function createMemorySearchTools(config: MemorySearchToolsConfig) {
  const { memory, agentId, embedding, messageIndex } = config;
  const timeZone = config.timeZone ?? 'UTC';
  const itemAdapter = isMemoryItemAdapter(memory) ? memory : undefined;
  const items =
    config.items ?? (itemAdapter ? new MemoryItems({ adapter: itemAdapter }) : undefined);
  const retriever = new MemoryRetriever();
  const itemVectors = new Map<string, Float32Array>();

  const scopeOf = (context: BaseToolContext): MemoryItemScope => ({
    agentId,
    ...(context.userId !== undefined && { userId: context.userId }),
    ...(context.threadId !== undefined && { threadId: context.threadId }),
  });

  /** The turns of the run's thread, on its active branch when the store keeps branches */
  const turnsOf = async (threadId: string | undefined): Promise<MemoryEntry[]> => {
    if (threadId === undefined) return [];
    const read = memory.getPath
      ? await memory.getPath({ threadId })
      : await memory.getEntries({ threadId });
    if (!read.success) throw new Error(`Reading thread ${threadId} failed: ${read.error}`);
    return read.data;
  };

  const itemCosines = async (
    found: readonly MemoryItem[],
    query: Promise<number[]>
  ): Promise<Map<string, number>> => {
    if (!embedding) return new Map();
    const keyOf = (item: MemoryItem) => `${embedding.model}:${item.id}`;
    const missing = found.filter((item) => !itemVectors.has(keyOf(item)));
    if (missing.length > 0) {
      const made = await embedding.embedBatch(missing.map((item) => item.content));
      missing.forEach((item, at) => {
        const vector = made[at];
        if (vector) itemVectors.set(keyOf(item), Float32Array.from(vector));
      });
    }
    const vector = await query;
    const cosines = new Map<string, number>();
    for (const item of found) {
      const kept = itemVectors.get(keyOf(item));
      if (!kept) continue;
      itemVectors.delete(keyOf(item));
      itemVectors.set(keyOf(item), kept);
      cosines.set(item.id, cosine(vector, kept));
    }
    while (itemVectors.size > ITEM_VECTORS_KEPT) {
      const oldest = itemVectors.keys().next().value;
      if (oldest === undefined) break;
      itemVectors.delete(oldest);
    }
    return cosines;
  };

  const heldOf = (item: MemoryItem): string | undefined => {
    if (item.validTo !== undefined) {
      return `${item.validFrom ? dayOf(item.validFrom, timeZone) : '…'} to ${dayOf(item.validTo, timeZone)}`;
    }
    if (item.validFrom !== undefined) return `since ${dayOf(item.validFrom, timeZone)}`;
    return item.about?.start ? dayOf(item.about.start, timeZone) : undefined;
  };

  const searchMemory = tool({
    name: 'search_memory',
    description:
      'Search long-term memory: earlier turns of this conversation and what memory keeps about the user. ' +
      'Returns memory items with a reference to cite ([item:<id>]) and turns with an excerpt: open a turn ' +
      'with open_turns before you rely on it or cite it ([turn:<id>]). Search again with other words when ' +
      'nothing fits. If nothing you opened answers the question, say that you do not remember.',
    parameters: searchParams,
    execute: async ({ query, limit = 8 }, context) => {
      const history = await turnsOf(context.threadId);
      const queryVector = embedding?.embed(query);
      queryVector?.catch(() => undefined);
      const cosines =
        queryVector && messageIndex && context.threadId !== undefined
          ? await messageIndex.search(context.threadId, await queryVector, VECTOR_HITS, MIN_COSINE)
          : undefined;
      const retrieval = await retriever.retrieve({
        input: query,
        anchor: new Date(),
        timeZone,
        history,
        ...(cosines && { cosines }),
        ...(items &&
          itemAdapter && {
            items,
            itemAdapter,
            scope: scopeOf(context),
            agentIds: [context.agentId],
            ...(queryVector && {
              itemCosines: (found: readonly MemoryItem[]) => itemCosines(found, queryVector),
            }),
          }),
      });
      const results = retrieval.hits.slice(0, limit).map((hit) => {
        if (hit.kind === 'item') {
          const held = heldOf(hit.hit.item);
          return {
            kind: 'item' as const,
            ref: `item:${hit.hit.item.id}`,
            text: hit.hit.item.content,
            type: hit.hit.item.kind,
            ...(held !== undefined && { held }),
          };
        }
        const entry = hit.hit.entry;
        return {
          kind: 'turn' as const,
          id: entry.id,
          date: dayOf(entry.createdAt, timeZone),
          role: entry.message.role,
          excerpt: excerptOf(textOf(entry)),
        };
      });
      return {
        results,
        ...(results.length === 0 && {
          note: retrieval.analysis.retrieve
            ? 'Nothing in memory matches. Try other words, or say that you do not remember.'
            : 'The query carries nothing to search for.',
        }),
      };
    },
  });

  const openTurns = tool({
    name: 'open_turns',
    description:
      'Open turns of this conversation whole, with the turns around them, by the ids search_memory ' +
      'returned. Cite an opened turn as [turn:<id>].',
    parameters: openParams,
    execute: async ({ ids, around = 1 }, context) => {
      const history = await turnsOf(context.threadId);
      const position = new Map(history.map((entry, at) => [entry.id, at]));
      const opened = new Set<number>();
      const missing: string[] = [];
      for (const id of new Set(ids)) {
        const at = position.get(id);
        if (at === undefined) {
          missing.push(id);
          continue;
        }
        for (
          let near = Math.max(0, at - around);
          near <= Math.min(history.length - 1, at + around);
          near++
        ) {
          opened.add(near);
        }
      }
      const turns = [...opened]
        .sort((a, b) => a - b)
        .flatMap((at) => {
          const entry = history[at];
          if (!entry) return [];
          const role = entry.message.role;
          if (role !== 'user' && role !== 'assistant') return [];
          return [
            {
              ref: `turn:${entry.id}`,
              date: dayOf(entry.createdAt, timeZone),
              role,
              text: textOf(entry),
            },
          ];
        });
      return {
        turns,
        ...(missing.length > 0 && {
          missing,
          note: 'These ids are not turns of this conversation.',
        }),
      };
    },
  });

  const listEntities = tool({
    name: 'list_entities',
    description:
      'List the people, places, projects and things long-term memory knows, with how many memory ' +
      'items are about each, to know what to search for.',
    parameters: entitiesParams,
    execute: async ({ query }, context) => {
      if (!itemAdapter || !items) return { entities: [] };
      const scope = scopeOf(context);
      const scopes = [...new Set([agentId, context.agentId])].map((id) => ({
        ...scope,
        agentId: id,
      }));
      const found = await Promise.all(
        scopes.map(async (seen) => {
          const result = await itemAdapter.findEntities({ agentId: seen.agentId });
          return result.success ? result.data.filter((entity) => visibleIn(entity, seen)) : [];
        })
      );
      const wanted = query ? normalizeName(query) : undefined;
      const entities = [
        ...new Map(found.flat().map((entity) => [entity.id, entity])).values(),
      ].filter(
        (entity) =>
          wanted === undefined ||
          [entity.name, ...entity.aliases].some((name) => normalizeName(name).includes(wanted))
      );
      const counts = new Map<string, number>();
      for (const seen of scopes) {
        for (const item of await items.query({ scope: seen })) {
          if (item.entityId) counts.set(item.entityId, (counts.get(item.entityId) ?? 0) + 1);
        }
      }
      const listed = (entity: MemoryEntity) => ({
        name: entity.name,
        ...(entity.aliases.length > 0 && { aliases: entity.aliases }),
        ...(entity.type !== undefined && { type: entity.type }),
        items: counts.get(entity.id) ?? 0,
      });
      return {
        entities: entities
          .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
          .slice(0, 50)
          .map(listed),
      };
    },
  });

  return toolset(searchMemory, openTurns, listEntities);
}
