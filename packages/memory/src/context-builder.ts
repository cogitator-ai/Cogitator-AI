/**
 * Context builder with token management
 *
 * Builds conversation context from memory while respecting token limits.
 */

import type {
  ContextPartition,
  Message,
  MemoryEntry,
  Fact,
  Embedding,
  GraphContext,
  ContextBuilderConfig,
  ContextPartitionBudget,
  ContextBuildError,
  BuiltContext,
  DroppedContext,
  GraphNode,
  MemoryAdapter,
  FactAdapter,
  Reranker,
  MemoryItem,
  MemoryItemKind,
  MemoryItemTrust,
  EmbeddingAdapter,
  EmbeddingService,
  MemoryResult,
  TimePrecision,
} from '@cogitator-ai/types';
import { historyMessage } from '@cogitator-ai/types';
import { isMemoryItemAdapter, onePerSlot, visibleIn, type MemoryItems } from './memory-items';
import { inert } from './memory-files';
import { namedIn, type MemoryObservation, type MemoryObservations } from './memory-observations';
import { MemoryRetriever, type Retrieval } from './retrieval/retriever';
import { analyzeQuery } from './retrieval/query';
import type { GraphContextBuilder } from './knowledge-graph/graph-context-builder';
import { readCompactedHistory, withoutStaleDurableEntries } from './compaction';
import { calendarDate, isTimeZone } from './time-resolution';
import {
  ContextAssembler,
  DEFAULT_PARTITIONS,
  fitInOrder,
  type Assembly,
  type AssemblyBlock,
  type FitResult,
  type PartitionCandidates,
} from './context-assembler';
import { countEntryTokens, countMessageTokens, countTokens } from './token-counter';
import { indexedText, type IndexedText, type MessageIndex } from './message-index';

const SEMANTIC_RESULTS = 5;

/**
 * How many of the newest history entries the `relevant` and `hybrid` strategies score against
 * the input. Older entries are left out, which keeps the cost of a turn flat on long threads.
 */
const MAX_SCORED_ENTRIES = 200;

/** History entry vectors kept per builder, so an entry is embedded once rather than every turn. */
const ENTRY_VECTOR_CACHE_SIZE = 4096;

/** Entries older than the scored window a `messageIndex` search may bring back */
const INDEX_SEARCH_RESULTS = 50;

/** What semantic context searches: facts and documents, never the vectors of messages */
const SEMANTIC_SOURCES: Embedding['sourceType'][] = ['fact', 'document'];

/** How the part of a context that changes every turn introduces itself to the model */
const TURN_CONTEXT_HEADER =
  'Context for this turn (recalled from memory and supplied by the application, not written by the user):';

const TURN_CONTEXT_OPEN = '<memory_context>';
const TURN_CONTEXT_CLOSE = '</memory_context>';

/**
 * The part of a context that changes every turn, as one text sent with the input: `blocks` under
 * a header that tells the model where they come from, inside `<memory_context>` tags so the model
 * can tell them from the input that follows, none when there are no blocks
 */
export function formatTurnContext(blocks: readonly string[]): string | undefined {
  const present = blocks.filter((block) => block.trim());
  if (present.length === 0) return undefined;
  return [TURN_CONTEXT_OPEN, TURN_CONTEXT_HEADER, ...present, TURN_CONTEXT_CLOSE].join('\n\n');
}

/**
 * `text` with `block` added to its turn context: inside the one `formatTurnContext` put in front
 * of it, or in a new one there
 */
export function extendTurnContext(text: string, block: string): string {
  if (!block.trim()) return text;
  const end = text.startsWith(TURN_CONTEXT_OPEN) ? text.indexOf(TURN_CONTEXT_CLOSE) : -1;
  if (end === -1) {
    const context = formatTurnContext([block]) ?? '';
    return text ? `${context}\n\n${text}` : context;
  }
  return `${text.slice(0, end)}${block}\n\n${text.slice(end)}`;
}

/** `text` without the turn context `formatTurnContext` put in front of it */
export function withoutTurnContext(text: string): string {
  if (!text.startsWith(TURN_CONTEXT_OPEN)) return text;
  const end = text.indexOf(TURN_CONTEXT_CLOSE);
  return end === -1 ? text : text.slice(end + TURN_CONTEXT_CLOSE.length).replace(/^\s+/, '');
}

/** The order kinds of memory items go into a context in: what steers the answer first */
const KIND_ORDER: Record<MemoryItemKind, number> = {
  instruction: 0,
  preference: 1,
  fact: 2,
  opinion: 3,
  event: 4,
  lesson: 5,
};

const SOURCE_OF_TRUST: Record<MemoryItemTrust, Fact['source']> = {
  user: 'user',
  system: 'system',
  model: 'inferred',
  tool: 'inferred',
  web: 'inferred',
};

/** The heading of the earlier turns a search of memory brought */
const RECALLED_TURNS_HEADER = 'Earlier in this conversation:';
const OBSERVATIONS_HEADER =
  'What memory makes of them (written from the facts, may lag behind them):';
/** Observations a turn gets at most */
const MAX_OBSERVATIONS = 3;
/** Memory items embedded in one call */
const ITEM_EMBED_BATCH = 64;
/** Vectors of memory items a builder keeps, the used least lately dropped past it */
const ITEM_VECTORS_KEPT = 20_000;
/** Hits of a search of memory a reranker reorders, the best */
const RERANKED = 30;
/** The heading of the memory items a search of memory brought */
const RECALLED_ITEMS_HEADER = 'From memory:';

/** `YYYY-MM-DD` of `date` on the calendar of `timeZone` */
function dayOf(date: Date, timeZone: string): string {
  const { year, month, day } = calendarDate(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Earlier turns as the context shows them: each on its line with its date and who said it */
function turnLines(turn: readonly MemoryEntry[], timeZone: string): string {
  return turn
    .map((entry) => {
      const text = typeof entry.message.content === 'string' ? entry.message.content : '';
      return `[${dayOf(entry.createdAt, timeZone)}] ${entry.message.role}: ${text}`;
    })
    .join('\n');
}

/**
 * Tokens recalled turns take: each line as shown, or the entry's own count when that is more,
 * such as a stored count of a model that reads the text as more tokens than an estimate
 */
function recalledTokens(turn: readonly MemoryEntry[], timeZone: string): number {
  return turn.reduce(
    (sum, entry) =>
      sum + Math.max(countTokens(turnLines([entry], timeZone)), countEntryTokens(entry)),
    0
  );
}

/** A memory item as the context shows it, with when it held when it no longer does */
function itemLine(item: MemoryItem, timeZone: string): string {
  const day = (date: Date) => dayOf(date, timeZone);
  const held =
    item.validTo !== undefined
      ? ` (${item.validFrom ? `${day(item.validFrom)} to ` : 'until '}${day(item.validTo)})`
      : item.about?.start
        ? ` (${whenOf(item.about.start, item.about.end, item.about.precision, timeZone)})`
        : '';
  return `- ${item.content}${held}`;
}

/**
 * The time an item is about as a date to the precision it was said with, never the words that
 * said it: `last Friday` read a month later would point at another day. The date is read in the
 * middle of the interval, so a month or a year resolved in another time zone than the one shown
 * is not shown as the one before.
 */
function whenOf(
  start: Date,
  end: Date | undefined,
  precision: TimePrecision,
  timeZone: string
): string {
  const middle =
    end !== undefined && end.getTime() > start.getTime() && precision !== 'instant'
      ? new Date((start.getTime() + end.getTime()) / 2)
      : start;
  const day = dayOf(middle, timeZone);
  switch (precision) {
    case 'year':
      return day.slice(0, 4);
    case 'month':
      return day.slice(0, 7);
    case 'week':
      return `week of ${dayOf(start, timeZone)}`;
    case 'approximate':
      return `around ${day}`;
    default:
      return day;
  }
}

/** An observation as a turn's memory context shows it */
function observationText(observation: MemoryObservation): string {
  return inert(`${observation.name}:\n${observation.text}`);
}

/** A line of the `Known facts` block, with the value a fact replaced when it replaced one */
function factLine(fact: Fact): string {
  const previously = fact.metadata?.previously;
  return typeof previously === 'string' && previously
    ? `- ${fact.content} (previously: ${previously})`
    : `- ${fact.content}`;
}

/**
 * The memory items of the run's agent, user and thread that hold now, as facts, under the
 * agent's memory id and under its runtime id (where facts added for `agent.id` are): one per slot,
 * instructions and preferences first, newest first within a kind, each with the value of the
 * item it superseded when the run may still see it, as of `options.asOf`
 */
async function loadItemFacts(items: MemoryItems, options: BuildContextOptions): Promise<Fact[]> {
  const agentIds = [...new Set([options.memoryAgentId ?? options.agentId, options.agentId])];
  const found = await Promise.all(
    agentIds.map((agentId) =>
      items.query({
        scope: {
          agentId,
          ...(options.userId !== undefined && { userId: options.userId }),
          threadId: options.threadId,
        },
        ...(options.asOf !== undefined && { asOf: options.asOf }),
      })
    )
  );
  const current = [...new Map(found.flat().map((item) => [item.id, item])).values()];
  const scope = {
    agentId: options.memoryAgentId ?? options.agentId,
    ...(options.userId !== undefined && { userId: options.userId }),
    threadId: options.threadId,
  };
  const ordered = onePerSlot(current).sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.recordedAt.getTime() - a.recordedAt.getTime()
  );
  const knownAt = (options.asOf ?? new Date()).getTime();
  return Promise.all(
    ordered.map(async (item): Promise<Fact> => {
      const replaced = item.supersedes?.at(-1);
      const before = replaced ? await items.get(replaced) : null;
      const shown =
        before &&
        agentIds.includes(before.scope.agentId) &&
        visibleIn(before, { ...scope, agentId: before.scope.agentId }) &&
        (before.expiredAt === undefined || before.expiredAt.getTime() > knownAt);
      const previously = shown ? (before.value ?? before.content) : undefined;
      return {
        id: item.id,
        agentId: item.scope.agentId,
        content: item.content,
        category: item.kind,
        confidence: item.confidence,
        source: SOURCE_OF_TRUST[item.trust],
        createdAt: item.recordedAt,
        updatedAt: item.recordedAt,
        evidence: item.evidence,
        metadata: {
          ...item.metadata,
          ...(item.scope.userId !== undefined && { userId: item.scope.userId }),
          ...(item.slot !== undefined && { slot: item.slot }),
          trust: item.trust,
          ...(previously !== undefined && { previously }),
        },
      };
    })
  );
}

/** What a block of a context holds */
type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'input' }
  | { kind: 'entry'; entry: MemoryEntry }
  | { kind: 'fact'; fact: Fact }
  | { kind: 'retrieved'; entries: MemoryEntry[] }
  | { kind: 'recalled'; item: MemoryItem }
  | { kind: 'semantic'; result: Embedding & { score: number } }
  | { kind: 'graph'; context: GraphContext }
  | { kind: 'observation'; observation: MemoryObservation };

function textBlock(text: string, tokens = countTokens(text)): AssemblyBlock<Piece> {
  return { value: { kind: 'text', text }, tokens, text };
}

function entryBlock(entry: MemoryEntry): AssemblyBlock<Piece> {
  return { value: { kind: 'entry', entry }, tokens: countEntryTokens(entry), sourceId: entry.id };
}

/**
 * `history` with cache breakpoints at its end and at the end of the turn before the last one, so
 * the next turn finds the prefix this turn cached even when its own turn added many blocks
 */
export function markTurnEnds(history: Message[]): Message[] {
  const last = history.length - 1;
  if (last < 0) return history;
  const lastInput = history.map((message) => message.role).lastIndexOf('user');
  const turnBefore = lastInput - 1;
  return history.map((message, at) =>
    at === last || (at === turnBefore && history[at]?.role !== 'system')
      ? { ...message, cacheBreakpoint: true }
      : message
  );
}

function entryOf(block: AssemblyBlock<Piece>): MemoryEntry {
  if (block.value.kind !== 'entry') throw new Error('A history block holds no entry');
  return block.value.entry;
}

/**
 * A tool result too large for the room left, in its place: the call keeps an answer, so the
 * history stays valid for every provider, and the model learns the output was left out
 */
function withoutOutput(entry: MemoryEntry): MemoryEntry {
  const tokens = countEntryTokens(entry);
  const message = {
    ...entry.message,
    content: `[The output of this tool call, about ${tokens} tokens, was left out of the context to make room]`,
  };
  return {
    ...entry,
    message,
    tokenCount: countMessageTokens(message),
    toolResults: entry.toolResults?.map((result) => ({ ...result, result: null })),
  };
}

/** The value of a memory operation, or an error naming the operation that failed. */
function unwrap<T>(result: MemoryResult<T>, operation: string): T {
  if (!result.success) throw new Error(`Memory ${operation} failed: ${result.error}`);
  return result.data;
}

/**
 * Whether memory scoped by `metadata` may go into a context: never when it
 * belongs to another agent (`metadata.agentId`) or another user
 * (`metadata.userId`); memory without an owner (shared documents, agent-wide
 * facts) is visible to everyone.
 */
function isVisibleTo(
  metadata: Record<string, unknown> | undefined,
  agentId: string,
  userId: string | undefined
): boolean {
  const agent = metadata?.agentId;
  const user = metadata?.userId;
  return (
    (agent === undefined || agent === null || agent === agentId) &&
    (user === undefined || user === null || user === userId)
  );
}

export interface ContextBuilderDeps {
  memoryAdapter: MemoryAdapter;
  factAdapter?: FactAdapter;
  /**
   * Memory items, read for the facts in place of `factAdapter`: the items the run's agent,
   * user and thread see that hold now
   */
  memoryItems?: MemoryItems;
  /** Reorders the best of what a search of memory found for a turn, see `MemoryConfig.reranker` */
  reranker?: Reranker;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingService?: EmbeddingService;
  graphContextBuilder?: GraphContextBuilder;
  /**
   * Vectors of history entries kept in an embedding store. With it `relevant` and `hybrid`
   * embed only the input and the entries not indexed yet, and find older entries of the thread
   * by a search of the store. Without it the builder keeps vectors in process.
   */
  messageIndex?: MessageIndex;
  /**
   * Observations of the entities memory items are about: a turn whose input names an entity,
   * or that recalls one of its items, gets its observation next to the facts
   */
  observations?: Pick<MemoryObservations, 'read'>;
}

export interface BuildContextOptions {
  threadId: string;
  agentId: string;
  /**
   * The id the agent's memory items are kept under, `agentId` by default: a runtime passes the
   * agent's configured id, else its name, which stays the same across instances
   */
  memoryAgentId?: string;
  /** The user the context is built for: facts and embeddings of other users are left out */
  userId?: string;
  systemPrompt?: string;
  currentInput?: string;
  /**
   * Token budget of this context in place of the builder's `maxTokens`, such as the context
   * window of the model it is built for
   */
  maxTokens?: number;
  /**
   * The entry the history ends at: the thread's active branch by default, the branch ending at
   * this entry when given, none for null. Needs an adapter with branches; without, the whole
   * thread is read.
   */
  leafId?: string | null;
  /** Tokens of the budget kept free for the answer, in place of the builder's `reserveTokens` */
  reserveTokens?: number;
  /** What is always in context, after the system prompt (the `pinned` partition) */
  pinned?: string[];
  /** What memory holds, for the model to know what to look up (the `index` partition) */
  index?: string;
  /** Notes prepared for this turn (the `brief` partition) */
  brief?: string;
  /**
   * The moment the turn is read at, the clock by default: the date memory searches resolve the
   * time a turn names from, and the moment memory items are read as of
   */
  asOf?: Date;
  /**
   * IANA time zone of the thread, in place of the builder's `timeZone`: the calendar the dates of
   * recalled turns are shown in and the time a turn names is read on
   */
  timeZone?: string;
}

type ResolvedConfig = Required<Omit<ContextBuilderConfig, 'maxTokens' | 'reserveTokens'>> &
  Pick<ContextBuilderConfig, 'maxTokens' | 'reserveTokens'>;

/** What scoring knows of the build: the index mark taken before the read, and the thread size */
interface ScoringScope {
  mark?: number;
  threadSize: number;
}

/**
 * Share of the budget `hybrid` recalls into when its config sets none: older turns and memory
 * items found for the turn earn more of a long thread's budget than its newest turns do, and
 * what recall leaves unused goes back to `recent`
 */
const HYBRID_RECALL_SHARE = 0.6;

/**
 * The partitions of `config`, with the `recall` share of `hybrid` raised to
 * {@link HYBRID_RECALL_SHARE} when the config sets none, as far as the other shares leave room
 */
function partitionsFor(
  config: ContextBuilderConfig
): Partial<Record<ContextPartition, ContextPartitionBudget>> {
  const partitions = config.partitions ?? {};
  if (config.strategy !== 'hybrid' || partitions.recall?.share !== undefined) return partitions;
  const others = (Object.keys(DEFAULT_PARTITIONS) as ContextPartition[])
    .filter((name) => name !== 'recall')
    .reduce((sum, name) => {
      const budget = { ...DEFAULT_PARTITIONS[name], ...partitions[name] };
      return sum + (budget.required ? 0 : (budget.share ?? 0));
    }, 0);
  const share = Math.max(0, Math.min(HYBRID_RECALL_SHARE, 1 - others));
  return { ...partitions, recall: { ...partitions.recall, share } };
}

function validBudget(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ContextBuilder ${name} must be a positive number, got ${value}`);
  }
  return value;
}

export class ContextBuilder {
  private config: ResolvedConfig;
  private deps: ContextBuilderDeps;
  private readonly entryVectors = new Map<string, Float32Array>();
  /** Vectors of memory items by model and item id: an item's content never changes */
  private readonly itemVectors = new Map<string, Float32Array>();
  private readonly assembler: ContextAssembler;
  private readonly retriever = new MemoryRetriever();

  constructor(config: ContextBuilderConfig, deps: ContextBuilderDeps) {
    if (config.maxTokens !== undefined) validBudget(config.maxTokens, 'maxTokens');
    this.config = {
      maxTokens: config.maxTokens,
      reserveTokens: config.reserveTokens,
      strategy: config.strategy,
      includeSystemPrompt: config.includeSystemPrompt ?? true,
      includeFacts: config.includeFacts ?? false,
      includeSemanticContext: config.includeSemanticContext ?? false,
      includeGraphContext: config.includeGraphContext ?? false,
      graphContextOptions: config.graphContextOptions ?? {},
      partitions: partitionsFor(config),
      timeZone: config.timeZone ?? 'UTC',
    };
    if (!isTimeZone(this.config.timeZone)) {
      throw new Error(`ContextBuilder timeZone must be an IANA time zone, got ${config.timeZone}`);
    }
    this.assembler = new ContextAssembler(this.config.partitions);
    this.deps = deps;
  }

  /**
   * The context for a turn of `options.threadId`, within `options.maxTokens`, else the builder's
   * `maxTokens`, minus `reserveTokens`. The budget is shared among the partitions of the context
   * (see `ContextBuilderConfig.partitions`), and what does not fit is listed in `dropped`, each
   * block with its reason.
   *
   * @throws Error when neither `options.maxTokens` nor the builder's `maxTokens` is set
   */
  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const configured = options.maxTokens ?? this.config.maxTokens;
    if (configured === undefined) {
      throw new Error(
        'ContextBuilder has no token budget: set maxTokens in its config or pass it to build()'
      );
    }
    const maxTokens = validBudget(configured, 'maxTokens');
    const reserveTokens =
      options.reserveTokens ??
      this.config.reserveTokens ??
      Math.max(100, Math.floor(maxTokens * 0.1));
    const availableTokens = Math.max(0, maxTokens - reserveTokens);
    const errors: ContextBuildError[] = [];
    const warnings: string[] = [];
    const candidates: PartitionCandidates<Piece>[] = [];

    const systemPrompt =
      this.config.includeSystemPrompt && options.systemPrompt ? options.systemPrompt : undefined;
    if (systemPrompt) {
      const tokens = countMessageTokens({ role: 'system', content: systemPrompt });
      candidates.push({ partition: 'system', blocks: [textBlock(systemPrompt, tokens)] });
      if (tokens > availableTokens) {
        warnings.push(
          `The system prompt takes ${tokens} tokens, more than the ${availableTokens} the context ` +
            `budget allows (maxTokens ${maxTokens} minus reserveTokens ` +
            `${reserveTokens}); it is kept, but no history fits. Raise maxTokens.`
        );
      }
    }
    if (options.currentInput) {
      candidates.push({
        partition: 'final',
        blocks: [{ value: { kind: 'input' }, tokens: countTokens(options.currentInput) }],
      });
    }
    const texts = (partition: ContextPartition, list: readonly string[] | undefined) => {
      const blocks = (list ?? []).filter((text) => text.trim()).map((text) => textBlock(text));
      if (blocks.length > 0) candidates.push({ partition, blocks });
    };
    texts('pinned', options.pinned);
    texts('index', options.index === undefined ? undefined : [options.index]);
    texts('brief', options.brief === undefined ? undefined : [options.brief]);

    const facts = this.config.includeFacts
      ? ((await this.attempt('facts', errors, () => this.loadFacts(options))) ?? [])
      : [];
    const keptFacts = new Set<string>();
    if (facts.length > 0) {
      candidates.push({
        partition: 'facts',
        blocks: facts.map((fact) => ({
          value: { kind: 'fact', fact },
          tokens: countTokens(factLine(fact)),
          text: fact.content,
          sourceId: fact.id,
        })),
        fit: (blocks, budget) => {
          const fitted = fitInOrder(blocks, budget);
          keptFacts.clear();
          for (const block of fitted.kept) {
            if (block.value.kind === 'fact') keptFacts.add(block.value.fact.id);
          }
          return fitted;
        },
      });
    }

    const semantic =
      this.config.includeSemanticContext && options.currentInput
        ? ((await this.attempt('semantic', errors, () => this.loadSemanticResults(options))) ?? [])
        : [];
    const graph =
      this.config.includeGraphContext && options.currentInput
        ? await this.attempt('graph', errors, () => this.loadGraphContext(options))
        : undefined;
    const graphOutcome: { droppedNodes: GraphNode[]; droppedTokens: number; failed?: boolean } = {
      droppedNodes: [],
      droppedTokens: 0,
    };
    const scope: ScoringScope = { mark: this.deps.messageIndex?.mark(), threadSize: 0 };
    const entries = (await this.attempt('history', errors, () => this.readHistory(options))) ?? [];
    scope.threadSize = entries.length;
    const summaries = entries.filter((entry) => entry.type === 'compaction');
    const history = entries.filter((entry) => entry.type !== 'compaction');
    const required = () =>
      candidates
        .filter((candidate) =>
          ['system', 'pinned', 'index', 'brief', 'final'].includes(candidate.partition)
        )
        .flatMap((candidate) => candidate.blocks)
        .reduce((sum, block) => sum + block.tokens, 0) +
      summaries.reduce((sum, entry) => sum + countEntryTokens(entry), 0);
    const recalled =
      this.config.strategy === 'hybrid' && options.currentInput
        ? ((await this.attempt('relevance', errors, () =>
            this.recall(history, options, availableTokens, required(), facts, errors, scope)
          )) ?? [])
        : [];

    const observations =
      this.deps.observations && options.currentInput
        ? ((await this.attempt('observations', errors, () =>
            this.loadObservations(options, recalled)
          )) ?? [])
        : [];

    if (semantic.length > 0 || graph || recalled.length > 0 || observations.length > 0) {
      candidates.push({
        partition: 'recall',
        blocks: [
          ...recalled,
          ...observations.map((observation) => ({
            value: { kind: 'observation' as const, observation },
            tokens: countTokens(observationText(observation)),
            text: observation.text,
            sourceId: observation.path,
          })),
          ...semantic.map((result) => ({
            value: { kind: 'semantic' as const, result },
            tokens: countTokens(`- ${result.content}`),
            text: result.content,
            sourceId: result.id,
          })),
          ...(graph
            ? [{ value: { kind: 'graph' as const, context: graph }, tokens: graph.tokenCount }]
            : []),
        ],
        fit: (blocks, budget) =>
          this.fitRecall(
            blocks.filter(
              (block) => block.value.kind !== 'recalled' || !keptFacts.has(block.value.item.id)
            ),
            budget,
            options,
            graphOutcome,
            errors
          ),
      });
    }

    const turnFrame = [
      ...(options.brief?.trim() ||
      facts.length > 0 ||
      semantic.length > 0 ||
      graph ||
      recalled.length > 0 ||
      observations.length > 0
        ? [[TURN_CONTEXT_OPEN, TURN_CONTEXT_HEADER, TURN_CONTEXT_CLOSE].join('\n\n')]
        : []),
      ...(facts.length > 0 ? ['Known facts:'] : []),
      ...(observations.length > 0 ? [OBSERVATIONS_HEADER] : []),
      ...(semantic.length > 0 ? ['Relevant context:'] : []),
      ...(recalled.some((block) => block.value.kind === 'retrieved')
        ? [RECALLED_TURNS_HEADER]
        : []),
      ...(recalled.some((block) => block.value.kind === 'recalled') ? [RECALLED_ITEMS_HEADER] : []),
    ].join('\n\n');
    if (turnFrame) {
      const final = candidates.findIndex((candidate) => candidate.partition === 'final');
      const frame: AssemblyBlock<Piece> = {
        value: { kind: 'input' },
        tokens: countTokens(turnFrame),
      };
      if (final === -1) candidates.push({ partition: 'final', blocks: [frame] });
      else
        candidates[final] = { partition: 'final', blocks: [...candidates[final]!.blocks, frame] };
    }

    if (summaries.length > 0) {
      candidates.push({ partition: 'summaries', blocks: summaries.map(entryBlock) });
    }
    if (history.length > 0) {
      candidates.push({
        partition: 'recent',
        blocks: history.map(entryBlock),
        fit: async (blocks, budget) => {
          const selected = await this.selectEntries(
            blocks.map((block) => entryOf(block)),
            budget,
            options.currentInput,
            errors,
            scope
          );
          const keptById = new Map(selected.map((entry) => [entry.id, entry]));
          const result: FitResult<Piece> = { kept: selected.map(entryBlock), dropped: [] };
          for (const block of blocks) {
            const original = entryOf(block);
            const kept = keptById.get(original.id);
            if (!kept) {
              result.dropped.push({
                block,
                reason: this.config.strategy === 'recent' ? 'budget' : 'not-selected',
              });
            } else if (kept !== original) {
              result.dropped.push({
                block: { ...block, tokens: block.tokens - countEntryTokens(kept) },
                reason: 'oversized',
              });
            }
          }
          return result;
        },
      });
    }

    const assembly = await this.assembler.assemble(availableTokens, candidates);
    return this.compose(assembly, {
      timeZone: this.timeZoneOf(options),
      systemPrompt,
      entries,
      facts,
      semantic,
      graphOutcome,
      errors,
      warnings,
    });
  }

  /**
   * The context of an assembly: one system message with what lasts, the history with its last
   * message marked as a cache breakpoint, and what changes every turn in a user message after it
   */
  private compose(
    assembly: Assembly<Piece>,
    parts: {
      systemPrompt?: string;
      entries: MemoryEntry[];
      facts: Fact[];
      semantic: (Embedding & { score: number })[];
      graphOutcome: { droppedNodes: GraphNode[]; droppedTokens: number; failed?: boolean };
      errors: ContextBuildError[];
      warnings: string[];
      timeZone: string;
    }
  ): BuiltContext {
    const { timeZone } = parts;
    const kept = (partition: ContextPartition) => assembly.kept[partition] ?? [];
    const textsOf = (partition: ContextPartition) =>
      kept(partition).flatMap((block) => (block.value.kind === 'text' ? [block.value.text] : []));

    const lasting = [
      ...(parts.systemPrompt && kept('system').length > 0 ? [parts.systemPrompt] : []),
      ...textsOf('pinned'),
      ...textsOf('index'),
    ];
    const messages: Message[] =
      lasting.length > 0 ? [{ role: 'system', content: lasting.join('\n\n') }] : [];

    const historyEntries = [...kept('summaries'), ...kept('recent')].map(entryOf);
    const history = markTurnEnds(historyEntries.map(historyMessage));
    messages.push(...history);

    const facts = kept('facts').flatMap((block) =>
      block.value.kind === 'fact' ? [block.value.fact] : []
    );
    const semanticResults = kept('recall').flatMap((block) =>
      block.value.kind === 'semantic' ? [block.value.result] : []
    );
    const graphContext = kept('recall')
      .map((block) => block.value)
      .find((value) => value.kind === 'graph')?.context;
    const inHistory = new Set(historyEntries.map((entry) => entry.id));
    const recalledTurns = kept('recall').flatMap((block) =>
      block.value.kind === 'retrieved'
        ? [block.value.entries.filter((entry) => !inHistory.has(entry.id))]
        : []
    );
    const shownTurns = recalledTurns.filter((turn) => turn.length > 0);
    const factIds = new Set(facts.map((fact) => fact.id));
    const observations = kept('recall').flatMap((block) =>
      block.value.kind === 'observation' ? [block.value.observation] : []
    );
    const recalledItems = kept('recall').flatMap((block) =>
      block.value.kind === 'recalled' && !factIds.has(block.value.item.id) ? [block.value.item] : []
    );
    const turnBlocks = [
      ...textsOf('brief'),
      ...(facts.length > 0 ? [`Known facts:\n${facts.map(factLine).join('\n')}`] : []),
      ...(observations.length > 0
        ? [`${OBSERVATIONS_HEADER}\n${observations.map(observationText).join('\n\n')}`]
        : []),
      ...(semanticResults.length > 0
        ? [`Relevant context:\n${semanticResults.map((r) => `- ${r.content}`).join('\n')}`]
        : []),
      ...(graphContext?.formattedContext ? [graphContext.formattedContext] : []),
      ...(shownTurns.length > 0
        ? [
            `${RECALLED_TURNS_HEADER}\n${shownTurns.map((turn) => turnLines(turn, timeZone)).join('\n\n')}`,
          ]
        : []),
      ...(recalledItems.length > 0
        ? [
            `${RECALLED_ITEMS_HEADER}\n${recalledItems.map((item) => itemLine(item, timeZone)).join('\n')}`,
          ]
        : []),
    ];
    const memoryContext = formatTurnContext(turnBlocks);
    if (memoryContext) messages.push({ role: 'user', content: memoryContext });

    const droppedIds = (partition: ContextPartition) =>
      new Set(
        assembly.dropped
          .filter((block) => block.partition === partition)
          .flatMap((block) => (block.sourceId === undefined ? [] : [block.sourceId]))
      );
    const keptEntries = new Set([
      ...historyEntries.map((entry) => entry.id),
      ...shownTurns.flat().map((entry) => entry.id),
    ]);
    const droppedEntries = new Set(
      [...droppedIds('summaries'), ...droppedIds('recent')].filter((id) => !keptEntries.has(id))
    );
    const droppedFacts = droppedIds('facts');
    const droppedSemantic = droppedIds('recall');
    const dropped: DroppedContext = {
      entries: parts.entries.filter((entry) => droppedEntries.has(entry.id)),
      facts: parts.facts.filter((fact) => droppedFacts.has(fact.id)),
      semanticResults: parts.semantic.filter((result) => droppedSemantic.has(result.id)),
      graphNodes: parts.graphOutcome.droppedNodes,
      tokenCount: assembly.dropped.reduce((sum, block) => sum + block.tokens, 0),
      blocks: assembly.dropped,
    };

    return {
      messages,
      ...(memoryContext && { memoryContext }),
      partitions: assembly.tokens,
      facts,
      semanticResults,
      ...((shownTurns.length > 0 || recalledItems.length > 0) && {
        recalled: { entries: shownTurns.flat(), items: recalledItems },
      }),
      graphContext,
      tokenCount: assembly.used - (assembly.tokens.final ?? 0),
      truncated: dropped.entries.length > 0,
      dropped,
      ...(parts.errors.length > 0 && { errors: parts.errors }),
      ...(parts.warnings.length > 0 && { warnings: parts.warnings }),
      metadata: {
        originalMessageCount: parts.entries.length,
        includedMessageCount: history.length,
        factsIncluded: facts.length,
        semanticResultsIncluded: semanticResults.length,
        graphNodesIncluded: graphContext?.nodes.length ?? 0,
        graphEdgesIncluded: graphContext?.edges.length ?? 0,
      },
    };
  }

  /** Runs `work`, recording a failure as an error of `source` instead of failing the build. */
  private async attempt<T>(
    source: ContextBuildError['source'],
    errors: ContextBuildError[],
    work: () => Promise<T>
  ): Promise<T | undefined> {
    try {
      return await work();
    } catch (err) {
      errors.push({ source, error: err instanceof Error ? err : new Error(String(err)) });
      return undefined;
    }
  }

  /**
   * The observations of the entities the input names, then of those whose items were recalled,
   * at most {@link MAX_OBSERVATIONS}
   */
  private async loadObservations(
    options: BuildContextOptions,
    recalled: readonly AssemblyBlock<Piece>[]
  ): Promise<MemoryObservation[]> {
    const reader = this.deps.observations;
    const input = options.currentInput;
    if (!reader || !input) return [];
    const all = await reader.read({
      agentId: options.memoryAgentId ?? options.agentId,
      ...(options.userId !== undefined && { userId: options.userId }),
      threadId: options.threadId,
    });
    if (all.length === 0) return [];
    const recalledEntities = new Set(
      recalled.flatMap((block) =>
        block.value.kind === 'recalled' && block.value.item.entityId !== undefined
          ? [block.value.item.entityId]
          : []
      )
    );
    const named = all.filter((observation) =>
      [observation.name, ...observation.aliases].some((name) => namedIn(input, name))
    );
    const related = all.filter((observation) => recalledEntities.has(observation.entityId));
    return [...new Set([...named, ...related])].slice(0, MAX_OBSERVATIONS);
  }

  /** Facts of the agent visible to the user */
  private async loadFacts(options: BuildContextOptions): Promise<Fact[]> {
    if (this.deps.memoryItems) return loadItemFacts(this.deps.memoryItems, options);
    if (!this.deps.factAdapter) return [];
    const all = unwrap(await this.deps.factAdapter.getFacts(options.agentId), 'getFacts');
    return all.filter((fact) => isVisibleTo(fact.metadata, options.agentId, options.userId));
  }

  /** The facts and documents closest to the current input that the user may see, best first */
  private async loadSemanticResults(
    options: BuildContextOptions
  ): Promise<(Embedding & { score: number })[]> {
    const { embeddingAdapter, embeddingService } = this.deps;
    if (!embeddingAdapter || !embeddingService || !options.currentInput) return [];

    const vector = await embeddingService.embed(options.currentInput);
    const found = unwrap(
      await embeddingAdapter.search({
        vector,
        limit: SEMANTIC_RESULTS * 4,
        threshold: 0.7,
        filter: {
          sourceTypes: SEMANTIC_SOURCES,
          ...(options.userId !== undefined && { userId: options.userId }),
        },
      }),
      'search'
    );
    return found
      .filter(
        (r) =>
          SEMANTIC_SOURCES.includes(r.sourceType) &&
          isVisibleTo(r.metadata, options.agentId, options.userId)
      )
      .slice(0, SEMANTIC_RESULTS);
  }

  /** The knowledge graph context of the current input, whole */
  private async loadGraphContext(options: BuildContextOptions): Promise<GraphContext | undefined> {
    const graph = this.deps.graphContextBuilder;
    if (!graph || !options.currentInput) return undefined;
    const gc = await graph.buildContext(options.agentId, options.currentInput, {
      ...this.config.graphContextOptions,
      userId: options.userId,
    });
    return gc.nodes.length > 0 ? gc : undefined;
  }

  /**
   * The recall partition in `budget`: search results in order while they fit, then the graph
   * context in the room left, cut down to fewer nodes when it is larger. What the cut leaves out
   * goes to `outcome`.
   */
  private async fitRecall(
    blocks: AssemblyBlock<Piece>[],
    budget: number,
    options: BuildContextOptions,
    outcome: { droppedNodes: GraphNode[]; droppedTokens: number; failed?: boolean },
    errors: ContextBuildError[]
  ): Promise<FitResult<Piece>> {
    const results = fitInOrder(
      blocks.filter((block) => block.value.kind !== 'graph'),
      budget
    );
    const used = results.kept.reduce((sum, block) => sum + block.tokens, 0);
    const graphBlock = blocks.find((block) => block.value.kind === 'graph');
    const whole = graphBlock?.value.kind === 'graph' ? graphBlock.value.context : undefined;
    const graph = this.deps.graphContextBuilder;
    if (!whole || !graph || !options.currentInput) return results;
    if (outcome.failed) {
      const left = { value: { kind: 'graph' as const, context: whole }, tokens: whole.tokenCount };
      return { ...results, dropped: [...results.dropped, { block: left, reason: 'budget' }] };
    }
    const room = budget - used;
    if (whole.tokenCount <= room) {
      return {
        ...results,
        kept: [
          ...results.kept,
          { value: { kind: 'graph', context: whole }, tokens: whole.tokenCount },
        ],
      };
    }

    const ratio = Math.max(0, room) / whole.tokenCount;
    const limitedNodes = whole.nodes.slice(0, Math.max(1, Math.floor(whole.nodes.length * ratio)));
    const limitedIds = new Set(limitedNodes.map((n) => n.id));
    const limitedEdges = whole.edges.filter(
      (e) => limitedIds.has(e.sourceNodeId) && limitedIds.has(e.targetNodeId)
    );
    const currentInput = options.currentInput;
    const rebuilt =
      room > 0
        ? await this.attempt('graph', errors, () =>
            graph.buildContext(options.agentId, currentInput, {
              ...this.config.graphContextOptions,
              userId: options.userId,
              maxNodes: limitedNodes.length,
              maxEdges: limitedEdges.length,
            })
          )
        : undefined;
    if (room > 0 && !rebuilt) outcome.failed = true;
    const context = rebuilt && rebuilt.tokenCount <= room ? rebuilt : undefined;
    const keptIds = new Set(context?.nodes.map((n) => n.id));
    outcome.droppedNodes = whole.nodes.filter((n) => !keptIds.has(n.id));
    outcome.droppedTokens = whole.tokenCount - (context?.tokenCount ?? 0);
    return {
      ...results,
      dropped: [
        ...results.dropped,
        {
          block: { value: { kind: 'graph', context: whole }, tokens: outcome.droppedTokens },
          reason: 'budget',
        },
      ],
      kept: context
        ? [...results.kept, { value: { kind: 'graph', context }, tokens: context.tokenCount }]
        : results.kept,
    };
  }

  /**
   * The blocks a search of memory brings for the turn (the `hybrid` strategy): the earlier turns
   * of `history` and the memory items {@link MemoryRetriever} finds, best first, each turn with
   * the turns next to it. The newest turns the context will hold in `recent` anyway (what the
   * budget leaves after the required partitions, `facts` and `recall`) are not searched. Items
   * the `facts` partition keeps are left out when `recall` is fitted.
   */
  private async recall(
    history: MemoryEntry[],
    options: BuildContextOptions,
    availableTokens: number,
    requiredTokens: number,
    facts: readonly Fact[],
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<AssemblyBlock<Piece>[]> {
    const input = options.currentInput;
    if (!input) return [];
    const anchor = options.asOf ?? new Date();
    const timeZone = this.timeZoneOf(options);
    if (!analyzeQuery(input, anchor, timeZone).retrieve) return [];
    const factsDemand = facts.reduce((sum, fact) => sum + countTokens(factLine(fact)), 0);
    const tail = this.assembler.roomOf('recent', availableTokens - requiredTokens, {
      facts: factsDemand,
    });
    const held = new Set(this.selectRecentEntries(history, tail).map((entry) => entry.id));
    const embedding = this.deps.embeddingService;
    const inputVector = embedding?.embed(input);
    inputVector?.catch(() => undefined);
    const scored = embedding
      ? await this.scoreEntries(
          history.filter((entry) => !held.has(entry.id)),
          input,
          0,
          errors,
          scope,
          inputVector
        )
      : null;
    const items = this.deps.memoryItems;
    const memory = this.deps.memoryAdapter;
    const retrieval = await this.retriever.retrieve({
      input,
      anchor,
      timeZone,
      history,
      held,
      ...(scored && { cosines: new Map(scored.map(({ entry, score }) => [entry.id, score])) }),
      ...(items &&
        isMemoryItemAdapter(memory) && {
          items,
          itemAdapter: memory,
          scope: {
            agentId: options.memoryAgentId ?? options.agentId,
            ...(options.userId !== undefined && { userId: options.userId }),
            threadId: options.threadId,
          },
          agentIds: [options.agentId],
          ...(inputVector && {
            itemCosines: (found: readonly MemoryItem[]) =>
              this.itemCosines(found, inputVector, errors),
          }),
        }),
    });
    const hits = this.deps.reranker
      ? await this.reranked(input, retrieval.hits, errors, timeZone)
      : retrieval.hits;
    const position = new Map(history.map((entry, at) => [entry.id, at]));
    const covered = new Set<string>();
    return hits.flatMap((hit): AssemblyBlock<Piece>[] => {
      if (hit.kind === 'item') {
        const line = itemLine(hit.hit.item, timeZone);
        return [{ value: { kind: 'recalled', item: hit.hit.item }, tokens: countTokens(line) }];
      }
      const turn = [hit.hit.entry, ...hit.hit.neighbors]
        .filter((entry) => !covered.has(entry.id))
        .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
      if (turn.length === 0) return [];
      for (const entry of turn) covered.add(entry.id);
      return [
        {
          value: { kind: 'retrieved', entries: turn },
          tokens: recalledTokens(turn, timeZone),
        },
      ];
    });
  }

  /** The thread's time zone when the build names a valid one, else the builder's */
  private timeZoneOf(options: BuildContextOptions): string {
    return options.timeZone !== undefined && isTimeZone(options.timeZone)
      ? options.timeZone
      : this.config.timeZone;
  }

  /**
   * `hits` with the best {@link RERANKED} reordered by the reranker, the rest after them as they
   * were. A reranker that fails leaves them as they were, recorded as a `relevance` error.
   */
  private async reranked(
    input: string,
    hits: Retrieval['hits'],
    errors: ContextBuildError[],
    timeZone: string
  ): Promise<Retrieval['hits']> {
    const reranker = this.deps.reranker;
    if (!reranker || hits.length < 2) return hits;
    const top = hits.slice(0, RERANKED);
    const keyed = new Map(top.map((hit, at) => [String(at), hit]));
    try {
      const order = await reranker.rerank(
        input,
        top.map((hit, at) => ({
          chunkId: String(at),
          documentId: String(at),
          content:
            hit.kind === 'item'
              ? itemLine(hit.hit.item, timeZone)
              : turnLines([hit.hit.entry, ...hit.hit.neighbors], timeZone),
          score: hit.hit.score,
        }))
      );
      const ranked = order.flatMap((result) => {
        const hit = keyed.get(result.chunkId);
        keyed.delete(result.chunkId);
        return hit ? [hit] : [];
      });
      return [...ranked, ...keyed.values(), ...hits.slice(RERANKED)];
    } catch (err) {
      errors.push({
        source: 'relevance',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return hits;
    }
  }

  /**
   * The history a context draws on: the active branch (or the one `leafId` names) of an adapter
   * with branches, else every entry of the thread
   */
  private async readHistory(options: BuildContextOptions): Promise<MemoryEntry[]> {
    const memory = this.deps.memoryAdapter;
    if (options.leafId === null) return [];
    const getPath = memory.getPath?.bind(memory);
    if (getPath) {
      return withoutStaleDurableEntries(
        unwrap(
          await readCompactedHistory(
            { getPath },
            {
              threadId: options.threadId,
              ...(options.leafId !== undefined && { leafId: options.leafId }),
              includeToolCalls: true,
            }
          ),
          'getPath'
        )
      );
    }
    return withoutStaleDurableEntries(
      unwrap(
        await memory.getEntries({ threadId: options.threadId, includeToolCalls: true }),
        'getEntries'
      )
    );
  }

  private selectEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput: string | undefined,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<MemoryEntry[]> | MemoryEntry[] {
    switch (this.config.strategy) {
      case 'relevant':
        return this.selectRelevantEntries(entries, availableTokens, currentInput, errors, scope);
      case 'hybrid':
        return this.selectRecentEntries(entries, availableTokens);
      case 'recent':
      default:
        return this.selectRecentEntries(entries, availableTokens);
    }
  }

  /**
   * The longest run of newest entries that fits the budget. A tool result too large for the room
   * left stays as a short note in its place and the run goes on past it, so one big output does
   * not cut the history off. Any other entry that does not fit ends the run instead of being
   * skipped, so the model never sees a reply without the message it answers.
   */
  private selectRecentEntries(entries: MemoryEntry[], availableTokens: number): MemoryEntry[] {
    const kept: MemoryEntry[] = [];
    let usedTokens = 0;
    for (let at = entries.length - 1; at >= 0; at--) {
      const entry = entries[at]!;
      const tokens = countEntryTokens(entry);
      if (usedTokens + tokens <= availableTokens) {
        kept.unshift(entry);
        usedTokens += tokens;
        continue;
      }
      if (entry.message.role !== 'tool') break;
      const note = withoutOutput(entry);
      const noteTokens = countEntryTokens(note);
      if (usedTokens + noteTokens > availableTokens) break;
      kept.unshift(note);
      usedTokens += noteTokens;
    }
    return kept;
  }

  /**
   * Entries most similar to the current input that fit the budget, in conversation order.
   * Falls back to the most recent entries when there is no input or embedding service, or when
   * scoring fails.
   */
  private async selectRelevantEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput: string | undefined,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<MemoryEntry[]> {
    if (!currentInput || !this.deps.embeddingService) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const scored = await this.scoreEntries(entries, currentInput, 0, errors, scope);
    if (scored === null) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const selectedIds = new Set<string>();
    let usedTokens = 0;
    for (const { entry } of scored) {
      const tokens = countEntryTokens(entry);
      if (usedTokens + tokens <= availableTokens) {
        selectedIds.add(entry.id);
        usedTokens += tokens;
      }
    }

    return entries.filter((e) => selectedIds.has(e.id));
  }

  /**
   * Similarity of user/assistant text entries to the input, best first. The newest
   * {@link MAX_SCORED_ENTRIES} are scored against their vectors, each embedded once: kept in the
   * `messageIndex` when there is one, else by entry id in process. With a `messageIndex`, older
   * entries the store finds close to the input are scored too. When the index fails, the newest
   * entries are scored with vectors kept in process and the failure is recorded as a `relevance`
   * error. Returns null, recording one, when embedding fails.
   */
  private async scoreEntries(
    entries: MemoryEntry[],
    input: string,
    minScore: number,
    errors: ContextBuildError[],
    scope: ScoringScope,
    inputVector?: Promise<number[]>
  ): Promise<{ entry: MemoryEntry; score: number }[] | null> {
    const embeddingService = this.deps.embeddingService;
    if (!embeddingService) return null;

    const embeddable: { entry: MemoryEntry; text: IndexedText }[] = [];
    for (const entry of entries) {
      const text = indexedText(entry);
      if (text) embeddable.push({ entry, text });
    }
    const candidates = embeddable.slice(-MAX_SCORED_ENTRIES);
    if (candidates.length === 0) return [];
    const older = embeddable.slice(0, embeddable.length - candidates.length);
    const index = this.deps.messageIndex;
    const threadId = candidates[0]!.entry.threadId;
    if (index && older.length > 0) {
      index.backfill(
        threadId,
        older.map(({ text }) => text),
        scope.mark
      );
    }

    try {
      const texts = candidates.map(({ text }) => text);
      const windowVectors = async (): Promise<{
        vectors: Map<string, Float32Array>;
        indexed: boolean;
      }> => {
        if (!index) return { vectors: await this.processVectors(texts), indexed: false };
        try {
          return { vectors: await index.vectorsOf(texts, scope.mark), indexed: true };
        } catch (err) {
          errors.push({
            source: 'relevance',
            error: err instanceof Error ? err : new Error(String(err)),
          });
          return { vectors: await this.processVectors(texts), indexed: false };
        }
      };
      const [queryVector, { vectors, indexed }] = await Promise.all([
        inputVector ?? embeddingService.embed(input),
        windowVectors(),
      ]);
      index?.offer(input, queryVector);

      const scored: { entry: MemoryEntry; score: number }[] = [];
      for (const { entry } of candidates) {
        const vector = vectors.get(entry.id);
        if (!vector) continue;
        const score = this.cosineSimilarity(queryVector, vector);
        if (score > minScore) scored.push({ entry, score });
      }

      if (index && indexed && older.length > 0) {
        try {
          const found = await index.search(
            threadId,
            queryVector,
            INDEX_SEARCH_RESULTS + Math.max(0, scope.threadSize - older.length),
            minScore
          );
          for (const { entry } of older) {
            const score = found.get(entry.id);
            if (score !== undefined && score > minScore) scored.push({ entry, score });
          }
        } catch (err) {
          errors.push({
            source: 'relevance',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      return scored.sort((a, b) => b.score - a.score);
    } catch (err) {
      errors.push({
        source: 'relevance',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }

  /** Vectors of `texts` by entry id from the builder's own cache, embedding the ones it lacks */
  /**
   * How close each of `items` is to the input, by the cosine of their embeddings, each item
   * embedded once and kept. A failure is recorded as a `relevance` error and finds nothing.
   */
  private async itemCosines(
    items: readonly MemoryItem[],
    inputVector: Promise<number[]>,
    errors: ContextBuildError[]
  ): Promise<Map<string, number>> {
    const embedding = this.deps.embeddingService;
    if (!embedding) return new Map();
    try {
      const keyOf = (item: MemoryItem) => `${embedding.model}:${item.id}`;
      const missing = items.filter((item) => !this.itemVectors.has(keyOf(item)));
      for (let start = 0; start < missing.length; start += ITEM_EMBED_BATCH) {
        const batch = missing.slice(start, start + ITEM_EMBED_BATCH);
        const made = await embedding.embedBatch(batch.map((item) => item.content));
        batch.forEach((item, at) => {
          const vector = made[at];
          if (vector) this.itemVectors.set(keyOf(item), Float32Array.from(vector));
        });
      }
      const query = await inputVector;
      const cosines = new Map<string, number>();
      for (const item of items) {
        const key = keyOf(item);
        const vector = this.itemVectors.get(key);
        if (!vector) continue;
        this.itemVectors.delete(key);
        this.itemVectors.set(key, vector);
        cosines.set(item.id, this.cosineSimilarity(query, vector));
      }
      while (this.itemVectors.size > ITEM_VECTORS_KEPT) {
        const oldest = this.itemVectors.keys().next().value;
        if (oldest === undefined) break;
        this.itemVectors.delete(oldest);
      }
      return cosines;
    } catch (err) {
      errors.push({
        source: 'relevance',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return new Map();
    }
  }

  private async processVectors(texts: IndexedText[]): Promise<Map<string, Float32Array>> {
    const embeddingService = this.deps.embeddingService;
    const missing = texts.filter(({ entryId }) => !this.entryVectors.has(entryId));
    if (embeddingService && missing.length > 0) {
      const vectors = await embeddingService.embedBatch(missing.map(({ text }) => text));
      if (vectors.length !== missing.length) {
        throw new Error(
          `Embedding returned ${vectors.length} vectors for ${missing.length} history entries`
        );
      }
      missing.forEach(({ entryId }, i) => this.rememberVector(entryId, vectors[i]));
    }
    const found = new Map<string, Float32Array>();
    for (const { entryId } of texts) {
      const vector = this.recallVector(entryId);
      if (vector) found.set(entryId, vector);
    }
    return found;
  }

  private rememberVector(entryId: string, vector: number[]): void {
    this.entryVectors.delete(entryId);
    this.entryVectors.set(entryId, Float32Array.from(vector));
    if (this.entryVectors.size > ENTRY_VECTOR_CACHE_SIZE) {
      const oldest = this.entryVectors.keys().next().value;
      if (oldest !== undefined) this.entryVectors.delete(oldest);
    }
  }

  private recallVector(entryId: string): Float32Array | undefined {
    const vector = this.entryVectors.get(entryId);
    if (vector) {
      this.entryVectors.delete(entryId);
      this.entryVectors.set(entryId, vector);
    }
    return vector;
  }

  private cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}
