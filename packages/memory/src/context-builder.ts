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
  ContextBuildError,
  BuiltContext,
  DroppedContext,
  GraphNode,
  MemoryAdapter,
  FactAdapter,
  EmbeddingAdapter,
  EmbeddingService,
  MemoryResult,
} from '@cogitator-ai/types';
import type { GraphContextBuilder } from './knowledge-graph/graph-context-builder';
import { readCompactedHistory } from './compaction';
import {
  ContextAssembler,
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

/**
 * The part of a context that changes every turn, as one text sent with the input: `blocks` under
 * a header that tells the model where they come from, none when there are no blocks
 */
export function formatTurnContext(blocks: readonly string[]): string | undefined {
  const present = blocks.filter((block) => block.trim());
  return present.length > 0 ? [TURN_CONTEXT_HEADER, ...present].join('\n\n') : undefined;
}

/** What a block of a context holds */
type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'input' }
  | { kind: 'entry'; entry: MemoryEntry }
  | { kind: 'fact'; fact: Fact }
  | { kind: 'semantic'; result: Embedding & { score: number } }
  | { kind: 'graph'; context: GraphContext };

function textBlock(text: string, tokens = countTokens(text)): AssemblyBlock<Piece> {
  return { value: { kind: 'text', text }, tokens, text };
}

function entryBlock(entry: MemoryEntry): AssemblyBlock<Piece> {
  return { value: { kind: 'entry', entry }, tokens: countEntryTokens(entry), sourceId: entry.id };
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
  return {
    ...entry,
    message: {
      ...entry.message,
      content: `[The output of this tool call, about ${tokens} tokens, was left out of the context to make room]`,
    },
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
  embeddingAdapter?: EmbeddingAdapter;
  embeddingService?: EmbeddingService;
  graphContextBuilder?: GraphContextBuilder;
  /**
   * Vectors of history entries kept in an embedding store. With it `relevant` and `hybrid`
   * embed only the input and the entries not indexed yet, and find older entries of the thread
   * by a search of the store. Without it the builder keeps vectors in process.
   */
  messageIndex?: MessageIndex;
}

export interface BuildContextOptions {
  threadId: string;
  agentId: string;
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
}

type ResolvedConfig = Required<Omit<ContextBuilderConfig, 'maxTokens' | 'reserveTokens'>> &
  Pick<ContextBuilderConfig, 'maxTokens' | 'reserveTokens'>;

/** What scoring knows of the build: the index mark taken before the read, and the thread size */
interface ScoringScope {
  mark?: number;
  threadSize: number;
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
  private readonly assembler: ContextAssembler;

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
      partitions: config.partitions ?? {},
    };
    this.assembler = new ContextAssembler(config.partitions);
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
    if (facts.length > 0) {
      candidates.push({
        partition: 'facts',
        blocks: facts.map((fact) => ({
          value: { kind: 'fact', fact },
          tokens: countTokens(`- ${fact.content}`),
          text: fact.content,
          sourceId: fact.id,
        })),
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
    const graphOutcome: { droppedNodes: GraphNode[]; droppedTokens: number } = {
      droppedNodes: [],
      droppedTokens: 0,
    };
    if (semantic.length > 0 || graph) {
      candidates.push({
        partition: 'recall',
        blocks: [
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
        fit: (blocks, budget) => this.fitRecall(blocks, budget, options, graphOutcome),
      });
    }

    const scope: ScoringScope = { mark: this.deps.messageIndex?.mark(), threadSize: 0 };
    const entries = (await this.attempt('history', errors, () => this.readHistory(options))) ?? [];
    scope.threadSize = entries.length;
    const summaries = entries.filter((entry) => entry.type === 'compaction');
    const history = entries.filter((entry) => entry.type !== 'compaction');
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
      graphOutcome: { droppedNodes: GraphNode[]; droppedTokens: number };
      errors: ContextBuildError[];
      warnings: string[];
    }
  ): BuiltContext {
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
    const history = historyEntries.map((entry) => entry.message);
    const last = history.at(-1);
    if (last) history[history.length - 1] = { ...last, cacheBreakpoint: true };
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
    const turnBlocks = [
      ...textsOf('brief'),
      ...(facts.length > 0
        ? [`Known facts:\n${facts.map((f) => `- ${f.content}`).join('\n')}`]
        : []),
      ...(semanticResults.length > 0
        ? [`Relevant context:\n${semanticResults.map((r) => `- ${r.content}`).join('\n')}`]
        : []),
      ...(graphContext?.formattedContext ? [graphContext.formattedContext] : []),
    ];
    const memoryContext = formatTurnContext(turnBlocks);
    if (memoryContext) messages.push({ role: 'user', content: memoryContext });

    const droppedIds = (partition: ContextPartition) =>
      new Set(
        assembly.dropped
          .filter((block) => block.partition === partition)
          .flatMap((block) => (block.sourceId === undefined ? [] : [block.sourceId]))
      );
    const droppedEntries = new Set([...droppedIds('summaries'), ...droppedIds('recent')]);
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

  /** Facts of the agent visible to the user */
  private async loadFacts(options: BuildContextOptions): Promise<Fact[]> {
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
    outcome: { droppedNodes: GraphNode[]; droppedTokens: number }
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
    const rebuilt =
      room > 0
        ? await graph.buildContext(options.agentId, options.currentInput, {
            ...this.config.graphContextOptions,
            userId: options.userId,
            maxNodes: limitedNodes.length,
            maxEdges: limitedEdges.length,
          })
        : undefined;
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
   * The history a context draws on: the active branch (or the one `leafId` names) of an adapter
   * with branches, else every entry of the thread
   */
  private async readHistory(options: BuildContextOptions): Promise<MemoryEntry[]> {
    const memory = this.deps.memoryAdapter;
    if (options.leafId === null) return [];
    const getPath = memory.getPath?.bind(memory);
    if (getPath) {
      return unwrap(
        await readCompactedHistory(
          { getPath },
          {
            threadId: options.threadId,
            ...(options.leafId !== undefined && { leafId: options.leafId }),
            includeToolCalls: true,
          }
        ),
        'getPath'
      );
    }
    return unwrap(
      await memory.getEntries({ threadId: options.threadId, includeToolCalls: true }),
      'getEntries'
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
        return this.selectHybridEntries(entries, availableTokens, currentInput, errors, scope);
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
    scope: ScoringScope
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
      const [inputVector, { vectors, indexed }] = await Promise.all([
        embeddingService.embed(input),
        windowVectors(),
      ]);
      index?.offer(input, inputVector);

      const scored: { entry: MemoryEntry; score: number }[] = [];
      for (const { entry } of candidates) {
        const vector = vectors.get(entry.id);
        if (!vector) continue;
        const score = this.cosineSimilarity(inputVector, vector);
        if (score > minScore) scored.push({ entry, score });
      }

      if (index && indexed && older.length > 0) {
        try {
          const found = await index.search(
            threadId,
            inputVector,
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

  private async selectHybridEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput: string | undefined,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<MemoryEntry[]> {
    if (!currentInput || !this.deps.embeddingService || entries.length <= 10) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const semanticBudget = Math.floor(availableTokens * 0.3);
    const usedIds = new Set<string>();
    let usedTokens = 0;

    const olderEntries = entries
      .slice(0, -10)
      .filter((e) => typeof e.message.content !== 'string' || e.message.content.length > 20);
    const scoredEntries =
      (await this.scoreEntries(olderEntries, currentInput, 0.6, errors, scope)) ?? [];

    for (const { entry } of scoredEntries) {
      const tokens = countEntryTokens(entry);
      if (usedTokens + tokens <= semanticBudget) {
        usedIds.add(entry.id);
        usedTokens += tokens;
      }
    }

    const recentEntries = new Map(
      this.selectRecentEntries(
        entries.filter((e) => !usedIds.has(e.id)),
        availableTokens - usedTokens
      ).map((entry) => [entry.id, entry])
    );

    return entries.flatMap((entry) => {
      const recent = recentEntries.get(entry.id);
      if (recent) return [recent];
      return usedIds.has(entry.id) ? [entry] : [];
    });
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
