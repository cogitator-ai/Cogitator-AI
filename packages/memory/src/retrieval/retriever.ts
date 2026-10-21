/**
 * Memory retrieval in channels: what a turn's words, its time, the entities it names and the
 * graph of what memory knows each find, fused and ranked into one list of turns and items
 */

import type {
  MemoryEntity,
  MemoryEntry,
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemScope,
} from '@cogitator-ai/types';
import { BM25Index } from '../search/bm25';
import { tokenize } from '../search/tokenizer';
import { indexedText } from '../message-index';
import { normalizeName, visibleIn, type MemoryItems } from '../memory-items';
import { analyzeQuery, type QueryAnalysis, type QueryType } from './query';
import { diversify, fuse, lexicalScore, recencyBias, wordsOf, type ChannelHits } from './rank';

/** The lowest cosine a vector hit may have to count, whatever the best one of the turn */
export const MIN_COSINE = 0.45;
/** A vector hit counts only at this share of the best cosine of the turn or above */
export const RELATIVE_COSINE = 0.6;
/** Hits a channel gives at most */
const CHANNEL_HITS = 50;
/** Candidates ranked for diversity at most */
const RANKED = 100;
/** Threads whose keyword index a retriever keeps */
const THREADS_KEPT = 32;
/** Entities a graph walk reads at most, the newest */
const GRAPH_ENTITIES = 500;
/** Damping of the personalized PageRank walk, as HippoRAG 2 uses it */
const PPR_DAMPING = 0.5;
const PPR_ITERATIONS = 20;

type Channel =
  | 'vector'
  | 'keyword'
  | 'time'
  | 'entity'
  | 'items'
  | 'itemEntity'
  | 'itemTime'
  | 'graph'
  | 'evidence';

/** How much each channel counts for each kind of question */
const WEIGHTS: Record<QueryType, Record<Channel, number>> = {
  general: {
    vector: 1.2,
    keyword: 1,
    time: 0.5,
    entity: 0.8,
    items: 1,
    itemEntity: 0.8,
    itemTime: 0.5,
    graph: 0.6,
    evidence: 1,
  },
  temporal: {
    vector: 1,
    keyword: 0.8,
    time: 2,
    entity: 0.8,
    items: 1,
    itemEntity: 0.8,
    itemTime: 2,
    graph: 0.5,
    evidence: 1,
  },
  update: {
    vector: 0.8,
    keyword: 0.8,
    time: 0.5,
    entity: 1,
    items: 1.6,
    itemEntity: 1.2,
    itemTime: 0.5,
    graph: 0.6,
    evidence: 1,
  },
  aggregate: {
    vector: 1,
    keyword: 1.2,
    time: 0.8,
    entity: 1.2,
    items: 1.2,
    itemEntity: 1.2,
    itemTime: 0.8,
    graph: 0.8,
    evidence: 1,
  },
  preference: {
    vector: 1,
    keyword: 0.8,
    time: 0.3,
    entity: 0.8,
    items: 1.6,
    itemEntity: 1,
    itemTime: 0.3,
    graph: 0.6,
    evidence: 1,
  },
};

export interface RetrievalRequest {
  /** What the turn asks */
  input: string;
  /** When it is asked: the time it names is resolved from it, and items are read as of it */
  anchor: Date;
  timeZone?: string;
  /** The history the turn sees, oldest first */
  history: readonly MemoryEntry[];
  /** Entries the context holds anyway (its tail), left out of the search */
  held?: ReadonlySet<string>;
  /** How close each entry is to the input, by entry id, from a vector search */
  cosines?: ReadonlyMap<string, number>;
  /** Memory items to search, and whose they are */
  items?: MemoryItems;
  itemAdapter?: MemoryItemAdapter;
  scope?: MemoryItemScope;
}

/** A turn a search found, with the turns it should be read with */
export interface RetrievedEntry {
  entry: MemoryEntry;
  score: number;
  channels: string[];
  /** Entries next to it that make it readable: the question an answer replies to and back */
  neighbors: MemoryEntry[];
}

export interface RetrievedItem {
  item: MemoryItem;
  score: number;
  channels: string[];
}

export interface Retrieval {
  analysis: QueryAnalysis;
  /** Turns and items found, best first, one ranked list across both */
  hits: ({ kind: 'entry'; hit: RetrievedEntry } | { kind: 'item'; hit: RetrievedItem })[];
}

/** Keyword index of a thread, kept between turns */
interface ThreadIndex {
  index: BM25Index;
  ids: Set<string>;
}

/**
 * Searches memory for a turn in channels at once and ranks what they find as one list.
 *
 * Turns of the history are found by how close they are to the input (vectors given by the
 * caller, those under {@link MIN_COSINE} or under {@link RELATIVE_COSINE} of the best left out),
 * by its words (BM25, an index per thread kept between turns), by the time it names, and by the
 * entities of memory it names. Memory items are found by their words, by those entities, by the
 * time they are about, and by a personalized PageRank walk over the graph of items and the
 * entities they name, seeded with the entities of the turn and the best items of the other
 * channels, and turns the best items stand on are found through their evidence. The channels
 * are fused by reciprocal rank with weights for the kind of question
 * (`analyzeQuery`), reranked by how many of the turn's words a hit holds, biased toward turns
 * said lately, and laid out for diversity (MMR). A turn that is small talk is not searched.
 */
export class MemoryRetriever {
  private readonly threads = new Map<string, ThreadIndex>();

  async retrieve(request: RetrievalRequest): Promise<Retrieval> {
    const analysis = analyzeQuery(request.input, request.anchor, request.timeZone);
    if (!analysis.retrieve) return { analysis, hits: [] };
    const held = request.held ?? new Set<string>();
    const turns = request.history.filter(
      (entry) => !held.has(entry.id) && indexedText(entry) !== undefined
    );
    const position = new Map(request.history.map((entry, at) => [entry.id, at]));

    const weights = WEIGHTS[analysis.type];
    const entities = await this.entitiesNamed(request, analysis);
    const items = await this.itemsOf(request, analysis);
    const turnChannels: (ChannelHits & { channel: Channel })[] = [
      { channel: 'vector', weight: weights.vector, ids: this.vectorHits(turns, request.cosines) },
      {
        channel: 'keyword',
        weight: weights.keyword,
        ids: this.keywordHits(request.history, turns, request.input),
      },
      { channel: 'entity', weight: weights.entity, ids: this.entityHits(turns, entities) },
    ];
    const itemChannels: (ChannelHits & { channel: Channel })[] = [
      { channel: 'items', weight: weights.items, ids: this.itemHits(items, analysis) },
      {
        channel: 'itemEntity',
        weight: weights.itemEntity,
        ids: items
          .filter((item) => item.entityId && entities.some((entity) => entity.id === item.entityId))
          .map((item) => `i:${item.id}`)
          .slice(0, CHANNEL_HITS),
      },
    ];
    const channels = [
      ...turnChannels,
      {
        channel: 'time' as const,
        weight: weights.time,
        ids: this.timeHits(turns, analysis, fuse(turnChannels)),
      },
      ...itemChannels,
      {
        channel: 'itemTime' as const,
        weight: weights.itemTime,
        ids: this.itemTimeHits(items, analysis, fuse(itemChannels)),
      },
    ];
    const seeds = fuse(channels.filter((channel) => channel.channel.startsWith('item')));
    channels.push({
      channel: 'graph',
      weight: weights.graph,
      ids: await this.graphHits(request, items, entities, seeds),
    });
    channels.push({
      channel: 'evidence',
      weight: weights.evidence,
      ids: evidenceHits(turns, items, seeds),
    });

    const fused = fuse(channels.filter((channel) => channel.ids.length > 0));
    const found = new Map<string, Set<string>>();
    for (const channel of channels) {
      for (const id of channel.ids) {
        found.set(id, (found.get(id) ?? new Set()).add(channel.channel));
      }
    }

    const byId = new Map(request.history.map((entry) => [entry.id, entry]));
    const itemById = new Map(items.map((item) => [item.id, item]));
    const df = documentFrequency(
      [...fused.keys()].map((id) => textOf(id, byId, itemById) ?? ''),
      analysis.terms
    );
    const last = request.history.length;
    const scored = [...fused.entries()].flatMap(([id, fusedScore]) => {
      const text = textOf(id, byId, itemById);
      if (text === undefined) return [];
      let score = fusedScore * (1 + 0.5 * lexicalScore(analysis.terms, text, df));
      if (id.startsWith('e:')) {
        const turnsAgo = (last - (position.get(id.slice(2)) ?? last)) / 2;
        score *= recencyBias(turnsAgo);
      } else {
        const item = itemById.get(id.slice(2));
        if (item?.timesRetrieved) score *= 1 + 0.05 * Math.log2(1 + item.timesRetrieved);
        if (item && analysis.type === 'update' && item.validTo === undefined) score *= 1.2;
        if (
          item &&
          analysis.type === 'preference' &&
          (item.kind === 'preference' || item.kind === 'instruction')
        ) {
          score *= 1.3;
        }
      }
      return [{ id, score, words: wordsOf(text) }];
    });
    const ranked = diversify(scored.sort((a, b) => b.score - a.score).slice(0, RANKED));

    return {
      analysis,
      hits: ranked.flatMap((candidate): Retrieval['hits'] => {
        const channelsOf = [...(found.get(candidate.id) ?? [])];
        if (candidate.id.startsWith('e:')) {
          const entry = byId.get(candidate.id.slice(2));
          if (!entry) return [];
          return [
            {
              kind: 'entry' as const,
              hit: {
                entry,
                score: candidate.score,
                channels: channelsOf,
                neighbors: neighborsOf(entry, request.history, position, held),
              },
            },
          ];
        }
        const item = itemById.get(candidate.id.slice(2));
        return item
          ? [{ kind: 'item' as const, hit: { item, score: candidate.score, channels: channelsOf } }]
          : [];
      }),
    };
  }

  /** Turns close to the input: the cosines that clear the absolute and the relative bar */
  private vectorHits(
    turns: readonly MemoryEntry[],
    cosines: ReadonlyMap<string, number> | undefined
  ): string[] {
    if (!cosines || cosines.size === 0) return [];
    const scored = turns.flatMap((entry) => {
      const cosine = cosines.get(entry.id);
      return cosine === undefined ? [] : [{ id: entry.id, cosine }];
    });
    const best = Math.max(0, ...scored.map((hit) => hit.cosine));
    const bar = Math.max(MIN_COSINE, RELATIVE_COSINE * best);
    return scored
      .filter((hit) => hit.cosine >= bar)
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, CHANNEL_HITS)
      .map((hit) => `e:${hit.id}`);
  }

  /** Turns that hold the input's words, by BM25 over the thread, its index kept between turns */
  private keywordHits(
    history: readonly MemoryEntry[],
    turns: readonly MemoryEntry[],
    input: string
  ): string[] {
    const threadId = history[0]?.threadId;
    if (threadId === undefined || turns.length === 0) return [];
    const index = this.threadIndex(threadId, history);
    const allowed = new Set(turns.map((entry) => entry.id));
    return index
      .search(input, CHANNEL_HITS * 2)
      .filter((hit) => allowed.has(hit.id))
      .slice(0, CHANNEL_HITS)
      .map((hit) => `e:${hit.id}`);
  }

  private threadIndex(threadId: string, history: readonly MemoryEntry[]): BM25Index {
    const ids = new Set(history.map((entry) => entry.id));
    let kept = this.threads.get(threadId);
    if (kept && [...kept.ids].some((id) => !ids.has(id))) kept = undefined;
    if (!kept) kept = { index: new BM25Index(), ids: new Set() };
    for (const entry of history) {
      if (kept.ids.has(entry.id)) continue;
      const text = indexedText(entry);
      kept.ids.add(entry.id);
      if (text) kept.index.addDocument({ id: entry.id, content: text.text });
    }
    this.threads.delete(threadId);
    this.threads.set(threadId, kept);
    if (this.threads.size > THREADS_KEPT) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) this.threads.delete(oldest);
    }
    return kept.index;
  }

  /**
   * Turns said in the time the input names, those the other channels found first, then those
   * that hold more of the input's words, then in the order they were said
   */
  private timeHits(
    turns: readonly MemoryEntry[],
    analysis: QueryAnalysis,
    found: ReadonlyMap<string, number>
  ): string[] {
    const start = analysis.time?.start?.getTime();
    const end = analysis.time?.end?.getTime();
    if (start === undefined || end === undefined) return [];
    const within = turns.filter((entry) => {
      const at = entry.createdAt.getTime();
      return at >= start && (at < end || (start === end && at === start));
    });
    return byRelevance(
      within.map((entry) => ({ id: `e:${entry.id}`, text: indexedText(entry)?.text ?? '' })),
      analysis,
      found
    );
  }

  /** Turns that name an entity the input names */
  private entityHits(turns: readonly MemoryEntry[], entities: readonly MemoryEntity[]): string[] {
    if (entities.length === 0) return [];
    const names = entities.flatMap((entity) => namePatterns([entity.name, ...entity.aliases]));
    return turns
      .filter((entry) => {
        const text = normalizeName(indexedText(entry)?.text ?? '');
        return names.some((name) => name.test(text));
      })
      .slice(-CHANNEL_HITS)
      .reverse()
      .map((entry) => `e:${entry.id}`);
  }

  /** The entities of memory the input names: its runs of up to three words, matched by name */
  private async entitiesNamed(
    request: RetrievalRequest,
    analysis: QueryAnalysis
  ): Promise<MemoryEntity[]> {
    if (!request.itemAdapter || !request.scope) return [];
    const words = normalizeName(request.input)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const names = new Set<string>();
    for (let size = 1; size <= 3; size++) {
      for (let at = 0; at + size <= words.length; at++) {
        names.add(words.slice(at, at + size).join(' '));
      }
    }
    if (names.size === 0 || analysis.terms.length === 0) return [];
    const found = await request.itemAdapter.findEntities({
      agentId: request.scope.agentId,
      names: [...names],
    });
    const scope = request.scope;
    return found.success ? found.data.filter((entity) => visibleIn(entity, scope)) : [];
  }

  /**
   * The memory items the turn may draw on: those that hold now, and for a question about time or
   * about many things, the ones that held before too
   */
  private async itemsOf(request: RetrievalRequest, analysis: QueryAnalysis): Promise<MemoryItem[]> {
    if (!request.items || !request.scope) return [];
    const past = analysis.type === 'temporal' || analysis.type === 'aggregate';
    return request.items.query({
      scope: request.scope,
      includeClosed: past,
      asOf: request.anchor,
    });
  }

  /** Items that hold the input's words, by BM25 over the items */
  private itemHits(items: readonly MemoryItem[], analysis: QueryAnalysis): string[] {
    if (items.length === 0 || analysis.terms.length === 0) return [];
    const index = new BM25Index();
    for (const item of items) {
      index.addDocument({ id: item.id, content: `${item.content} ${item.value ?? ''}` });
    }
    return index.search(analysis.terms.join(' '), CHANNEL_HITS).map((hit) => `i:${hit.id}`);
  }

  /**
   * Items about the time the input names (what they are about, or when they started to hold),
   * ordered like {@link timeHits}
   */
  private itemTimeHits(
    items: readonly MemoryItem[],
    analysis: QueryAnalysis,
    found: ReadonlyMap<string, number>
  ): string[] {
    const start = analysis.time?.start?.getTime();
    const end = analysis.time?.end?.getTime();
    if (start === undefined || end === undefined) return [];
    const until = end > start ? end : start + 1;
    const overlaps = (from?: Date, to?: Date) =>
      from !== undefined && from.getTime() < until && (to ?? from).getTime() >= start;
    const within = items.filter(
      (item) =>
        overlaps(item.about?.start, item.about?.end) ||
        overlaps(item.validFrom, item.validTo ?? item.validFrom) ||
        overlaps(item.saidAt, item.saidAt)
    );
    return byRelevance(
      within.map((item) => ({ id: `i:${item.id}`, text: `${item.content} ${item.value ?? ''}` })),
      analysis,
      found
    );
  }

  /**
   * Items a personalized PageRank walk reaches over the graph of items and entities (an item is
   * joined to the entity it is about and to every entity it names), starting from the entities of
   * the turn and the best items the other channels found
   */
  private async graphHits(
    request: RetrievalRequest,
    items: readonly MemoryItem[],
    named: readonly MemoryEntity[],
    seeds: ReadonlyMap<string, number>
  ): Promise<string[]> {
    if (!request.itemAdapter || !request.scope || items.length === 0) return [];
    const found = await request.itemAdapter.findEntities({ agentId: request.scope.agentId });
    const scope = request.scope;
    const entities = (found.success ? found.data : [])
      .filter((entity) => visibleIn(entity, scope))
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, GRAPH_ENTITIES);
    if (entities.length === 0) return [];

    const edges = new Map<string, Set<string>>();
    const join = (a: string, b: string) => {
      edges.set(a, (edges.get(a) ?? new Set()).add(b));
      edges.set(b, (edges.get(b) ?? new Set()).add(a));
    };
    const names = entities.map((entity) => ({
      id: `n:${entity.id}`,
      names: namePatterns([entity.name, ...entity.aliases]),
    }));
    for (const item of items) {
      const node = `i:${item.id}`;
      if (item.entityId) join(node, `n:${item.entityId}`);
      const text = normalizeName(`${item.content} ${item.value ?? ''}`);
      for (const entity of names) {
        if (entity.names.some((name) => name.test(text))) join(node, entity.id);
      }
    }

    const start = new Map<string, number>();
    for (const entity of named) start.set(`n:${entity.id}`, 1);
    const bestItems = [...seeds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [id] of bestItems) start.set(id, (start.get(id) ?? 0) + 0.5);
    const total = [...start.values()].reduce((sum, value) => sum + value, 0);
    if (total === 0) return [];
    const reset = new Map([...start].map(([id, value]) => [id, value / total]));

    let rank = new Map(reset);
    for (let pass = 0; pass < PPR_ITERATIONS; pass++) {
      const next = new Map<string, number>();
      for (const [node, value] of rank) {
        const neighbours = edges.get(node);
        if (!neighbours || neighbours.size === 0) continue;
        const share = (PPR_DAMPING * value) / neighbours.size;
        for (const neighbour of neighbours) next.set(neighbour, (next.get(neighbour) ?? 0) + share);
      }
      for (const [node, value] of reset) {
        next.set(node, (next.get(node) ?? 0) + (1 - PPR_DAMPING) * value);
      }
      rank = next;
    }
    return [...rank.entries()]
      .filter(([id]) => id.startsWith('i:'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, CHANNEL_HITS)
      .map(([id]) => id);
  }
}

/**
 * Patterns that find a name of an entity as whole words of a normalized text, so `Ana` is not
 * found in `banana`; names under three letters are left out
 */
function namePatterns(names: readonly string[]): RegExp[] {
  return names
    .map(normalizeName)
    .filter((name) => name.length > 2)
    .map(
      (name) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
          'u'
        )
    );
}

/**
 * The ids of `candidates` the other channels scored first, then by the share of the input's words
 * they hold, the rest in the order given; at most a channel's worth
 */
function byRelevance(
  candidates: readonly { id: string; text: string }[],
  analysis: QueryAnalysis,
  found: ReadonlyMap<string, number>
): string[] {
  return candidates
    .map((candidate, at) => ({
      id: candidate.id,
      at,
      found: found.get(candidate.id) ?? 0,
      lexical: lexicalScore(analysis.terms, candidate.text),
    }))
    .sort((a, b) => b.found - a.found || b.lexical - a.lexical || a.at - b.at)
    .slice(0, CHANNEL_HITS)
    .map((candidate) => candidate.id);
}

/**
 * Turns the best items the item channels found stand on: what memory extracted from a turn makes
 * the turn findable by what it meant, not only by its words
 */
function evidenceHits(
  turns: readonly MemoryEntry[],
  items: readonly MemoryItem[],
  seeds: ReadonlyMap<string, number>
): string[] {
  const open = new Set(turns.map((entry) => entry.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  const ids = new Set<string>();
  for (const [id] of [...seeds.entries()].sort((a, b) => b[1] - a[1])) {
    for (const piece of byId.get(id.slice(2))?.evidence ?? []) {
      if (piece.entryId && open.has(piece.entryId)) ids.add(`e:${piece.entryId}`);
    }
    if (ids.size >= CHANNEL_HITS) break;
  }
  return [...ids].slice(0, CHANNEL_HITS);
}

function textOf(
  id: string,
  entries: ReadonlyMap<string, MemoryEntry>,
  items: ReadonlyMap<string, MemoryItem>
): string | undefined {
  if (id.startsWith('e:')) {
    const entry = entries.get(id.slice(2));
    return entry ? indexedText(entry)?.text : undefined;
  }
  const item = items.get(id.slice(2));
  return item ? `${item.content} ${item.value ?? ''}` : undefined;
}

/** In how many of `texts` each of `terms` appears */
function documentFrequency(texts: readonly string[], terms: readonly string[]) {
  const counts = new Map<string, number>();
  const wanted = new Set(terms);
  for (const text of texts) {
    for (const word of new Set(tokenize(text))) {
      if (wanted.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return (term: string) => counts.get(term) ?? 0;
}

/**
 * The turns next to `entry` that make it readable on its own: the user message an answer replies
 * to, and the answer to a user message, unless the context holds them anyway
 */
function neighborsOf(
  entry: MemoryEntry,
  history: readonly MemoryEntry[],
  position: ReadonlyMap<string, number>,
  held: ReadonlySet<string>
): MemoryEntry[] {
  const at = position.get(entry.id);
  if (at === undefined) return [];
  const step = entry.message.role === 'assistant' ? -1 : 1;
  for (let next = at + step; next >= 0 && next < history.length; next += step) {
    const neighbor = history[next];
    if (!neighbor || indexedText(neighbor) === undefined) continue;
    if (neighbor.message.role === entry.message.role) return [];
    return held.has(neighbor.id) ? [] : [neighbor];
  }
  return [];
}
